import Mime from "@effect/platform-node/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  ScaffoldLifecycleError,
  SessionFabricSessionId,
  TrimmedNonEmptyString,
  ScaffoldPrepareConnectionInput,
  ScaffoldRetentionCaptureInput,
  ScaffoldRetentionCloneImportInput,
  ScaffoldSessionTransferStartInput,
  ScaffoldWorkspaceMigrationImportInput,
} from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { cast } from "effect/Function";
import {
  Headers,
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { OtlpTracer } from "effect/unstable/observability";

import * as ServerConfig from "./config.ts";
import { ASSET_ROUTE_PREFIX, resolveAsset } from "./assets/AssetAccess.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as HttpResponseCompression from "./httpCompression/HttpResponseCompression.ts";
import { traceRelayRequest } from "./cloud/traceRelayRequest.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";
import { makeScaffoldLifecycleService } from "./scaffold/ScaffoldLifecycleService.ts";
import type { makeWorkspaceMigrationImportService } from "./sessionTransfer/WorkspaceMigrationImportService.ts";
import type { ScaffoldRetentionCapturePort } from "./sessionTransfer/ScaffoldRetentionCapture.ts";
import type { ScaffoldSessionTransferSourcePort } from "./sessionTransfer/ScaffoldSessionTransferSource.ts";
import * as Schema from "effect/Schema";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"];
const GZIP_MIN_BYTES = 1024;

function acceptsGzip(value: string | undefined): boolean {
  if (!value) return false;

  const accepted = new Map(
    value.split(",").map((entry) => {
      const [coding = "", ...parameters] = entry.trim().toLowerCase().split(";");
      const quality = parameters
        .map((parameter) => parameter.trim().match(/^q=(.+)$/)?.[1])
        .find((parameter) => parameter !== undefined);
      return [coding, quality === undefined ? 1 : Number(quality)] as const;
    }),
  );
  return (accepted.get("gzip") ?? accepted.get("*") ?? 0) > 0;
}

function varyByAcceptEncoding(value: string | undefined): string {
  if (!value) return "Accept-Encoding";
  const values = new Set(value.split(",").map((entry) => entry.trim().toLowerCase()));
  return values.has("*") || values.has("accept-encoding") ? value : `${value}, Accept-Encoding`;
}

const compressHttpResponse = Effect.fnUntraced(function* (
  response: HttpServerResponse.HttpServerResponse,
  acceptEncoding: string | undefined,
) {
  const body = response.body;
  if (
    body._tag !== "Uint8Array" ||
    body.contentLength < GZIP_MIN_BYTES ||
    !body.contentType.startsWith("application/json") ||
    response.headers["content-encoding"]
  ) {
    return response;
  }

  const variedResponse = HttpServerResponse.setHeader(
    response,
    "vary",
    varyByAcceptEncoding(response.headers.vary),
  );
  if (!acceptsGzip(acceptEncoding)) return variedResponse;

  const compression = yield* HttpResponseCompression.HttpResponseCompression;
  const headers = Headers.set(
    Headers.remove(variedResponse.headers, "content-length"),
    "content-encoding",
    "gzip",
  );
  return compression.gzip(body.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    cookies: response.cookies,
    contentType: body.contentType,
  });
});

export const httpCompressionLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(
      Effect.all([httpEffect, HttpServerRequest.HttpServerRequest]),
      ([response, request]) => compressHttpResponse(response, request.headers["accept-encoding"]),
    ),
  { global: true },
);

const scaffoldLifecycle = makeScaffoldLifecycleService();
const isScaffoldLifecycleError = Schema.is(ScaffoldLifecycleError);
const decodeScaffoldPrepareConnectionInput = Schema.decodeUnknownEffect(
  ScaffoldPrepareConnectionInput,
);
const decodeScaffoldRetentionCaptureInput = Schema.decodeUnknownEffect(
  ScaffoldRetentionCaptureInput,
);
const decodeScaffoldWorkspaceMigrationImportInput = Schema.decodeUnknownEffect(
  Schema.Union([ScaffoldWorkspaceMigrationImportInput, ScaffoldRetentionCloneImportInput]),
);
const decodeScaffoldSessionTransferStartInput = Schema.decodeUnknownEffect(
  ScaffoldSessionTransferStartInput,
);
const SessionFabricCapabilityProxyRequest = Schema.Struct({
  deployment: Schema.optional(Schema.Literals(["staging", "production"])),
  role: Schema.Literals(["viewer", "controller"]),
  fabricSessionId: Schema.optional(SessionFabricSessionId),
  scaffoldSessionId: Schema.optional(TrimmedNonEmptyString),
  scaffoldLifecycleEpoch: Schema.optional(Schema.Number),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const decodeSessionFabricCapabilityProxyRequest = Schema.decodeUnknownEffect(
  SessionFabricCapabilityProxyRequest,
);

export function decodeSessionFabricCapabilityProxyBody(value: unknown) {
  return Schema.decodeUnknownSync(SessionFabricCapabilityProxyRequest)(value);
}

export function scaffoldRuntimeTokenMatches(
  receivedToken: string | undefined,
  expectedToken: string,
): boolean {
  let matches = receivedToken !== undefined && receivedToken.length === expectedToken.length;
  if (receivedToken !== undefined) {
    for (let index = 0; index < Math.max(receivedToken.length, expectedToken.length); index += 1) {
      matches = matches && receivedToken.charCodeAt(index) === expectedToken.charCodeAt(index);
    }
  }
  return expectedToken.length > 0 && matches;
}

export const browserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Dev uses credentialed requests from Vite or the Electron custom origin, so both must be
    // explicit. Packaged desktop omits credentials and uses Effect's default wildcard origin.
    //
    // T3CODE_DEV_ALLOWED_ORIGINS covers dev servers reached from a second
    // origin — a tailnet name, a LAN IP, a phone. Browser dev normally proxies
    // through Vite and is same-origin (no preflight at all), so this is a
    // safety net for the desktop renderer and any direct-to-backend caller.
    return HttpRouter.cors({
      ...(devOrigin
        ? {
            allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS, ...config.devAllowedOrigins],
            credentials: true,
          }
        : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

export function sessionFabricCapabilityProxyScope(role: "viewer" | "controller") {
  return role === "viewer" ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope;
}

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }, traceRelayRequest),
    );
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Trace export failed.", { status: 502 }),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/**
 * Local lifecycle-only coordinator seam. The response contains one short-lived
 * bootstrap credential; subsequent descriptor, token, HTTP, and websocket
 * traffic goes directly from the browser to the sandbox.
 */
export const scaffoldPrepareConnectionRouteLayer = HttpRouter.add(
  "POST",
  "/api/scaffold/connection",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const input = yield* decodeScaffoldPrepareConnectionInput(yield* request.json).pipe(
      Effect.option,
    );
    if (Option.isNone(input)) {
      return HttpServerResponse.jsonUnsafe({ error: "scaffold_invalid_request" }, { status: 400 });
    }
    return yield* Effect.tryPromise(() => scaffoldLifecycle.prepare(input.value)).pipe(
      Effect.map((prepared) =>
        HttpServerResponse.jsonUnsafe(prepared, {
          status: 200,
          headers: { "cache-control": "no-store" },
        }),
      ),
      Effect.catch((error) => {
        const lifecycleError = isScaffoldLifecycleError(error)
          ? error
          : new ScaffoldLifecycleError({
              reason: "unavailable",
              message: "Scaffold lifecycle request failed.",
              status: 503,
              code: "scaffold_unexpected_error",
            });
        const status = lifecycleError.status >= 400 ? lifecycleError.status : 503;
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe(lifecycleError, {
            status,
            headers: { "cache-control": "no-store" },
          }),
        );
      }),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/**
 * Local browsers obtain short-lived relay capabilities through T3 so Scaffold
 * OAuth/IAP credentials never cross into browser storage. Mounted Scaffold
 * routes intercept the same path and apply the authenticated web actor there.
 */
export const scaffoldSessionFabricCapabilityRouteLayer = HttpRouter.add(
  "POST",
  "/api/session-fabric/capabilities",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const decoded = yield* decodeSessionFabricCapabilityProxyRequest(yield* request.json).pipe(
      Effect.option,
    );
    if (Option.isNone(decoded)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "session_fabric_capability_invalid_request" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    const input = decoded.value;
    if (
      (input.role === "viewer" &&
        (input.fabricSessionId !== undefined ||
          input.scaffoldSessionId !== undefined ||
          input.scaffoldLifecycleEpoch !== undefined)) ||
      (input.role === "controller" &&
        (input.fabricSessionId === undefined ||
          input.scaffoldSessionId === undefined ||
          input.scaffoldLifecycleEpoch === undefined ||
          !Number.isSafeInteger(input.scaffoldLifecycleEpoch) ||
          input.scaffoldLifecycleEpoch < 0))
    ) {
      return HttpServerResponse.jsonUnsafe(
        { error: "session_fabric_capability_invalid_request" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    yield* authenticateRawRouteWithScope(sessionFabricCapabilityProxyScope(input.role));
    const capability =
      input.role === "viewer"
        ? ({ role: "viewer" } as const)
        : ({
            role: "controller",
            fabricSessionId: input.fabricSessionId!,
            scaffoldSessionId: input.scaffoldSessionId!,
            scaffoldLifecycleEpoch: input.scaffoldLifecycleEpoch!,
          } as const);
    return yield* Effect.tryPromise(() =>
      scaffoldLifecycle.issueSessionFabricCapability({
        ...(input.deployment === undefined ? {} : { deployment: input.deployment }),
        capability,
      }),
    ).pipe(
      Effect.map((grant) =>
        HttpServerResponse.jsonUnsafe(grant, {
          status: 200,
          headers: { "cache-control": "no-store" },
        }),
      ),
      Effect.catch((error) => {
        const lifecycleError = isScaffoldLifecycleError(error)
          ? error
          : new ScaffoldLifecycleError({
              reason: "unavailable",
              message: "Scaffold capability request failed.",
              status: 503,
              code: "scaffold_session_fabric_capability_failed",
            });
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: lifecycleError.code },
            {
              status: lifecycleError.status >= 400 ? lifecycleError.status : 503,
              headers: { "cache-control": "no-store" },
            },
          ),
        );
      }),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/**
 * Destination-only import endpoint. The sandbox supervisor authenticates with
 * its process-local migration token. The response deliberately excludes
 * bootstrap/attach credentials and archive bytes.
 */
export const makeScaffoldWorkspaceMigrationImportRouteLayer = (
  service: ReturnType<typeof makeWorkspaceMigrationImportService>,
  expectedToken: string,
) =>
  HttpRouter.add(
    "POST",
    "/internal/scaffold/migrations/import",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const receivedToken = request.headers["x-scaffold-migration-token"];
      if (!scaffoldRuntimeTokenMatches(receivedToken, expectedToken)) {
        return HttpServerResponse.jsonUnsafe(
          { error: "workspace_migration_unauthorized" },
          { status: 401, headers: { "cache-control": "no-store" } },
        );
      }
      const input = yield* decodeScaffoldWorkspaceMigrationImportInput(yield* request.json).pipe(
        Effect.option,
      );
      if (Option.isNone(input)) {
        return HttpServerResponse.jsonUnsafe(
          { error: "workspace_migration_invalid_request" },
          { status: 400 },
        );
      }
      return yield* Effect.tryPromise(() =>
        input.value.version === "scaffold.t3_workspace_migration.import.v3"
          ? service.importRetentionClone(input.value)
          : service.importSession(input.value),
      ).pipe(
        Effect.map((result) =>
          HttpServerResponse.jsonUnsafe(result, {
            status: 200,
            headers: { "cache-control": "no-store" },
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              {
                error:
                  typeof error === "object" && error !== null && "code" in error
                    ? error.code
                    : "workspace_migration_import_failed",
              },
              { status: 409, headers: { "cache-control": "no-store" } },
            ),
          ),
        ),
      );
    }),
  );

export const makeScaffoldRetentionCaptureRouteLayer = (
  service: ScaffoldRetentionCapturePort,
  expectedToken: string,
) =>
  HttpRouter.add(
    "POST",
    "/internal/scaffold/retention/capture",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        !scaffoldRuntimeTokenMatches(request.headers["x-scaffold-runtime-api-token"], expectedToken)
      ) {
        return HttpServerResponse.jsonUnsafe(
          { error: "scaffold_retention_unauthorized" },
          { status: 401, headers: { "cache-control": "no-store" } },
        );
      }
      const input = yield* decodeScaffoldRetentionCaptureInput(yield* request.json).pipe(
        Effect.option,
      );
      if (Option.isNone(input)) {
        return HttpServerResponse.jsonUnsafe(
          { error: "scaffold_retention_invalid_request" },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }
      return yield* Effect.tryPromise(() => service.capture(input.value)).pipe(
        Effect.map((result) =>
          HttpServerResponse.jsonUnsafe(result, {
            status: 200,
            headers: { "cache-control": "no-store" },
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              {
                error:
                  typeof error === "object" && error !== null && "code" in error
                    ? error.code
                    : "scaffold_retention_capture_failed",
              },
              { status: 409, headers: { "cache-control": "no-store" } },
            ),
          ),
        ),
      );
    }),
  );

/** Authenticated local source operation. Archive bytes remain in temp files and subprocess pipes. */
export const makeScaffoldSessionTransferRouteLayer = (
  service: ScaffoldSessionTransferSourcePort,
) => {
  const route = (
    path:
      | "/api/scaffold/session-transfer"
      | "/api/scaffold/session-transfer/reconcile"
      | "/api/scaffold/session-transfer/abort",
    action: "start" | "reconcile" | "abort",
  ) =>
    HttpRouter.add(
      "POST",
      path,
      Effect.gen(function* () {
        yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* decodeScaffoldSessionTransferStartInput(yield* request.json).pipe(
          Effect.option,
        );
        if (Option.isNone(input)) {
          return HttpServerResponse.jsonUnsafe(
            { error: "workspace_migration_invalid_request" },
            { status: 400 },
          );
        }
        return yield* service[action](input.value).pipe(
          Effect.map((result) =>
            HttpServerResponse.jsonUnsafe(result ?? { ok: true }, {
              status: 200,
              headers: { "cache-control": "no-store" },
            }),
          ),
          Effect.catch((error) =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                {
                  error:
                    typeof error === "object" && error !== null && "code" in error
                      ? error.code
                      : "workspace_migration_failed",
                },
                { status: 409, headers: { "cache-control": "no-store" } },
              ),
            ),
          ),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );

  return Layer.mergeAll(
    route("/api/scaffold/session-transfer", "start"),
    route("/api/scaffold/session-transfer/reconcile", "reconcile"),
    route("/api/scaffold/session-transfer/abort", "abort"),
  );
};

export const assetRouteLayer = HttpRouter.add(
  "GET",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const asset = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* HttpServerResponse.file(asset.path, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isDevProxiedPath(url.value.pathname)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
