import {
  SessionFabricContextRequest,
  SessionFabricSearchRequest,
} from "@t3tools/contracts/session-fabric";
import type { SessionFabricCapabilityClaims } from "@t3tools/contracts/session-fabric";
import {
  authorizeSessionFabricCapability,
  capabilityCanListDirectory,
  capabilityCanReadSession,
  isLoopbackSessionFabricRequestUrl,
  makeSessionFabricCapabilityVerifierConfig,
} from "@t3tools/shared/sessionFabricCapability";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import SessionDirectory from "../../relay/src/sessionFabric/SessionDirectory.ts";
import SessionStreamCoordinator from "../../relay/src/sessionFabric/SessionStreamCoordinator.ts";
import { resolveSessionFabricRoute } from "./route.ts";

const parseAllowedOrigins = (value: string | undefined): ReadonlySet<string> =>
  new Set(
    (value ?? "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/gu, ""))
      .filter((origin) => origin.length > 0),
  );

export default class SessionFabricApi extends Cloudflare.Worker<SessionFabricApi>()(
  "SessionFabricApi",
  {
    name: "ashler-session-fabric-proof",
    main: import.meta.filename,
    compatibility: {
      date: "2026-05-22",
      flags: ["nodejs_compat"],
    },
    dev: {
      host: "127.0.0.1",
      port: 8788,
      strictPort: true,
    },
    observability: { enabled: true },
  },
  Effect.gen(function* () {
    const sessionStreams = yield* SessionStreamCoordinator;
    const sessionDirectory = yield* SessionDirectory;
    const authMode = yield* Config.string("SESSION_FABRIC_AUTH_MODE").pipe(Config.option);
    const authIssuer = yield* Config.string("SESSION_FABRIC_CAPABILITY_ISSUER").pipe(Config.option);
    const authAudience = yield* Config.string("SESSION_FABRIC_CAPABILITY_AUDIENCE").pipe(
      Config.option,
    );
    const authPublicKeys = yield* Config.string("SESSION_FABRIC_CAPABILITY_PUBLIC_KEYS_JSON").pipe(
      Config.option,
    );
    const allowedOrigins = parseAllowedOrigins(
      Option.getOrUndefined(
        yield* Config.string("SESSION_FABRIC_ALLOWED_ORIGINS").pipe(Config.option),
      ),
    );
    const verifierConfig = makeSessionFabricCapabilityVerifierConfig({
      mode: Option.getOrUndefined(authMode),
      issuer: Option.getOrUndefined(authIssuer),
      audience: Option.getOrUndefined(authAudience),
      publicKeysJson: Option.getOrUndefined(authPublicKeys),
    });

    const authorize = Effect.fn("session_fabric_api.authorize")(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      return yield* authorizeSessionFabricCapability({
        config: verifierConfig,
        authorization: request.headers.authorization,
        requestUrl: request.url,
        nowEpochSeconds: Math.floor((yield* Clock.currentTimeMillis) / 1_000),
      });
    });

    const corsOrigin = (request: HttpServerRequest.HttpServerRequest): string | null => {
      const origin = request.headers.origin?.replace(/\/+$/gu, "");
      if (origin === undefined) return null;
      if (verifierConfig?.mode === "disabled") {
        if (!isLoopbackSessionFabricRequestUrl(request.url)) return null;
        try {
          const url = new URL(origin);
          return url.hostname === "localhost" || url.hostname === "127.0.0.1" ? origin : null;
        } catch {
          return null;
        }
      }
      return allowedOrigins.has(origin) ? origin : null;
    };

    const withCors = (
      request: HttpServerRequest.HttpServerRequest,
      response: HttpServerResponse.HttpServerResponse,
    ) => {
      const origin = corsOrigin(request);
      return origin === null
        ? response
        : HttpServerResponse.setHeaders(response, {
            "access-control-allow-origin": origin,
            "access-control-expose-headers": "content-type",
            vary: "origin",
          });
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.method === "OPTIONS") {
          const origin = corsOrigin(request);
          return origin === null
            ? HttpServerResponse.empty({ status: 403 })
            : HttpServerResponse.empty({
                status: 204,
                headers: {
                  "access-control-allow-origin": origin,
                  "access-control-allow-methods": "GET,POST,OPTIONS",
                  "access-control-allow-headers": "authorization,content-type",
                  "access-control-max-age": "86400",
                  vary: "origin",
                },
              });
        }

        const capabilityResult = yield* authorize(request).pipe(Effect.result);
        if (capabilityResult._tag === "Failure") {
          return withCors(
            request,
            HttpServerResponse.text("Session fabric authorization required", {
              status: capabilityResult.failure.reason === "unavailable" ? 503 : 401,
            }),
          );
        }
        const capability: SessionFabricCapabilityClaims | null = capabilityResult.success;

        const route = resolveSessionFabricRoute(
          request.method,
          new URL(request.url, "http://session-fabric.local"),
        );
        switch (route.type) {
          case "health":
            return withCors(request, HttpServerResponse.jsonUnsafe({ ok: true }));
          case "directory": {
            if (
              verifierConfig?.mode !== "disabled" &&
              (capability === null || !capabilityCanListDirectory(capability))
            ) {
              return withCors(request, HttpServerResponse.empty({ status: 403 }));
            }
            const sessions = yield* sessionDirectory.getByName("public-session-directory").list();
            return withCors(
              request,
              HttpServerResponse.jsonUnsafe(
                { sessions },
                { headers: { "cache-control": "no-store" } },
              ),
            );
          }
          case "search": {
            if (
              verifierConfig?.mode !== "disabled" &&
              (capability === null || !capabilityCanListDirectory(capability))
            ) {
              return withCors(request, HttpServerResponse.empty({ status: 403 }));
            }
            const decoded = yield* Effect.result(
              HttpServerRequest.schemaBodyJson(SessionFabricSearchRequest),
            );
            if (decoded._tag === "Failure") {
              return withCors(
                request,
                HttpServerResponse.text("Invalid session search request", { status: 400 }),
              );
            }
            const response = yield* sessionDirectory
              .getByName("public-session-directory")
              .search(decoded.success);
            return withCors(
              request,
              HttpServerResponse.jsonUnsafe(response, {
                headers: { "cache-control": "no-store" },
              }),
            );
          }
          case "context": {
            const decoded = yield* Effect.result(
              HttpServerRequest.schemaBodyJson(SessionFabricContextRequest),
            );
            if (decoded._tag === "Failure") {
              return withCors(
                request,
                HttpServerResponse.text("Invalid session context request", { status: 400 }),
              );
            }
            const context = yield* sessionStreams
              .getByName(decoded.success.sessionId)
              .getContext(decoded.success.includeCodeDiff, decoded.success.includeContinuation);
            if (
              context !== null &&
              verifierConfig?.mode !== "disabled" &&
              (capability === null || !capabilityCanReadSession(capability, context.snapshot))
            ) {
              return withCors(request, HttpServerResponse.empty({ status: 404 }));
            }
            return withCors(
              request,
              context === null
                ? HttpServerResponse.empty({ status: 404 })
                : HttpServerResponse.jsonUnsafe(context, {
                    headers: { "cache-control": "no-store" },
                  }),
            );
          }
          case "session": {
            const response = yield* sessionStreams.getByName(route.sessionId).fetch(request);
            // A 101 response owns immutable upgrade headers in workerd. WebSocket
            // clients do not use CORS response headers, so forward the upgrade
            // untouched and decorate only ordinary HTTP reads.
            return request.headers.upgrade?.toLowerCase() === "websocket"
              ? response
              : withCors(request, response);
          }
          case "not-found":
            return withCors(request, HttpServerResponse.empty({ status: 404 }));
        }
      }),
    };
  }),
) {}
