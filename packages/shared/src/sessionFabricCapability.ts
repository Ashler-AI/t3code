import type {
  SessionFabricCapabilityClaims,
  SessionFabricExecutionLocation,
  SessionFabricLocalControllerAuthorityBinding,
  SessionFabricLocalAuthorityBinding,
  SessionFabricRunnerHello,
  SessionFabricSessionRecord,
  SessionFabricSessionId,
  SessionFabricSnapshot,
} from "@t3tools/contracts/session-fabric";
import {
  SESSION_FABRIC_CAPABILITY_TYP,
  SESSION_FABRIC_WS_CAPABILITY_PREFIX,
  SESSION_FABRIC_WS_PROTOCOL,
  SessionFabricCapabilityClaims as SessionFabricCapabilityClaimsSchema,
} from "@t3tools/contracts/session-fabric";
import {
  decodeProtectedHeader,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type JWTPayload,
} from "jose";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface SessionFabricCapabilityRequiredConfig {
  readonly mode: "required";
  readonly issuer: string;
  readonly audience: string;
  readonly publicKeys: Readonly<Record<string, string>>;
}

export interface SessionFabricCapabilityDisabledConfig {
  readonly mode: "disabled";
}

export type SessionFabricCapabilityVerifierConfig =
  | SessionFabricCapabilityRequiredConfig
  | SessionFabricCapabilityDisabledConfig;

const MAX_CAPABILITY_TTL_SECONDS = {
  viewer: 300,
  controller: 60,
  runner: 900,
  tombstone: 300,
} as const;

export class SessionFabricCapabilityError extends Schema.TaggedErrorClass<SessionFabricCapabilityError>()(
  "SessionFabricCapabilityError",
  {
    reason: Schema.Literals([
      "missing",
      "malformed",
      "unknown_key",
      "invalid",
      "forbidden",
      "unavailable",
    ]),
  },
) {
  override get message(): string {
    return `Session fabric capability ${this.reason.replaceAll("_", " ")}.`;
  }
}

const normalizePem = (value: string): string => value.replace(/\\n/gu, "\n").trim();
const decodeClaims = Schema.decodeUnknownEffect(SessionFabricCapabilityClaimsSchema);

export function signSessionFabricCapability(input: {
  readonly privateKey: string;
  readonly keyId: string;
  readonly claims: SessionFabricCapabilityClaims;
}): Effect.Effect<string, SessionFabricCapabilityError> {
  return Effect.tryPromise({
    try: async () => {
      const key = await importPKCS8(normalizePem(input.privateKey), "EdDSA");
      return new SignJWT(input.claims as JWTPayload)
        .setProtectedHeader({
          alg: "EdDSA",
          typ: SESSION_FABRIC_CAPABILITY_TYP,
          kid: input.keyId,
        })
        .sign(key);
    },
    catch: () => new SessionFabricCapabilityError({ reason: "invalid" }),
  });
}

export function verifySessionFabricCapability(input: {
  readonly config: SessionFabricCapabilityRequiredConfig;
  readonly token: string;
  readonly nowEpochSeconds: number;
}): Effect.Effect<SessionFabricCapabilityClaims, SessionFabricCapabilityError> {
  return Effect.gen(function* () {
    const protectedHeader = yield* Effect.try({
      try: () => decodeProtectedHeader(input.token),
      catch: () => new SessionFabricCapabilityError({ reason: "malformed" }),
    });
    if (
      protectedHeader.alg !== "EdDSA" ||
      protectedHeader.typ !== SESSION_FABRIC_CAPABILITY_TYP ||
      typeof protectedHeader.kid !== "string" ||
      protectedHeader.kid.length === 0
    ) {
      return yield* new SessionFabricCapabilityError({ reason: "invalid" });
    }
    const publicKey = input.config.publicKeys[protectedHeader.kid];
    if (publicKey === undefined) {
      return yield* new SessionFabricCapabilityError({ reason: "unknown_key" });
    }
    const payload = yield* Effect.tryPromise({
      try: async () => {
        const key = await importSPKI(normalizePem(publicKey), "EdDSA");
        return (
          await jwtVerify(input.token, key, {
            algorithms: ["EdDSA"],
            typ: SESSION_FABRIC_CAPABILITY_TYP,
            issuer: input.config.issuer,
            audience: input.config.audience,
            clockTolerance: 0,
            currentDate: DateTime.toDate(DateTime.makeUnsafe(input.nowEpochSeconds * 1_000)),
          })
        ).payload;
      },
      catch: () => new SessionFabricCapabilityError({ reason: "invalid" }),
    });
    const claims = yield* decodeClaims(payload).pipe(
      Effect.mapError(() => new SessionFabricCapabilityError({ reason: "invalid" })),
    );
    if (
      claims.nbf > claims.iat ||
      claims.iat > claims.exp ||
      claims.iat > input.nowEpochSeconds ||
      claims.exp - claims.iat > MAX_CAPABILITY_TTL_SECONDS[claims.role]
    ) {
      return yield* new SessionFabricCapabilityError({ reason: "invalid" });
    }
    return claims;
  });
}

export function isLoopbackSessionFabricRequestUrl(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

export function authorizeSessionFabricCapability(input: {
  readonly config: SessionFabricCapabilityVerifierConfig | null;
  readonly authorization: string | null | undefined;
  readonly requestUrl: string;
  readonly nowEpochSeconds: number;
}): Effect.Effect<SessionFabricCapabilityClaims | null, SessionFabricCapabilityError> {
  if (input.config === null) {
    return Effect.fail(new SessionFabricCapabilityError({ reason: "unavailable" }));
  }
  if (input.config.mode === "disabled") {
    return isLoopbackSessionFabricRequestUrl(input.requestUrl)
      ? Effect.succeed(null)
      : Effect.fail(new SessionFabricCapabilityError({ reason: "unavailable" }));
  }
  const token = authorizationCapability(input.authorization);
  if (token === null) {
    return Effect.fail(new SessionFabricCapabilityError({ reason: "missing" }));
  }
  return verifySessionFabricCapability({
    config: input.config,
    token,
    nowEpochSeconds: input.nowEpochSeconds,
  });
}

export function bearerCapability(headers: Headers): string | null {
  return authorizationCapability(headers.get("authorization"));
}

export function authorizationCapability(authorization: string | null | undefined): string | null {
  if (authorization === null) return null;
  if (authorization === undefined) return null;
  const match = authorization.match(/^Bearer ([A-Za-z0-9._~-]+)$/u);
  return match?.[1] ?? null;
}

export function websocketCapability(header: string | null | undefined): string | null {
  if (header === null || header === undefined) return null;
  const protocols = header.split(",").map((value) => value.trim());
  if (!protocols.includes(SESSION_FABRIC_WS_PROTOCOL)) return null;
  const encoded = protocols.find((protocol) =>
    protocol.startsWith(SESSION_FABRIC_WS_CAPABILITY_PREFIX),
  );
  if (encoded === undefined) return null;
  const token = encoded.slice(SESSION_FABRIC_WS_CAPABILITY_PREFIX.length);
  return token.length === 0 ? null : token;
}

export function sessionFabricWebSocketProtocols(token: string): readonly [string, string] {
  return [SESSION_FABRIC_WS_PROTOCOL, `${SESSION_FABRIC_WS_CAPABILITY_PREFIX}${token}`];
}

/** Requires the lifecycle binding used by control and publication authority. */
export function isPublicScaffoldLocation(
  location: SessionFabricExecutionLocation,
): location is SessionFabricExecutionLocation & {
  readonly environmentKind: "scaffold";
  readonly scaffoldSessionId: string;
  readonly scaffoldLifecycleEpoch: number;
} {
  return (
    location.environmentKind === "scaffold" &&
    location.scaffoldSessionId !== null &&
    typeof location.scaffoldLifecycleEpoch === "number"
  );
}

/**
 * Accepts persisted public history from before lifecycle epochs were recorded.
 * Do not use this predicate to grant control or publication authority.
 */
export function isPublicScaffoldViewLocation(
  location: SessionFabricExecutionLocation,
): location is SessionFabricExecutionLocation & {
  readonly environmentKind: "scaffold";
  readonly scaffoldSessionId: string;
} {
  return location.environmentKind === "scaffold" && location.scaffoldSessionId !== null;
}

export function isPublicScaffoldSnapshot(snapshot: SessionFabricSnapshot): boolean {
  return isPublicScaffoldSessionRecord(snapshot.session);
}

export function isPublicScaffoldSessionRecord(record: SessionFabricSessionRecord): boolean {
  return record.publication === "public" && isPublicScaffoldViewLocation(record.location);
}

export function isPublicLocalLocation(
  location: SessionFabricExecutionLocation,
): location is SessionFabricExecutionLocation & { readonly environmentKind: "local" } {
  return (
    location.environmentKind === "local" &&
    location.scaffoldSessionId === null &&
    location.scaffoldSessionUrl === null &&
    (location.scaffoldLifecycleEpoch === null || location.scaffoldLifecycleEpoch === undefined)
  );
}

export function isPublicSessionRecord(record: SessionFabricSessionRecord): boolean {
  return (
    record.publication === "public" &&
    (isPublicScaffoldViewLocation(record.location) || isPublicLocalLocation(record.location))
  );
}

export function isPublicSessionSnapshot(snapshot: SessionFabricSnapshot): boolean {
  return isPublicSessionRecord(snapshot.session);
}

export function isLocalSessionFabricCapability(
  claims: SessionFabricCapabilityClaims,
): claims is Extract<SessionFabricCapabilityClaims, { readonly environmentKind: "local" }> {
  return "environmentKind" in claims && claims.environmentKind === "local";
}

export function localCapabilityBinding(
  claims: SessionFabricCapabilityClaims,
): SessionFabricLocalAuthorityBinding | SessionFabricLocalControllerAuthorityBinding | null {
  if (!isLocalSessionFabricCapability(claims)) return null;
  return {
    fabricSessionId: claims.fabricSessionId,
    environmentKind: claims.environmentKind,
    environmentId: claims.environmentId,
    threadId: claims.threadId,
    actorId: claims.actorId,
    ...("runnerId" in claims ? { runnerId: claims.runnerId } : {}),
  };
}

export function localCapabilityMatchesAuthority(input: {
  readonly claims: SessionFabricCapabilityClaims;
  readonly sessionId: SessionFabricSessionId;
  readonly environmentId: SessionFabricExecutionLocation["environmentId"];
  readonly threadId: SessionFabricExecutionLocation["threadId"];
  readonly actorId: string;
}): boolean {
  const binding = localCapabilityBinding(input.claims);
  return (
    binding !== null &&
    binding.fabricSessionId === input.sessionId &&
    binding.environmentId === input.environmentId &&
    binding.threadId === input.threadId &&
    binding.actorId === input.actorId
  );
}

export function localRunnerCapabilityMatchesAuthority(input: {
  readonly claims: SessionFabricCapabilityClaims;
  readonly sessionId: SessionFabricSessionId;
  readonly environmentId: SessionFabricExecutionLocation["environmentId"];
  readonly threadId: SessionFabricExecutionLocation["threadId"];
  readonly runnerId: string;
  readonly actorId: string;
}): boolean {
  const binding = localCapabilityBinding(input.claims);
  return (
    binding !== null &&
    "runnerId" in binding &&
    localCapabilityMatchesAuthority(input) &&
    binding.runnerId === input.runnerId
  );
}

export function capabilityCanListDirectory(claims: SessionFabricCapabilityClaims): boolean {
  return claims.role === "viewer";
}

export function capabilityCanReadSession(
  claims: SessionFabricCapabilityClaims,
  snapshot: SessionFabricSnapshot,
): boolean {
  if (!isPublicSessionSnapshot(snapshot)) return false;
  if (claims.role === "viewer") return true;
  if (claims.role !== "controller") return false;
  if (isLocalSessionFabricCapability(claims)) {
    return (
      isPublicLocalLocation(snapshot.session.location) &&
      claims.fabricSessionId === snapshot.session.sessionId &&
      claims.environmentId === snapshot.session.location.environmentId &&
      claims.threadId === snapshot.session.location.threadId
    );
  }
  return (
    claims.fabricSessionId === snapshot.session.sessionId &&
    claims.environmentKind === snapshot.session.location.environmentKind &&
    claims.environmentId === snapshot.session.location.environmentId &&
    claims.threadId === snapshot.session.location.threadId &&
    claims.scaffoldSessionId === snapshot.session.location.scaffoldSessionId &&
    claims.scaffoldLifecycleEpoch === snapshot.session.location.scaffoldLifecycleEpoch
  );
}

export function capabilityCanControlSession(input: {
  readonly claims: SessionFabricCapabilityClaims;
  readonly sessionId: SessionFabricSessionId;
  readonly publication: SessionFabricSnapshot["session"]["publication"];
  readonly location: SessionFabricExecutionLocation;
}): boolean {
  const { claims, sessionId, publication, location } = input;
  // Controller actor identity is audit provenance, not execution ownership.
  // The signed command scope and exact public session binding authorize control;
  // runner capabilities independently fence the sole execution owner.
  if (publication !== "public" || claims.role !== "controller") return false;
  if (isLocalSessionFabricCapability(claims)) {
    return (
      isPublicLocalLocation(location) &&
      claims.fabricSessionId === sessionId &&
      claims.environmentId === location.environmentId &&
      claims.threadId === location.threadId
    );
  }
  return (
    isPublicScaffoldLocation(location) &&
    claims.fabricSessionId === sessionId &&
    claims.environmentKind === location.environmentKind &&
    claims.environmentId === location.environmentId &&
    claims.threadId === location.threadId &&
    claims.scaffoldSessionId === location.scaffoldSessionId &&
    claims.scaffoldLifecycleEpoch === location.scaffoldLifecycleEpoch
  );
}

export function capabilityCanRunSession(
  claims: SessionFabricCapabilityClaims,
  hello: SessionFabricRunnerHello,
): boolean {
  if (claims.role === "runner" && isLocalSessionFabricCapability(claims)) {
    return (
      hello.publication === "public" &&
      isPublicLocalLocation(hello.location) &&
      claims.fabricSessionId === hello.sessionId &&
      claims.environmentId === hello.location.environmentId &&
      claims.threadId === hello.location.threadId &&
      claims.runnerId === hello.runnerId
    );
  }
  return (
    claims.role === "runner" &&
    hello.publication === "public" &&
    isPublicScaffoldLocation(hello.location) &&
    claims.scaffoldSessionId === hello.location.scaffoldSessionId &&
    claims.scaffoldLifecycleEpoch === hello.location.scaffoldLifecycleEpoch &&
    (claims.runnerId === undefined || claims.runnerId === hello.runnerId)
  );
}

export function parseSessionFabricPublicKeys(value: string): Readonly<Record<string, string>> {
  const decoded: unknown = JSON.parse(value);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Session fabric public keys must be a JSON object.");
  }
  const entries = Object.entries(decoded);
  if (
    entries.length === 0 ||
    entries.some(
      ([keyId, publicKey]) =>
        keyId.trim().length === 0 || typeof publicKey !== "string" || publicKey.trim().length === 0,
    )
  ) {
    throw new Error("Session fabric public keys must contain non-empty key ids and PEM values.");
  }
  return Object.fromEntries(entries);
}

export function makeSessionFabricCapabilityVerifierConfig(input: {
  readonly mode: string | undefined;
  readonly issuer: string | undefined;
  readonly audience: string | undefined;
  readonly publicKeysJson: string | undefined;
}): SessionFabricCapabilityVerifierConfig | null {
  if (input.mode === "disabled") return { mode: "disabled" };
  if (input.mode !== undefined && input.mode !== "required") return null;
  if (
    input.issuer === undefined ||
    input.issuer.trim().length === 0 ||
    input.audience === undefined ||
    input.audience.trim().length === 0 ||
    input.publicKeysJson === undefined
  ) {
    return null;
  }
  try {
    return {
      mode: "required",
      issuer: input.issuer.trim().replace(/\/+$/gu, ""),
      audience: input.audience.trim(),
      publicKeys: parseSessionFabricPublicKeys(input.publicKeysJson),
    };
  } catch {
    return null;
  }
}
