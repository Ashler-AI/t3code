import {
  SESSION_FABRIC_WS_CAPABILITY_PREFIX,
  SESSION_FABRIC_PROTOCOL_VERSION,
  SESSION_FABRIC_WS_PROTOCOL,
  SessionFabricClientFrame,
  SessionFabricContextBundle,
  SessionFabricContextRequest,
  SessionFabricSearchRequest,
  SessionFabricSearchResponse,
  SessionFabricServerFrame,
  type SessionFabricCapabilityGrant,
  type SessionFabricClientId,
  type SessionFabricCommand,
  type SessionFabricCommandReceipt,
  type SessionFabricContextBundle as SessionFabricContextBundleType,
  type SessionFabricContextRequest as SessionFabricContextRequestType,
  type SessionFabricExecutionLocation,
  type SessionFabricSearchRequest as SessionFabricSearchRequestType,
  type SessionFabricSearchResponse as SessionFabricSearchResponseType,
  type SessionFabricSessionId,
} from "@t3tools/contracts/session-fabric";
import { isLoopbackSessionFabricRequestUrl } from "@t3tools/shared/sessionFabricCapability";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ScaffoldSessionFabricCapabilityInput } from "../../../scaffold/ScaffoldControlPlaneClient.ts";
import { makeScaffoldLifecycleService } from "../../../scaffold/ScaffoldLifecycleService.ts";

declare const __T3CODE_BUILD_SESSION_FABRIC_RELAY_URL__: string | undefined;

export class SessionFabricGatewayError extends Schema.TaggedErrorClass<SessionFabricGatewayError>()(
  "SessionFabricGatewayError",
  {
    operation: Schema.Literals(["search", "context", "submit"]),
    detail: Schema.String,
  },
) {}

const isSessionFabricGatewayError = (cause: unknown): cause is SessionFabricGatewayError =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "SessionFabricGatewayError";

export interface SessionFabricWebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type SessionFabricWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
) => SessionFabricWebSocketLike;

export type SessionFabricFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type SessionFabricGatewayAuthMode = "required" | "disabled";

export type SessionFabricGatewayCapabilityIssuer = (
  input: ScaffoldSessionFabricCapabilityInput,
) => Promise<SessionFabricCapabilityGrant>;

export interface SessionFabricGatewayOptions {
  readonly relayBaseUrl: URL | null;
  readonly authMode?: SessionFabricGatewayAuthMode;
  readonly issueCapability?: SessionFabricGatewayCapabilityIssuer;
  readonly fetch?: SessionFabricFetch;
  readonly webSocketConstructor?: SessionFabricWebSocketConstructor;
  readonly now?: () => string;
  readonly requestTimeoutMs?: number;
  readonly dispatchTimeoutMs?: number;
}

export interface SessionFabricGatewayShape {
  readonly search: (
    request: SessionFabricSearchRequestType,
  ) => Effect.Effect<SessionFabricSearchResponseType, SessionFabricGatewayError>;
  readonly context: (
    request: SessionFabricContextRequestType,
  ) => Effect.Effect<SessionFabricContextBundleType, SessionFabricGatewayError>;
  readonly submit: (input: {
    readonly sessionId: SessionFabricSessionId;
    readonly clientId: SessionFabricClientId;
    readonly location: SessionFabricExecutionLocation;
    readonly command: SessionFabricCommand;
  }) => Effect.Effect<SessionFabricCommandReceipt, SessionFabricGatewayError>;
}

export class SessionFabricGateway extends Context.Service<
  SessionFabricGateway,
  SessionFabricGatewayShape
>()("t3/mcp/toolkits/session-fabric-references/gateway/SessionFabricGateway") {}

const encodeSearch = Schema.encodeSync(Schema.fromJsonString(SessionFabricSearchRequest));
const encodeContext = Schema.encodeSync(Schema.fromJsonString(SessionFabricContextRequest));
const decodeSearch = Schema.decodeUnknownEffect(SessionFabricSearchResponse);
const decodeContext = Schema.decodeUnknownEffect(SessionFabricContextBundle);
const encodeClientFrame = Schema.encodeSync(Schema.fromJsonString(SessionFabricClientFrame));
const decodeServerFrame = Schema.decodeUnknownSync(Schema.fromJsonString(SessionFabricServerFrame));

const currentIso = () => DateTime.formatIso(DateTime.nowUnsafe());

const buildSessionFabricRelayUrl =
  typeof __T3CODE_BUILD_SESSION_FABRIC_RELAY_URL__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_SESSION_FABRIC_RELAY_URL__;

function normalizeSessionFabricRelayUrl(value: string | URL | null | undefined): URL | null {
  const normalized = typeof value === "string" ? value.trim() : value?.href;
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    const protocolAllowed =
      url.protocol === "https:" ||
      (url.protocol === "http:" && isLoopbackSessionFabricRequestUrl(url.href));
    return protocolAllowed && url.username.length === 0 && url.password.length === 0 ? url : null;
  } catch {
    return null;
  }
}

export function resolveSessionFabricGatewayRelayUrl(
  runtimeUrl: URL | null,
  buildUrl = buildSessionFabricRelayUrl,
): URL | null {
  return normalizeSessionFabricRelayUrl(runtimeUrl) ?? normalizeSessionFabricRelayUrl(buildUrl);
}

function apiUrl(relayBaseUrl: URL, resource: "search" | "context"): URL {
  const url = new URL(relayBaseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/session-fabric/${resource}`;
  url.search = "";
  url.hash = "";
  return url;
}

function isLoopbackRelay(url: URL): boolean {
  return isLoopbackSessionFabricRequestUrl(url.href);
}

export function sessionFabricGatewayWebSocketUrl(
  relayBaseUrl: URL,
  sessionId: SessionFabricSessionId,
): URL | null {
  const url = new URL(relayBaseUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else return null;
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/session-fabric/sessions/${encodeURIComponent(sessionId)}/connect`;
  url.search = "";
  url.hash = "";
  return url;
}

function messageText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return null;
}

async function fetchJsonWithTimeout(input: {
  readonly fetch: SessionFabricFetch;
  readonly url: URL;
  readonly operation: "search" | "context";
  readonly body: string;
  readonly authorization: string | null;
  readonly timeoutMs: number;
}): Promise<unknown> {
  const controller = new AbortController();
  const deadlineController = new AbortController();
  let timedOut = false;
  const timeoutError = () =>
    new SessionFabricGatewayError({
      operation: input.operation,
      detail: "Session fabric request timed out.",
    });
  const request = (async () => {
    let response: Response;
    try {
      response = await input.fetch(input.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.authorization === null
            ? {}
            : { authorization: `Bearer ${input.authorization}` }),
        },
        body: input.body,
        signal: controller.signal,
      });
    } catch (cause) {
      throw timedOut
        ? timeoutError()
        : new SessionFabricGatewayError({
            operation: input.operation,
            detail: cause instanceof Error ? cause.message : "Session fabric request failed.",
          });
    }
    if (!response.ok) {
      throw new SessionFabricGatewayError({
        operation: input.operation,
        detail: `Session fabric request failed with status ${response.status}.`,
      });
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw timedOut
        ? timeoutError()
        : new SessionFabricGatewayError({
            operation: input.operation,
            detail: "Session fabric returned an unreadable response.",
          });
    }
  })();
  const deadline = Effect.runPromise(
    Effect.sleep(`${input.timeoutMs} millis`).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          timedOut = true;
          controller.abort();
        }),
      ),
      Effect.flatMap(() => Effect.fail(timeoutError())),
    ),
    { signal: deadlineController.signal },
  );

  try {
    return await Promise.race([request, deadline]);
  } finally {
    deadlineController.abort();
    controller.abort();
  }
}

function controllerCapabilityRequest(
  sessionId: SessionFabricSessionId,
  location: SessionFabricExecutionLocation,
): ScaffoldSessionFabricCapabilityInput | null {
  if (location.environmentKind === "local") {
    return {
      role: "controller",
      fabricSessionId: sessionId,
      environmentKind: "local",
      environmentId: location.environmentId,
      threadId: location.threadId,
    };
  }
  if (
    location.environmentKind === "scaffold" &&
    location.scaffoldSessionId !== null &&
    location.scaffoldLifecycleEpoch !== null &&
    location.scaffoldLifecycleEpoch !== undefined
  ) {
    return {
      role: "controller",
      fabricSessionId: sessionId,
      scaffoldSessionId: location.scaffoldSessionId,
      scaffoldLifecycleEpoch: location.scaffoldLifecycleEpoch,
    };
  }
  return null;
}

export function makeSessionFabricGateway(
  options: SessionFabricGatewayOptions,
): SessionFabricGatewayShape {
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
  const WebSocketImplementation =
    options.webSocketConstructor ??
    (globalThis.WebSocket as unknown as SessionFabricWebSocketConstructor | undefined);
  const now = options.now ?? currentIso;

  const requireRelay = (
    operation: SessionFabricGatewayError["operation"],
  ): Effect.Effect<URL, SessionFabricGatewayError> =>
    options.relayBaseUrl === null
      ? Effect.fail(
          new SessionFabricGatewayError({
            operation,
            detail: "T3CODE_SESSION_FABRIC_RELAY_URL is not configured.",
          }),
        )
      : Effect.succeed(options.relayBaseUrl);

  const authorize = (
    relayBaseUrl: URL,
    operation: SessionFabricGatewayError["operation"],
    capabilityRequest: ScaffoldSessionFabricCapabilityInput,
  ): Effect.Effect<SessionFabricCapabilityGrant | null, SessionFabricGatewayError> => {
    if (options.authMode === "disabled") {
      return isLoopbackRelay(relayBaseUrl)
        ? Effect.succeed(null)
        : Effect.fail(
            new SessionFabricGatewayError({
              operation,
              detail: "Disabled session fabric authorization requires a loopback relay.",
            }),
          );
    }
    if (options.issueCapability === undefined) {
      return Effect.fail(
        new SessionFabricGatewayError({
          operation,
          detail: "Session fabric capability authorization is not configured.",
        }),
      );
    }
    return Effect.tryPromise({
      try: () => options.issueCapability!(capabilityRequest),
      catch: () =>
        new SessionFabricGatewayError({
          operation,
          detail: "Session fabric capability authorization failed.",
        }),
    });
  };

  const request = <A>(input: {
    readonly operation: "search" | "context";
    readonly body: string;
    readonly decode: (value: unknown) => Effect.Effect<A, Schema.SchemaError>;
  }): Effect.Effect<A, SessionFabricGatewayError> =>
    Effect.gen(function* () {
      const relayBaseUrl = yield* requireRelay(input.operation);
      const grant = yield* authorize(relayBaseUrl, input.operation, { role: "viewer" });
      const payload = yield* Effect.tryPromise({
        try: () =>
          fetchJsonWithTimeout({
            fetch: fetchImplementation,
            url: apiUrl(relayBaseUrl, input.operation),
            operation: input.operation,
            body: input.body,
            authorization: grant?.capability ?? null,
            timeoutMs: options.requestTimeoutMs ?? 30_000,
          }),
        catch: (cause) =>
          isSessionFabricGatewayError(cause)
            ? cause
            : new SessionFabricGatewayError({
                operation: input.operation,
                detail: "Session fabric request failed.",
              }),
      });
      return yield* input.decode(payload).pipe(
        Effect.mapError(
          () =>
            new SessionFabricGatewayError({
              operation: input.operation,
              detail: "Session fabric returned an invalid response.",
            }),
        ),
      );
    });

  const submit: SessionFabricGatewayShape["submit"] = (input) =>
    Effect.gen(function* () {
      const relayBaseUrl = yield* requireRelay("submit");
      const capabilityRequest = controllerCapabilityRequest(input.sessionId, input.location);
      if (capabilityRequest === null) {
        return yield* new SessionFabricGatewayError({
          operation: "submit",
          detail: "Session fabric target does not have an exact controller capability binding.",
        });
      }
      const grant = yield* authorize(relayBaseUrl, "submit", capabilityRequest);
      const socketUrl = sessionFabricGatewayWebSocketUrl(relayBaseUrl, input.sessionId);
      if (socketUrl === null || WebSocketImplementation === undefined) {
        return yield* new SessionFabricGatewayError({
          operation: "submit",
          detail: "Session fabric WebSocket transport is unavailable.",
        });
      }

      return yield* Effect.callback<SessionFabricCommandReceipt, SessionFabricGatewayError>(
        (resume) => {
          const socket = new WebSocketImplementation(
            socketUrl.toString(),
            grant === null
              ? []
              : [
                  SESSION_FABRIC_WS_PROTOCOL,
                  `${SESSION_FABRIC_WS_CAPABILITY_PREFIX}${grant.capability}`,
                ],
          );
          let settled = false;
          const finish = (
            result: Effect.Effect<SessionFabricCommandReceipt, SessionFabricGatewayError>,
          ) => {
            if (settled) return;
            settled = true;
            socket.onopen = null;
            socket.onmessage = null;
            socket.onerror = null;
            socket.onclose = null;
            socket.close();
            resume(result);
          };
          const fail = (detail: string) =>
            finish(Effect.fail(new SessionFabricGatewayError({ operation: "submit", detail })));

          socket.onopen = () => {
            try {
              socket.send(
                encodeClientFrame({
                  type: "client.hello",
                  hello: {
                    protocolVersion: SESSION_FABRIC_PROTOCOL_VERSION,
                    sessionId: input.sessionId,
                    clientId: input.clientId,
                    afterEventSequence: 0,
                    connectedAt: now(),
                  },
                }),
              );
              socket.send(encodeClientFrame({ type: "command.submit", command: input.command }));
            } catch (cause) {
              fail(cause instanceof Error ? cause.message : "Could not submit the fabric command.");
            }
          };
          socket.onmessage = (event) => {
            const text = messageText(event.data);
            if (text === null) return;
            try {
              const frame = decodeServerFrame(text);
              if (
                frame.type !== "command.receipt" ||
                frame.receipt.commandId !== input.command.commandId ||
                (frame.receipt.status !== "accepted" && frame.receipt.status !== "rejected")
              ) {
                return;
              }
              if (frame.receipt.sessionId !== input.sessionId) {
                fail("Session fabric returned a command receipt for a different session.");
                return;
              }
              finish(Effect.succeed(frame.receipt));
            } catch {
              // Other clients and protocol versions may share the socket. Ignore
              // frames that do not satisfy the current fabric contract.
            }
          };
          socket.onerror = () => fail("The session fabric WebSocket failed.");
          socket.onclose = () => fail("The session fabric WebSocket closed before acceptance.");

          return Effect.sync(() => {
            if (settled) return;
            settled = true;
            socket.onopen = null;
            socket.onmessage = null;
            socket.onerror = null;
            socket.onclose = null;
            socket.close();
          });
        },
      ).pipe(
        Effect.timeoutOrElse({
          duration: options.dispatchTimeoutMs ?? 30_000,
          orElse: () =>
            Effect.fail(
              new SessionFabricGatewayError({
                operation: "submit",
                detail: "The session runner did not accept the command before the timeout.",
              }),
            ),
        }),
      );
    });

  return SessionFabricGateway.of({
    search: (search) =>
      request({
        operation: "search",
        body: encodeSearch(search),
        decode: decodeSearch,
      }),
    context: (context) =>
      request({
        operation: "context",
        body: encodeContext(context),
        decode: decodeContext,
      }),
    submit,
  });
}

const config = Config.all({
  relayUrl: Config.url("T3CODE_SESSION_FABRIC_RELAY_URL").pipe(Config.option),
  authMode: Config.literals(["required", "disabled"], "T3CODE_SESSION_FABRIC_AUTH_MODE").pipe(
    Config.withDefault("required"),
  ),
});

export const layer = Layer.effect(
  SessionFabricGateway,
  config.pipe(
    Effect.map(({ relayUrl, authMode }) => {
      const scaffoldLifecycle = makeScaffoldLifecycleService();
      return makeSessionFabricGateway({
        relayBaseUrl: resolveSessionFabricGatewayRelayUrl(
          Option.isSome(relayUrl) ? relayUrl.value : null,
        ),
        authMode,
        issueCapability: (capability) =>
          scaffoldLifecycle.issueSessionFabricCapability({ capability }),
      });
    }),
  ),
);
