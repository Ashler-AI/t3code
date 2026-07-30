import {
  SessionFabricCapabilityGrant as SessionFabricCapabilityGrantSchema,
  type SessionFabricCapabilityGrant,
  type SessionFabricSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type { SessionFabricCapabilityGrant } from "@t3tools/contracts";

export type SessionFabricCapabilityRole = "viewer" | "controller";

export type SessionFabricControllerBinding =
  | {
      readonly fabricSessionId: SessionFabricSessionId;
      readonly scaffoldSessionId: string;
      readonly scaffoldLifecycleEpoch: number;
    }
  | {
      readonly fabricSessionId: SessionFabricSessionId;
      readonly environmentKind: "local";
      readonly environmentId: string;
      readonly threadId: string;
    };

export class SessionFabricAuthorizationError extends Schema.TaggedErrorClass<SessionFabricAuthorizationError>()(
  "SessionFabricAuthorizationError",
  {
    reason: Schema.Literals([
      "authentication",
      "permission",
      "offline",
      "network",
      "invalid-response",
    ]),
    status: Schema.optionalKey(Schema.Number),
    detail: Schema.String,
  },
) {}

export interface SessionFabricAuthorizationShape {
  readonly mode: "capability" | "disabled";
  readonly viewer: (options?: {
    readonly forceRefresh?: boolean;
  }) => Effect.Effect<SessionFabricCapabilityGrant | null, SessionFabricAuthorizationError>;
  readonly controller: (
    binding: SessionFabricControllerBinding,
    options?: { readonly forceRefresh?: boolean },
  ) => Effect.Effect<SessionFabricCapabilityGrant | null, SessionFabricAuthorizationError>;
  readonly invalidate: (
    role: SessionFabricCapabilityRole,
    binding?: SessionFabricControllerBinding,
  ) => void;
}

let defaultAuthorization: SessionFabricAuthorizationShape | null = null;

/** Installs the process-local capability client without persisting any issued capability. */
export function installDefaultSessionFabricAuthorization(
  authorization: SessionFabricAuthorizationShape,
): () => void {
  const previous = defaultAuthorization;
  defaultAuthorization = authorization;
  return () => {
    if (defaultAuthorization === authorization) defaultAuthorization = previous;
  };
}

export function readDefaultSessionFabricAuthorization(): SessionFabricAuthorizationShape {
  if (defaultAuthorization === null) {
    throw new Error("Session fabric authorization has not been configured.");
  }
  return defaultAuthorization;
}

export interface SessionFabricCapabilityClientOptions {
  readonly endpoint: string | URL;
  readonly deployment?: "staging" | "production";
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
}

export interface RuntimeSessionFabricAuthorizationOptions extends SessionFabricCapabilityClientOptions {
  readonly authMode: string | undefined;
  readonly appUrl: string | URL;
  readonly relayBaseUrl: string | URL | null;
  readonly localDevAutoAuthEnabled: boolean;
}

const REFRESH_SKEW_MS = 30_000;
const DEFAULT_CAPABILITY_REQUEST_TIMEOUT_MS = 10_000;
const isCapabilityGrant = Schema.is(SessionFabricCapabilityGrantSchema);
const isAuthorizationError = Schema.is(SessionFabricAuthorizationError);

function capabilityError(
  status: number,
  detail: string,
  reason?: SessionFabricAuthorizationError["reason"],
): SessionFabricAuthorizationError {
  return new SessionFabricAuthorizationError({
    reason:
      reason ??
      (status === 401
        ? "authentication"
        : status === 403
          ? "permission"
          : status === 409
            ? "offline"
            : "network"),
    status,
    detail,
  });
}

function responseErrorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const error = Reflect.get(value, "error");
  return typeof error === "string" ? error.trim().toLowerCase() : undefined;
}

function isRemoteCodeWriteCredentialDenial(status: number, code: string | undefined): boolean {
  if (status !== 403 || code === undefined) return false;
  return (
    code === "remote_code_token_forbidden" ||
    code === "remote_code_insufficient_scope" ||
    code === "oauth_insufficient_scope" ||
    (code.includes("remote_code") &&
      code.includes("write") &&
      (code.includes("forbidden") || code.includes("missing") || code.includes("required")))
  );
}

function hasExactScopes(actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean {
  return actual.length === expected.length && expected.every((scope) => actual.includes(scope));
}

function decodeGrant(
  value: unknown,
  expectedRole: SessionFabricCapabilityRole,
  binding?: SessionFabricControllerBinding,
) {
  if (!isCapabilityGrant(value) || value.role !== expectedRole) {
    return null;
  }
  if (expectedRole === "viewer") {
    const bindings = value.bindings;
    if (
      !hasExactScopes(value.scopes, ["directory:read", "session:read"]) ||
      bindings.fabricSessionId !== undefined ||
      ("scaffoldSessionId" in bindings && bindings.scaffoldSessionId !== undefined) ||
      ("scaffoldLifecycleEpoch" in bindings && bindings.scaffoldLifecycleEpoch !== undefined) ||
      "environmentKind" in bindings
    ) {
      return null;
    }
    return value;
  }
  if (binding === undefined || !hasExactScopes(value.scopes, ["session:read", "session:command"])) {
    return null;
  }
  const bindings = value.bindings;
  if ("environmentKind" in binding) {
    if (
      !("environmentKind" in bindings) ||
      bindings.environmentKind !== "local" ||
      bindings.fabricSessionId !== binding.fabricSessionId ||
      bindings.environmentId !== binding.environmentId ||
      bindings.threadId !== binding.threadId
    ) {
      return null;
    }
    return value;
  }
  if (
    "environmentKind" in bindings ||
    bindings.fabricSessionId !== binding.fabricSessionId ||
    bindings.scaffoldSessionId !== binding.scaffoldSessionId ||
    bindings.scaffoldLifecycleEpoch !== binding.scaffoldLifecycleEpoch
  )
    return null;
  return value;
}

export function makeSessionFabricCapabilityAuthorization(
  options: SessionFabricCapabilityClientOptions,
): SessionFabricAuthorizationShape {
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const endpoint = new URL(options.endpoint, globalThis.location?.origin ?? "http://localhost");
  endpoint.search = "";
  endpoint.hash = "";
  const cache = new Map<string, SessionFabricCapabilityGrant>();
  const pending = new Map<string, Promise<SessionFabricCapabilityGrant>>();

  const cacheKey = (
    role: SessionFabricCapabilityRole,
    binding?: SessionFabricControllerBinding,
  ) => {
    if (role === "viewer") return role;
    if (binding === undefined) return `${role}:missing`;
    return "environmentKind" in binding
      ? `${role}:local:${binding.fabricSessionId}:${binding.environmentId}:${binding.threadId}`
      : `${role}:scaffold:${binding.fabricSessionId}:${binding.scaffoldSessionId}:${binding.scaffoldLifecycleEpoch}`;
  };

  const invalidate = (
    role: SessionFabricCapabilityRole,
    binding?: SessionFabricControllerBinding,
  ) => {
    cache.delete(cacheKey(role, binding));
  };

  const acquire = (
    role: SessionFabricCapabilityRole,
    binding: SessionFabricControllerBinding | undefined,
    forceRefresh: boolean,
  ): Effect.Effect<SessionFabricCapabilityGrant, SessionFabricAuthorizationError> =>
    Effect.tryPromise({
      try: async () => {
        const key = cacheKey(role, binding);
        const cached = cache.get(key);
        if (
          !forceRefresh &&
          cached !== undefined &&
          Date.parse(cached.expiresAt) - REFRESH_SKEW_MS > now()
        ) {
          return cached;
        }
        if (forceRefresh) cache.delete(key);
        const existing = pending.get(key);
        if (existing !== undefined) return existing;

        const request = (async () => {
          const response = await fetchImplementation(endpoint, {
            method: "POST",
            credentials: "same-origin",
            signal: AbortSignal.timeout(
              options.requestTimeoutMs ?? DEFAULT_CAPABILITY_REQUEST_TIMEOUT_MS,
            ),
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              role,
              ...binding,
              ...(options.deployment === undefined ? {} : { deployment: options.deployment }),
            }),
          });
          if (!response.ok) {
            const code = responseErrorCode(await response.json().catch(() => undefined));
            const credentialDenied = isRemoteCodeWriteCredentialDenial(response.status, code);
            throw capabilityError(
              response.status,
              credentialDenied
                ? "Session fabric authentication is required. Reconnect Scaffold to continue."
                : response.status === 401
                  ? "Session fabric authentication is required."
                  : response.status === 403
                    ? "This session is available as read-only."
                    : response.status === 409
                      ? "The session runner is offline or stale."
                      : "Session fabric authorization is unavailable.",
              credentialDenied ? "authentication" : undefined,
            );
          }
          const decoded = decodeGrant(await response.json(), role, binding);
          if (decoded === null) {
            throw new SessionFabricAuthorizationError({
              reason: "invalid-response",
              detail: "Session fabric authorization returned an invalid capability.",
            });
          }
          cache.set(key, decoded);
          return decoded;
        })();
        pending.set(key, request);
        try {
          return await request;
        } finally {
          pending.delete(key);
        }
      },
      catch: (cause) =>
        isAuthorizationError(cause)
          ? cause
          : new SessionFabricAuthorizationError({
              reason: "network",
              detail: "Session fabric authorization is unavailable.",
            }),
    });

  return {
    mode: "capability",
    viewer: (requestOptions) => acquire("viewer", undefined, requestOptions?.forceRefresh === true),
    controller: (binding, requestOptions) =>
      acquire("controller", binding, requestOptions?.forceRefresh === true),
    invalidate,
  };
}

export function makeDisabledSessionFabricAuthorization(): SessionFabricAuthorizationShape {
  return {
    mode: "disabled",
    viewer: () => Effect.succeed(null),
    controller: () => Effect.succeed(null),
    invalidate: () => undefined,
  };
}

function isLoopbackHttpUrl(value: string | URL): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "[::1]") return true;
    const octets = hostname.split(".");
    return (
      octets.length === 4 &&
      octets[0] === "127" &&
      octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255)
    );
  } catch {
    return false;
  }
}

/**
 * Disabled authorization is reserved for the canonical combined localhost dev runtime.
 * Split dev commands do not receive the auto-auth marker and therefore stay capability-backed.
 */
export function makeRuntimeSessionFabricAuthorization(
  options: RuntimeSessionFabricAuthorizationOptions,
): SessionFabricAuthorizationShape {
  if (
    options.authMode?.trim().toLowerCase() === "disabled" &&
    options.localDevAutoAuthEnabled &&
    options.relayBaseUrl !== null &&
    isLoopbackHttpUrl(options.appUrl) &&
    isLoopbackHttpUrl(options.relayBaseUrl)
  ) {
    return makeDisabledSessionFabricAuthorization();
  }
  return makeSessionFabricCapabilityAuthorization(options);
}

export function sessionFabricAuthorizationHeaders(
  grant: SessionFabricCapabilityGrant | null,
): Record<string, string> {
  return grant === null ? {} : { authorization: `Bearer ${grant.capability}` };
}

export function sessionFabricWebSocketProtocols(
  grant: SessionFabricCapabilityGrant | null,
): ReadonlyArray<string> {
  return grant === null
    ? []
    : ["t3.session-fabric.v1", `t3.session-fabric.capability.${grant.capability}`];
}
