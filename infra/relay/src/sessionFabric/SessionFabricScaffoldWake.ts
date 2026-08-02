import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const SESSION_FABRIC_SCAFFOLD_WAKE_REQUEST_VERSION =
  "scaffold.session_fabric.wake.v1" as const;
export const SESSION_FABRIC_SCAFFOLD_WAKE_RESULT_VERSION =
  "scaffold.session_fabric.wake_result.v1" as const;
export const SESSION_FABRIC_SCAFFOLD_WAKE_TIMESTAMP_HEADER =
  "x-ashler-session-fabric-wake-timestamp";
export const SESSION_FABRIC_SCAFFOLD_WAKE_SIGNATURE_HEADER =
  "x-ashler-session-fabric-wake-signature";

export interface SessionFabricScaffoldWakeConfig {
  readonly url: URL;
  readonly secret: string;
  readonly timeoutMs: number;
}

export interface SessionFabricScaffoldWakeRequest {
  readonly version: typeof SESSION_FABRIC_SCAFFOLD_WAKE_REQUEST_VERSION;
  readonly fabricSessionId: string;
  readonly commandId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly scaffoldSessionId: string;
  readonly expectedLifecycleEpoch: number;
  readonly actorId: string;
}

export interface SessionFabricScaffoldWakeResponse {
  readonly ok: true;
  readonly version: typeof SESSION_FABRIC_SCAFFOLD_WAKE_RESULT_VERSION;
  readonly fabricSessionId: string;
  readonly commandId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly scaffoldSessionId: string;
  readonly expectedLifecycleEpoch: number;
  readonly targetLifecycleEpoch: number;
  readonly status: "resuming" | "ready" | "agent_running";
  readonly deduplicated: boolean;
}

export class SessionFabricScaffoldWakeError extends Schema.TaggedErrorClass<SessionFabricScaffoldWakeError>()(
  "SessionFabricScaffoldWakeError",
  {
    reason: Schema.Literals(["configuration", "timeout", "transport", "response"]),
    status: Schema.NullOr(Schema.Number),
  },
) {}

export function scaffoldWakeFailureIsDefinitive(failure: SessionFabricScaffoldWakeError): boolean {
  if (failure.reason === "configuration") return true;
  if (failure.reason !== "response" || failure.status === null) return false;
  return (
    failure.status >= 400 &&
    failure.status < 500 &&
    failure.status !== 408 &&
    failure.status !== 425 &&
    failure.status !== 429
  );
}

const isSessionFabricScaffoldWakeError = Schema.is(SessionFabricScaffoldWakeError);
const encodeJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

type SessionFabricWakeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

export function resolveSessionFabricScaffoldWakeConfig(input: {
  readonly url: string | undefined;
  readonly secret: string | undefined;
  readonly timeoutMs: string | undefined;
}): SessionFabricScaffoldWakeConfig | null {
  const urlValue = input.url?.trim();
  const secret = input.secret?.trim();
  const timeoutValue = input.timeoutMs?.trim();
  if (!urlValue && !secret && !timeoutValue) return null;
  if (!urlValue || !secret || !timeoutValue || !/^[1-9][0-9]*$/u.test(timeoutValue)) {
    throw new SessionFabricScaffoldWakeError({ reason: "configuration", status: null });
  }

  const timeoutMs = Number(timeoutValue);
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new SessionFabricScaffoldWakeError({ reason: "configuration", status: null });
  }
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  ) {
    throw new SessionFabricScaffoldWakeError({ reason: "configuration", status: null });
  }
  return { url, secret, timeoutMs };
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

async function signWakeRequest(secret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`))),
  );
}

function parseWakeResponse(
  value: unknown,
  request: SessionFabricScaffoldWakeRequest,
): SessionFabricScaffoldWakeResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionFabricScaffoldWakeError({ reason: "response", status: null });
  }
  const response = value as Record<string, unknown>;
  const exactKeys = [
    "ok",
    "version",
    "fabricSessionId",
    "commandId",
    "environmentId",
    "threadId",
    "scaffoldSessionId",
    "expectedLifecycleEpoch",
    "targetLifecycleEpoch",
    "status",
    "deduplicated",
  ];
  if (
    Object.keys(response).length !== exactKeys.length ||
    exactKeys.some((key) => !Object.hasOwn(response, key)) ||
    response.ok !== true ||
    response.version !== SESSION_FABRIC_SCAFFOLD_WAKE_RESULT_VERSION ||
    response.fabricSessionId !== request.fabricSessionId ||
    response.commandId !== request.commandId ||
    response.environmentId !== request.environmentId ||
    response.threadId !== request.threadId ||
    response.scaffoldSessionId !== request.scaffoldSessionId ||
    response.expectedLifecycleEpoch !== request.expectedLifecycleEpoch ||
    response.targetLifecycleEpoch !== request.expectedLifecycleEpoch + 1 ||
    (response.status !== "resuming" &&
      response.status !== "ready" &&
      response.status !== "agent_running") ||
    typeof response.deduplicated !== "boolean"
  ) {
    throw new SessionFabricScaffoldWakeError({ reason: "response", status: null });
  }
  return response as unknown as SessionFabricScaffoldWakeResponse;
}

async function fetchWithDeadline(input: {
  readonly fetch: SessionFabricWakeFetch;
  readonly url: URL;
  readonly init: RequestInit;
  readonly timeoutMs: number;
}): Promise<Response> {
  const controller = new AbortController();
  const deadlineController = new AbortController();
  const deadline = Effect.runPromise(
    Effect.sleep(`${input.timeoutMs} millis`).pipe(
      Effect.tap(() => Effect.sync(() => controller.abort())),
      Effect.flatMap(() =>
        Effect.fail(new SessionFabricScaffoldWakeError({ reason: "timeout", status: null })),
      ),
    ),
    { signal: deadlineController.signal },
  );
  try {
    return await Promise.race([
      input.fetch(input.url, { ...input.init, signal: controller.signal }),
      deadline,
    ]);
  } finally {
    deadlineController.abort();
  }
}

export const wakeScaffoldSession = Effect.fn("session_fabric.wake_scaffold_session")(function* (
  config: SessionFabricScaffoldWakeConfig,
  request: Omit<SessionFabricScaffoldWakeRequest, "version">,
  options: {
    readonly fetch?: SessionFabricWakeFetch;
    readonly now?: () => number;
  } = {},
) {
  const payload: SessionFabricScaffoldWakeRequest = {
    version: SESSION_FABRIC_SCAFFOLD_WAKE_REQUEST_VERSION,
    ...request,
  };
  const body = yield* encodeJsonString(payload).pipe(
    Effect.mapError(
      () => new SessionFabricScaffoldWakeError({ reason: "transport", status: null }),
    ),
  );
  const timestamp = String((options.now ?? Date.now)());
  const signature = yield* Effect.tryPromise({
    try: () => signWakeRequest(config.secret, timestamp, body),
    catch: () => new SessionFabricScaffoldWakeError({ reason: "transport", status: null }),
  });
  const response = yield* Effect.tryPromise({
    try: () =>
      fetchWithDeadline({
        fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
        url: config.url,
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SESSION_FABRIC_SCAFFOLD_WAKE_TIMESTAMP_HEADER]: timestamp,
            [SESSION_FABRIC_SCAFFOLD_WAKE_SIGNATURE_HEADER]: signature,
          },
          body,
        },
        timeoutMs: config.timeoutMs,
      }),
    catch: (cause) =>
      isSessionFabricScaffoldWakeError(cause)
        ? cause
        : new SessionFabricScaffoldWakeError({ reason: "transport", status: null }),
  });
  if (response.status !== 200 && response.status !== 202) {
    yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.ignore);
    return yield* new SessionFabricScaffoldWakeError({
      reason: "response",
      status: response.status,
    });
  }
  const value = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: () =>
      new SessionFabricScaffoldWakeError({ reason: "response", status: response.status }),
  });
  return yield* Effect.try({
    try: () => parseWakeResponse(value, payload),
    catch: (cause) =>
      isSessionFabricScaffoldWakeError(cause)
        ? cause
        : new SessionFabricScaffoldWakeError({ reason: "response", status: response.status }),
  });
});
