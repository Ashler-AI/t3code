// @effect-diagnostics returnEffectInGen:off -- Alchemy Durable Objects intentionally use a two-phase outer/inner Effect.
import type {
  SessionFabricCapabilityClaims,
  SessionFabricClientFrame,
  SessionFabricCommand,
  SessionFabricCommandReceipt,
  SessionFabricContextBundle,
  SessionFabricContextPublication,
  SessionFabricEventBatch,
  SessionFabricPublishedEvent,
  SessionFabricServerFrame,
  SessionFabricSessionId,
  SessionFabricSnapshot,
  SessionFabricRunnerHello,
} from "@t3tools/contracts/session-fabric";
import {
  SessionFabricClientFrame as SessionFabricClientFrameSchema,
  SessionFabricCommand as SessionFabricCommandSchema,
  SessionFabricCommandReceipt as SessionFabricCommandReceiptSchema,
  SessionFabricPublishedEvent as SessionFabricPublishedEventSchema,
  SessionFabricServerFrame as SessionFabricServerFrameSchema,
  SessionFabricSessionId as SessionFabricSessionIdSchema,
  SessionFabricSnapshot as SessionFabricSnapshotSchema,
  SESSION_FABRIC_WS_PROTOCOL,
} from "@t3tools/contracts/session-fabric";
import {
  authorizationCapability,
  capabilityCanControlSession,
  capabilityCanReadSession,
  capabilityCanRunSession,
  isLocalSessionFabricCapability,
  isLoopbackSessionFabricRequestUrl,
  isPublicLocalLocation,
  isPublicScaffoldLocation,
  localRunnerCapabilityMatchesAuthority,
  makeSessionFabricCapabilityVerifierConfig,
  SessionFabricCapabilityError,
  verifySessionFabricCapability,
  websocketCapability,
} from "@t3tools/shared/sessionFabricCapability";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  decideAuthorizedCommandSubmit,
  decideCommandSubmit,
  decideEventAppend,
  eventCancelsPendingSettlePause,
  isCurrentRunnerAttachment,
  nextSessionFabricMaintenanceDueAt,
  offlineScaffoldCommandCanWake,
  runnerHelloMatchesLease,
  scaffoldWakeFollowerStatus,
  scaffoldWakeHasAttemptsRemaining,
  scaffoldWakeKeepsCommandPending,
  scaffoldWakeRequestsAuthority,
  scaffoldWakeRetryDelayMs,
  SESSION_FABRIC_WAKE_MAX_ATTEMPTS,
  SESSION_FABRIC_AUTHENTICATION_CLOSE_CODE,
  SESSION_FABRIC_PERMISSION_CLOSE_CODE,
  settledEventCanQueueScaffoldPause,
  settlePauseCanResettle,
  settlePauseNeedsCompensatingWake,
  settlePauseCompensationCommandId,
  settlePauseLifecycleAuthority,
  settlementEventIdFromCompensationCommand,
  shouldReplayCommand,
  snapshotProvesScaffoldWakeTarget,
} from "./SessionStreamModel.ts";
import {
  validateScaffoldWakeAuthorityConfig,
  wakeScaffoldSession,
} from "./ScaffoldWakeAuthority.ts";
import {
  pauseSettledScaffoldSession,
  validateScaffoldSettlePauseAuthorityConfig,
} from "./ScaffoldSettlePauseAuthority.ts";
import SessionDirectory from "./SessionDirectory.ts";

interface SocketAttachment {
  readonly role: "pending" | "client" | "runner";
  readonly sessionId: string;
  readonly peerId: string | null;
  readonly runnerGeneration: number | null;
  readonly capability: SessionFabricCapabilityClaims | null;
}

interface MetaRow {
  readonly [key: string]: string | number | null;
  readonly session_id: string | null;
  readonly runner_id: string | null;
  readonly runner_generation: number;
  readonly runner_state: string;
  readonly snapshot_json: string | null;
  readonly snapshot_sequence: number;
  readonly environment_kind: string | null;
  readonly environment_id: string | null;
  readonly thread_id: string | null;
  readonly actor_id: string | null;
}

export interface LocalSessionFabricPinnedAuthority {
  readonly environmentId: string;
  readonly threadId: string;
  readonly runnerId: string;
  readonly actorId: string;
  readonly sessionId: string;
}

export function normalizeSnapshotToRelayCursor(
  snapshot: SessionFabricSnapshot,
  durableEventSequence: number,
  previousCoveredEventSequence = 0,
): SessionFabricSnapshot {
  const incomingCoveredEventSequence = Math.min(
    snapshot.session.cursor.eventSequence,
    snapshot.compactedThroughEventSequence,
  );
  // Runner acknowledgement restarts behind the relay after reconnect. Coverage
  // is monotonic across accepted snapshots, but it must never advance past the
  // durable event maximum merely because a newer event interleaved projection.
  const coveredEventSequence = Math.min(
    Math.max(previousCoveredEventSequence, incomingCoveredEventSequence),
    durableEventSequence,
  );
  return {
    ...snapshot,
    session: {
      ...snapshot.session,
      cursor: {
        ...snapshot.session.cursor,
        eventSequence: coveredEventSequence,
      },
    },
    compactedThroughEventSequence: coveredEventSequence,
  };
}

export function clientHelloShouldSynchronize(
  hello: Extract<SessionFabricClientFrame, { type: "client.hello" }>["hello"],
): boolean {
  return hello.synchronize !== false;
}

export function snapshotAuthorityCanAdvance(input: {
  readonly currentSnapshotSequence: number;
  readonly currentUpdatedAt: string | null;
  readonly incomingSnapshotSequence: number;
  readonly incomingUpdatedAt: string;
}): boolean {
  if (input.incomingSnapshotSequence !== input.currentSnapshotSequence) {
    return input.incomingSnapshotSequence > input.currentSnapshotSequence;
  }
  return input.currentUpdatedAt === null || input.incomingUpdatedAt >= input.currentUpdatedAt;
}

function completeLocalAuthority(meta: MetaRow): LocalSessionFabricPinnedAuthority | null {
  return meta.environment_kind === "local" &&
    meta.environment_id !== null &&
    meta.thread_id !== null &&
    meta.runner_id !== null &&
    meta.actor_id !== null &&
    meta.session_id !== null
    ? {
        environmentId: meta.environment_id,
        threadId: meta.thread_id,
        runnerId: meta.runner_id,
        actorId: meta.actor_id,
        sessionId: meta.session_id,
      }
    : null;
}

export function localRunnerCanClaimPinnedAuthority(input: {
  readonly claims: SessionFabricCapabilityClaims;
  readonly hello: SessionFabricRunnerHello;
  readonly pinned: LocalSessionFabricPinnedAuthority | null;
  readonly sessionAlreadyClaimed: boolean;
}): boolean {
  if (
    !isLocalSessionFabricCapability(input.claims) ||
    !capabilityCanRunSession(input.claims, input.hello)
  ) {
    return false;
  }
  if (input.pinned === null) return !input.sessionAlreadyClaimed;
  return (
    input.pinned.sessionId === input.hello.sessionId &&
    input.pinned.environmentId === input.hello.location.environmentId &&
    input.pinned.threadId === input.hello.location.threadId &&
    localRunnerCapabilityMatchesAuthority({
      claims: input.claims,
      sessionId: input.hello.sessionId,
      environmentId: input.hello.location.environmentId,
      threadId: input.hello.location.threadId,
      runnerId: input.pinned.runnerId,
      actorId: input.pinned.actorId,
    })
  );
}

export function localControllerMatchesPinnedAuthority(input: {
  readonly claims: SessionFabricCapabilityClaims;
  readonly sessionId: SessionFabricSessionId;
  readonly publication: SessionFabricSnapshot["session"]["publication"];
  readonly location: SessionFabricSnapshot["session"]["location"];
  readonly pinned: LocalSessionFabricPinnedAuthority | null;
}): boolean {
  return (
    input.pinned !== null &&
    input.pinned.sessionId === input.sessionId &&
    input.pinned.environmentId === input.location.environmentId &&
    input.pinned.threadId === input.location.threadId &&
    capabilityCanControlSession({
      claims: input.claims,
      sessionId: input.sessionId,
      publication: input.publication,
      location: input.location,
    })
  );
}

export function scaffoldControllerMatchesSnapshotIdentity(input: {
  readonly claims: SessionFabricCapabilityClaims;
  readonly sessionId: SessionFabricSessionId;
  readonly publication: SessionFabricSnapshot["session"]["publication"];
  readonly location: SessionFabricSnapshot["session"]["location"];
}): boolean {
  return (
    input.publication === "public" &&
    input.claims.role === "controller" &&
    !isLocalSessionFabricCapability(input.claims) &&
    isPublicScaffoldLocation(input.location) &&
    input.claims.fabricSessionId === input.sessionId &&
    input.claims.environmentKind === input.location.environmentKind &&
    input.claims.environmentId === input.location.environmentId &&
    input.claims.threadId === input.location.threadId &&
    input.claims.scaffoldSessionId === input.location.scaffoldSessionId
  );
}

export function localViewerCanReadPinnedAuthority(input: {
  readonly claims: SessionFabricCapabilityClaims | null;
  readonly sessionId: SessionFabricSessionId;
  readonly pinned: LocalSessionFabricPinnedAuthority | null;
}): boolean {
  return (
    input.claims?.role === "viewer" &&
    input.pinned !== null &&
    input.pinned.sessionId === input.sessionId &&
    input.claims.actorId === input.pinned.actorId
  );
}

export function localAuthorityViewForViewer(input: {
  readonly claims: SessionFabricCapabilityClaims | null;
  readonly sessionId: SessionFabricSessionId;
  readonly pinned: LocalSessionFabricPinnedAuthority | null;
}): {
  readonly fabricSessionId: string;
  readonly environmentKind: "local";
  readonly environmentId: string;
  readonly threadId: string;
  readonly actorId: string;
} | null {
  return localViewerCanReadPinnedAuthority(input) && input.pinned !== null
    ? {
        fabricSessionId: input.pinned.sessionId,
        environmentKind: "local",
        environmentId: input.pinned.environmentId,
        threadId: input.pinned.threadId,
        actorId: input.pinned.actorId,
      }
    : null;
}

function localAuthorityColumnsAreConsistent(meta: MetaRow): boolean {
  const values = [meta.environment_kind, meta.environment_id, meta.thread_id, meta.actor_id];
  return values.every((value) => value === null) || completeLocalAuthority(meta) !== null;
}

function localCapabilityMatchesPinnedMeta(input: {
  readonly capability: SessionFabricCapabilityClaims;
  readonly sessionId: SessionFabricSessionId;
  readonly location: SessionFabricSnapshot["session"]["location"];
  readonly meta: MetaRow;
}): boolean {
  const pinned = completeLocalAuthority(input.meta);
  return (
    pinned !== null &&
    pinned.sessionId === input.sessionId &&
    pinned.environmentId === input.location.environmentId &&
    pinned.threadId === input.location.threadId &&
    localRunnerCapabilityMatchesAuthority({
      claims: input.capability,
      sessionId: input.sessionId,
      environmentId: input.location.environmentId,
      threadId: input.location.threadId,
      runnerId: pinned.runnerId,
      actorId: pinned.actorId,
    })
  );
}

interface EventRow {
  readonly [key: string]: string | number | null;
  readonly stream_sequence: number;
  readonly payload_json: string;
}

interface CommandRow {
  readonly [key: string]: string | number | null;
  readonly command_id: string;
  readonly payload_json: string;
  readonly status: string;
  readonly result_sequence: number | null;
  readonly detail: string | null;
  readonly updated_at: string;
}

interface ContextRow {
  readonly [key: string]: string | number | null;
  readonly code_diff: string | null;
  readonly continuation_ref: string | null;
  readonly published_at: string;
}

interface WakeRow {
  readonly [key: string]: string | number | null;
  readonly command_id: string;
  readonly environment_id: string | null;
  readonly thread_id: string | null;
  readonly scaffold_session_id: string;
  readonly expected_lifecycle_epoch: number;
  readonly target_lifecycle_epoch: number | null;
  readonly actor_id: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly next_attempt_at: number | null;
  readonly detail: string | null;
  readonly updated_at: string;
}

export function legacyWakeIdentityFromStoredSnapshot(input: {
  readonly snapshotJson: string | null;
  readonly scaffoldSessionId: string;
}): { readonly environmentId: string; readonly threadId: string } | null {
  if (input.snapshotJson === null) return null;
  try {
    const snapshot = decodeSnapshot(input.snapshotJson);
    return snapshot.session.publication === "public" &&
      isPublicScaffoldLocation(snapshot.session.location) &&
      snapshot.session.location.scaffoldSessionId === input.scaffoldSessionId
      ? {
          environmentId: snapshot.session.location.environmentId,
          threadId: snapshot.session.location.threadId,
        }
      : null;
  } catch {
    return null;
  }
}

export function scaffoldWakeIdentityMatches(input: {
  readonly wakeEnvironmentId: string | null;
  readonly wakeThreadId: string | null;
  readonly wakeScaffoldSessionId: string;
  readonly wakeExpectedLifecycleEpoch: number;
  readonly environmentId: string;
  readonly threadId: string;
  readonly scaffoldSessionId: string;
  readonly expectedLifecycleEpoch: number;
}): boolean {
  return (
    input.wakeEnvironmentId !== null &&
    input.wakeThreadId !== null &&
    input.wakeEnvironmentId === input.environmentId &&
    input.wakeThreadId === input.threadId &&
    input.wakeScaffoldSessionId === input.scaffoldSessionId &&
    input.wakeExpectedLifecycleEpoch === input.expectedLifecycleEpoch
  );
}

interface SettlePauseRow {
  readonly [key: string]: string | number | null;
  readonly settlement_event_id: string;
  readonly fabric_session_id: string;
  readonly environment_id: string;
  readonly thread_id: string;
  readonly scaffold_session_id: string;
  readonly expected_lifecycle_epoch: number;
  readonly target_lifecycle_epoch: number | null;
  readonly status: string;
  readonly attempt_count: number;
  readonly next_attempt_at: number | null;
  readonly detail: string | null;
  readonly updated_at: string;
}

export function scaffoldWakeExpectedLifecycleEpoch(input: {
  readonly durableLifecycleEpoch: number;
  readonly controllerLifecycleEpoch: number;
  readonly snapshotLifecycleEpoch: number | null | undefined;
  readonly settlePauseProof:
    | {
        readonly expectedLifecycleEpoch: number;
        readonly targetLifecycleEpoch: number | null;
        readonly status: string;
      }
    | undefined;
}): number | null {
  if (input.controllerLifecycleEpoch === input.durableLifecycleEpoch) {
    return input.durableLifecycleEpoch;
  }
  const proof = input.settlePauseProof;
  return input.snapshotLifecycleEpoch === input.controllerLifecycleEpoch &&
    input.durableLifecycleEpoch === input.controllerLifecycleEpoch + 1 &&
    proof?.expectedLifecycleEpoch === input.controllerLifecycleEpoch &&
    proof.targetLifecycleEpoch === input.durableLifecycleEpoch &&
    (proof.status === "completed" || proof.status === "compensating")
    ? input.durableLifecycleEpoch
    : null;
}

const decodeClientFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SessionFabricClientFrameSchema),
);
const decodeSessionId = Schema.decodeUnknownSync(SessionFabricSessionIdSchema);
const decodeSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(SessionFabricSnapshotSchema));
const decodePublishedEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(SessionFabricPublishedEventSchema),
);
const decodeCommand = Schema.decodeUnknownSync(Schema.fromJsonString(SessionFabricCommandSchema));
const encodeServerFrame = Schema.encodeSync(Schema.fromJsonString(SessionFabricServerFrameSchema));
const encodePublishedEvent = Schema.encodeSync(
  Schema.fromJsonString(SessionFabricPublishedEventSchema),
);
const encodeCommand = Schema.encodeSync(Schema.fromJsonString(SessionFabricCommandSchema));
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(SessionFabricSnapshotSchema));
const decodeCommandReceipt = Schema.decodeUnknownSync(SessionFabricCommandReceiptSchema);

const currentIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const parseMessage = (message: string | ArrayBuffer) =>
  decodeClientFrame(typeof message === "string" ? message : new TextDecoder().decode(message));

const encodeFrame = (frame: SessionFabricServerFrame): string => encodeServerFrame(frame);

const pathSessionId = (url: URL): SessionFabricSessionId | null => {
  const match = url.pathname.match(
    /^\/v1\/session-fabric\/sessions\/([^/]+)\/(?:authority|connect|snapshot|events|context)$/,
  );
  if (!match) return null;
  try {
    const encodedSessionId = match[1];
    return encodedSessionId === undefined
      ? null
      : decodeSessionId(decodeURIComponent(encodedSessionId));
  } catch {
    return null;
  }
};

export default class SessionStreamCoordinator extends Cloudflare.DurableObject<SessionStreamCoordinator>()(
  "SessionStreamCoordinator",
  Effect.gen(function* () {
    const directory = yield* SessionDirectory;
    const authMode = yield* Config.string("SESSION_FABRIC_AUTH_MODE").pipe(Config.option);
    const authIssuer = yield* Config.string("SESSION_FABRIC_CAPABILITY_ISSUER").pipe(Config.option);
    const authAudience = yield* Config.string("SESSION_FABRIC_CAPABILITY_AUDIENCE").pipe(
      Config.option,
    );
    const authPublicKeys = yield* Config.string("SESSION_FABRIC_CAPABILITY_PUBLIC_KEYS_JSON").pipe(
      Config.option,
    );
    const wakeEndpoint = yield* Config.string("SESSION_FABRIC_SCAFFOLD_WAKE_URL").pipe(
      Config.option,
    );
    const wakeSecret = yield* Config.redacted("SESSION_FABRIC_SCAFFOLD_WAKE_SECRET").pipe(
      Config.option,
    );
    const wakeTimeoutMs = yield* Config.int("SESSION_FABRIC_SCAFFOLD_WAKE_TIMEOUT_MS").pipe(
      Config.option,
    );
    const settlePauseEndpoint = yield* Config.string(
      "SESSION_FABRIC_SCAFFOLD_SETTLE_PAUSE_URL",
    ).pipe(Config.option);
    const settlePauseSecret = yield* Config.redacted(
      "SESSION_FABRIC_SCAFFOLD_SETTLE_PAUSE_SECRET",
    ).pipe(Config.option);
    const settlePauseTimeoutMs = yield* Config.int(
      "SESSION_FABRIC_SCAFFOLD_SETTLE_PAUSE_TIMEOUT_MS",
    ).pipe(Config.option);
    const verifierConfig = makeSessionFabricCapabilityVerifierConfig({
      mode: Option.getOrUndefined(authMode),
      issuer: Option.getOrUndefined(authIssuer),
      audience: Option.getOrUndefined(authAudience),
      publicKeysJson: Option.getOrUndefined(authPublicKeys),
    });
    const wakeEndpointValue = Option.getOrUndefined(wakeEndpoint);
    const wakeSecretValue = Option.getOrUndefined(wakeSecret);
    const wakeTimeoutMsValue = Option.getOrUndefined(wakeTimeoutMs);
    const settlePauseEndpointValue = Option.getOrUndefined(settlePauseEndpoint);
    const settlePauseSecretValue = Option.getOrUndefined(settlePauseSecret);
    const settlePauseTimeoutMsValue = Option.getOrUndefined(settlePauseTimeoutMs);
    const wakeAuthorityConfig = validateScaffoldWakeAuthorityConfig({
      ...(wakeEndpointValue === undefined ? {} : { endpoint: wakeEndpointValue }),
      ...(wakeSecretValue === undefined ? {} : { sharedSecret: Redacted.value(wakeSecretValue) }),
      ...(wakeTimeoutMsValue === undefined ? {} : { timeoutMs: wakeTimeoutMsValue }),
    });
    const settlePauseAuthorityConfig = validateScaffoldSettlePauseAuthorityConfig({
      ...(settlePauseEndpointValue === undefined ? {} : { endpoint: settlePauseEndpointValue }),
      ...(settlePauseSecretValue === undefined
        ? {}
        : { sharedSecret: Redacted.value(settlePauseSecretValue) }),
      ...(settlePauseTimeoutMsValue === undefined ? {} : { timeoutMs: settlePauseTimeoutMsValue }),
    });
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const { sql } = state.storage;

      yield* sql
        .exec(
          "CREATE TABLE IF NOT EXISTS session_meta (id INTEGER PRIMARY KEY CHECK (id = 1), session_id TEXT, runner_id TEXT, runner_generation INTEGER NOT NULL DEFAULT 0, runner_state TEXT NOT NULL DEFAULT 'offline', snapshot_json TEXT, snapshot_sequence INTEGER NOT NULL DEFAULT 0, environment_kind TEXT, environment_id TEXT, thread_id TEXT, actor_id TEXT)",
        )
        .pipe(Effect.asVoid);
      const metaColumns = yield* sql.exec<{ readonly name: string }>(
        "PRAGMA table_info(session_meta)",
      );
      const existingMetaColumns = yield* metaColumns.toArray();
      if (!existingMetaColumns.some((column) => column.name === "runner_id")) {
        yield* sql.exec("ALTER TABLE session_meta ADD COLUMN runner_id TEXT").pipe(Effect.asVoid);
      }
      for (const column of [
        "environment_kind",
        "environment_id",
        "thread_id",
        "actor_id",
      ] as const) {
        if (!existingMetaColumns.some((candidate) => candidate.name === column)) {
          yield* sql.exec(`ALTER TABLE session_meta ADD COLUMN ${column} TEXT`).pipe(Effect.asVoid);
        }
      }
      yield* sql
        .exec(
          "CREATE TABLE IF NOT EXISTS session_events (stream_sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL)",
        )
        .pipe(Effect.asVoid);
      yield* sql
        .exec(
          "CREATE TABLE IF NOT EXISTS session_commands (command_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, status TEXT NOT NULL, result_sequence INTEGER, detail TEXT, updated_at TEXT NOT NULL)",
        )
        .pipe(Effect.asVoid);
      yield* sql
        .exec(
          "CREATE TABLE IF NOT EXISTS session_command_wakes (command_id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, thread_id TEXT NOT NULL, scaffold_session_id TEXT NOT NULL, expected_lifecycle_epoch INTEGER NOT NULL, target_lifecycle_epoch INTEGER, actor_id TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, detail TEXT, updated_at TEXT NOT NULL)",
        )
        .pipe(Effect.asVoid);
      const wakeColumns = yield* sql.exec<{ readonly name: string }>(
        "PRAGMA table_info(session_command_wakes)",
      );
      const existingWakeColumns = yield* wakeColumns.toArray();
      for (const column of ["environment_id", "thread_id"] as const) {
        if (!existingWakeColumns.some((candidate) => candidate.name === column)) {
          yield* sql
            .exec(`ALTER TABLE session_command_wakes ADD COLUMN ${column} TEXT`)
            .pipe(Effect.asVoid);
        }
      }
      yield* sql
        .exec(
          "CREATE TABLE IF NOT EXISTS session_maintenance (id INTEGER PRIMARY KEY CHECK (id = 1), directory_due_at INTEGER, wake_due_at INTEGER)",
        )
        .pipe(Effect.asVoid);
      const maintenanceColumns = yield* sql.exec<{ readonly name: string }>(
        "PRAGMA table_info(session_maintenance)",
      );
      if (!(yield* maintenanceColumns.toArray()).some((column) => column.name === "pause_due_at")) {
        yield* sql
          .exec("ALTER TABLE session_maintenance ADD COLUMN pause_due_at INTEGER")
          .pipe(Effect.asVoid);
      }
      yield* sql
        .exec(
          "CREATE TABLE IF NOT EXISTS session_settle_pauses (settlement_event_id TEXT PRIMARY KEY, fabric_session_id TEXT NOT NULL, environment_id TEXT NOT NULL, thread_id TEXT NOT NULL, scaffold_session_id TEXT NOT NULL, expected_lifecycle_epoch INTEGER NOT NULL, target_lifecycle_epoch INTEGER, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, detail TEXT, updated_at TEXT NOT NULL, UNIQUE(fabric_session_id, expected_lifecycle_epoch))",
        )
        .pipe(Effect.asVoid);
      yield* sql
        .exec("INSERT OR IGNORE INTO session_maintenance (id) VALUES (1)")
        .pipe(Effect.asVoid);
      yield* sql
        .exec(
          "CREATE TABLE IF NOT EXISTS session_context (id INTEGER PRIMARY KEY CHECK (id = 1), code_diff TEXT, continuation_ref TEXT, published_at TEXT NOT NULL)",
        )
        .pipe(Effect.asVoid);
      yield* sql
        .exec(
          "INSERT OR IGNORE INTO session_meta (id, runner_generation, runner_state, snapshot_sequence) VALUES (1, 0, 'offline', 0)",
        )
        .pipe(Effect.asVoid);
      const storedSnapshot = yield* sql.exec<{ readonly snapshot_json: string | null }>(
        "SELECT snapshot_json FROM session_meta WHERE id = 1",
      );
      const legacyWakes = yield* sql.exec<{
        readonly command_id: string;
        readonly scaffold_session_id: string;
      }>(
        "SELECT command_id, scaffold_session_id FROM session_command_wakes WHERE environment_id IS NULL OR thread_id IS NULL",
      );
      const snapshotJson = (yield* storedSnapshot.one()).snapshot_json;
      for (const wake of yield* legacyWakes.toArray()) {
        const identity = legacyWakeIdentityFromStoredSnapshot({
          snapshotJson,
          scaffoldSessionId: wake.scaffold_session_id,
        });
        if (identity === null) continue;
        yield* sql
          .exec(
            "UPDATE session_command_wakes SET environment_id = ?, thread_id = ? WHERE command_id = ? AND (environment_id IS NULL OR thread_id IS NULL)",
            identity.environmentId,
            identity.threadId,
            wake.command_id,
          )
          .pipe(Effect.asVoid);
      }

      const readMeta = Effect.fn("session_fabric.read_meta")(function* () {
        const cursor = yield* sql.exec<MetaRow>(
          "SELECT session_id, runner_id, runner_generation, runner_state, snapshot_json, snapshot_sequence, environment_kind, environment_id, thread_id, actor_id FROM session_meta WHERE id = 1",
        );
        return yield* cursor.one();
      });

      const currentEventSequence = Effect.fn("session_fabric.current_event_sequence")(function* () {
        const cursor = yield* sql.exec<{ event_sequence: number }>(
          "SELECT COALESCE(MAX(stream_sequence), 0) AS event_sequence FROM session_events",
        );
        return (yield* cursor.one()).event_sequence;
      });

      const readSnapshot = Effect.fn("session_fabric.read_snapshot")(function* () {
        const meta = yield* readMeta();
        return meta.snapshot_json === null ? null : decodeSnapshot(meta.snapshot_json);
      });

      const nowEpochSeconds = Clock.currentTimeMillis.pipe(
        Effect.map((milliseconds) => Math.floor(milliseconds / 1_000)),
      );

      const verifyCapability = Effect.fn("session_fabric.verify_capability")(function* (
        token: string | null,
        requestUrl: string,
      ) {
        if (verifierConfig === null) {
          return yield* new SessionFabricCapabilityError({ reason: "unavailable" });
        }
        if (verifierConfig.mode === "disabled") {
          // Relative targets can only arrive through the bound outer Worker,
          // which already enforces that disabled mode is loopback-only.
          return isLoopbackSessionFabricRequestUrl(requestUrl) || requestUrl.startsWith("/")
            ? null
            : yield* new SessionFabricCapabilityError({ reason: "unavailable" });
        }
        if (token === null) {
          return yield* new SessionFabricCapabilityError({ reason: "missing" });
        }
        return yield* verifySessionFabricCapability({
          config: verifierConfig,
          token,
          nowEpochSeconds: yield* nowEpochSeconds,
        });
      });

      const capabilityIsCurrent = Effect.fn("session_fabric.capability_is_current")(function* (
        capability: SessionFabricCapabilityClaims | null,
      ) {
        if (verifierConfig?.mode === "disabled") return true;
        if (capability === null) return false;
        const now = yield* nowEpochSeconds;
        return capability.nbf <= now && capability.exp > now;
      });

      const canReadSnapshot = Effect.fn("session_fabric.can_read_snapshot")(
        (capability: SessionFabricCapabilityClaims | null, snapshot: SessionFabricSnapshot) =>
          Effect.succeed(
            verifierConfig?.mode === "disabled" ||
              (capability !== null && capabilityCanReadSession(capability, snapshot)),
          ),
      );

      const readContext = Effect.fn("session_fabric.read_context")(function* (
        includeCodeDiff: boolean,
        includeContinuation: boolean,
      ) {
        const snapshot = yield* readSnapshot();
        if (snapshot === null) return null;
        const cursor = yield* sql.exec<ContextRow>(
          "SELECT code_diff, continuation_ref, published_at FROM session_context WHERE id = 1",
        );
        const context = (yield* cursor.toArray()).at(0);
        return {
          session: snapshot.session,
          snapshot,
          codeDiff: includeCodeDiff ? (context?.code_diff ?? null) : null,
          continuationRef: includeContinuation ? (context?.continuation_ref ?? null) : null,
          generatedAt: context?.published_at ?? snapshot.session.updatedAt,
        } satisfies SessionFabricContextBundle;
      });

      const readEvents = Effect.fn("session_fabric.read_events")(function* (
        sessionId: SessionFabricSessionId,
        afterEventSequence: number,
      ) {
        const cursor = yield* sql.exec<EventRow>(
          "SELECT stream_sequence, payload_json FROM session_events WHERE stream_sequence > ? ORDER BY stream_sequence ASC",
          afterEventSequence,
        );
        const rows = yield* cursor.toArray();
        const events = rows.map((row) => ({
          sequence: row.stream_sequence,
          published: decodePublishedEvent(row.payload_json),
        }));
        const lastEvent = events.at(-1);
        return {
          sessionId,
          afterEventSequence,
          events,
          nextEventSequence: lastEvent?.sequence ?? afterEventSequence,
        } satisfies SessionFabricEventBatch;
      });

      const socketsForRole = Effect.fn("session_fabric.sockets_for_role")(function* (
        role: SocketAttachment["role"],
      ) {
        const sockets = yield* state.getWebSockets();
        const current: Array<Cloudflare.WebSocket> = [];
        for (const socket of sockets) {
          const attachment = socket.deserializeAttachment<SocketAttachment>();
          if (attachment?.role !== role) continue;
          if (!(yield* capabilityIsCurrent(attachment.capability))) {
            yield* socket.close(
              SESSION_FABRIC_AUTHENTICATION_CLOSE_CODE,
              "Session fabric capability expired",
            );
            continue;
          }
          current.push(socket);
        }
        return current;
      });

      const eligibleRunners = Effect.fn("session_fabric.eligible_runners")(function* (
        snapshot: SessionFabricSnapshot,
        meta: MetaRow,
      ) {
        const eligible: Array<Cloudflare.WebSocket> = [];
        for (const runner of yield* socketsForRole("runner")) {
          const attachment = runner.deserializeAttachment<SocketAttachment>();
          if (
            attachment !== null &&
            isCurrentRunnerAttachment({
              attachmentGeneration: attachment.runnerGeneration,
              attachmentRunnerId: attachment.peerId,
              currentGeneration: meta.runner_generation,
              currentRunnerId: meta.runner_id,
            }) &&
            (verifierConfig?.mode === "disabled" ||
              (attachment.capability?.role === "runner" &&
                ((isPublicScaffoldLocation(snapshot.session.location) &&
                  !isLocalSessionFabricCapability(attachment.capability) &&
                  attachment.capability.scaffoldSessionId ===
                    snapshot.session.location.scaffoldSessionId &&
                  attachment.capability.scaffoldLifecycleEpoch ===
                    snapshot.session.location.scaffoldLifecycleEpoch) ||
                  (isPublicLocalLocation(snapshot.session.location) &&
                    isLocalSessionFabricCapability(attachment.capability) &&
                    localCapabilityMatchesPinnedMeta({
                      capability: attachment.capability,
                      sessionId: snapshot.session.sessionId,
                      location: snapshot.session.location,
                      meta,
                    })))))
          ) {
            eligible.push(runner);
          }
        }
        return eligible;
      });

      const broadcast = Effect.fn("session_fabric.broadcast")(function* (
        role: SocketAttachment["role"],
        frame: SessionFabricServerFrame,
      ) {
        const payload = encodeFrame(frame);
        const snapshot = role === "client" ? yield* readSnapshot() : null;
        for (const socket of yield* socketsForRole(role)) {
          const attachment = socket.deserializeAttachment<SocketAttachment>();
          if (
            role === "client" &&
            (attachment === null ||
              snapshot === null ||
              !(yield* canReadSnapshot(attachment.capability, snapshot)))
          ) {
            yield* socket.close(
              SESSION_FABRIC_PERMISSION_CLOSE_CODE,
              "Session read capability denied",
            );
            continue;
          }
          yield* socket.send(payload);
        }
      });

      const armMaintenanceAlarm = Effect.fn("session_fabric.arm_maintenance_alarm")(function* () {
        const cursor = yield* sql.exec<{
          readonly directory_due_at: number | null;
          readonly wake_due_at: number | null;
          readonly pause_due_at: number | null;
        }>(
          "SELECT directory_due_at, wake_due_at, pause_due_at FROM session_maintenance WHERE id = 1",
        );
        const maintenance = yield* cursor.one();
        const dueAt = nextSessionFabricMaintenanceDueAt({
          directoryDueAt: maintenance.directory_due_at,
          wakeDueAt: maintenance.wake_due_at,
          pauseDueAt: maintenance.pause_due_at,
        });
        if (dueAt !== null) yield* state.storage.setAlarm(dueAt);
      });

      const scheduleDirectoryUpdate = Effect.fn("session_fabric.schedule_directory_update")(
        function* () {
          const dueAt = (yield* Clock.currentTimeMillis) + 2_000;
          yield* sql
            .exec("UPDATE session_maintenance SET directory_due_at = ? WHERE id = 1", dueAt)
            .pipe(Effect.asVoid);
          yield* armMaintenanceAlarm().pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("session fabric directory update could not be scheduled", {
                cause,
              }),
            ),
          );
        },
      );

      const updateDirectory = Effect.gen(function* () {
        const snapshot = yield* readSnapshot();
        if (snapshot === null) return;
        yield* directory
          .getByName("public-session-directory")
          .upsert(snapshot)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("session fabric directory update failed", {
                sessionId: snapshot.session.sessionId,
                cause,
              }),
            ),
          );
      });

      const setRunnerState = Effect.fn("session_fabric.set_runner_state")(function* (
        runnerState: "online" | "offline",
      ) {
        yield* sql
          .exec("UPDATE session_meta SET runner_state = ? WHERE id = 1", runnerState)
          .pipe(Effect.asVoid);
        const snapshot = yield* readSnapshot();
        if (snapshot !== null && snapshot.session.runnerState !== runnerState) {
          yield* sql
            .exec(
              "UPDATE session_meta SET snapshot_json = ? WHERE id = 1",
              encodeSnapshot({
                ...snapshot,
                session: { ...snapshot.session, runnerState },
              }),
            )
            .pipe(Effect.asVoid);
        }
        yield* scheduleDirectoryUpdate();
        const updatedAt = yield* currentIso;
        yield* broadcast("client", {
          type: "runner.state",
          state: runnerState,
          updatedAt,
        });
      });

      const storeReceipt = Effect.fn("session_fabric.store_receipt")(function* (
        receipt: SessionFabricCommandReceipt,
      ) {
        const existing = yield* sql
          .exec<CommandRow>(
            "SELECT command_id, payload_json, status, result_sequence, detail, updated_at FROM session_commands WHERE command_id = ? LIMIT 1",
            receipt.commandId,
          )
          .pipe(
            Effect.flatMap((cursor) => cursor.toArray()),
            Effect.map((rows) => rows.at(0)),
          );
        if (existing === undefined || !shouldReplayCommand(existing.status)) return;
        yield* sql
          .exec(
            "UPDATE session_commands SET status = ?, result_sequence = ?, detail = ?, updated_at = ? WHERE command_id = ?",
            receipt.status,
            receipt.resultSequence,
            receipt.detail,
            receipt.updatedAt,
            receipt.commandId,
          )
          .pipe(Effect.asVoid);
        if (receipt.status === "accepted" || receipt.status === "rejected") {
          yield* sql
            .exec(
              "UPDATE session_command_wakes SET status = ?, next_attempt_at = NULL, detail = ?, updated_at = ? WHERE command_id = ?",
              receipt.status === "accepted" ? "completed" : "failed",
              receipt.detail,
              receipt.updatedAt,
              receipt.commandId,
            )
            .pipe(Effect.asVoid);
        }
        yield* broadcast("client", { type: "command.receipt", receipt });
      });

      const readWake = Effect.fn("session_fabric.read_wake")(function* (commandId: string) {
        const cursor = yield* sql.exec<WakeRow>(
          "SELECT command_id, environment_id, thread_id, scaffold_session_id, expected_lifecycle_epoch, target_lifecycle_epoch, actor_id, status, attempt_count, next_attempt_at, detail, updated_at FROM session_command_wakes WHERE command_id = ? LIMIT 1",
          commandId,
        );
        return (yield* cursor.toArray()).at(0);
      });

      const readSharedWake = Effect.fn("session_fabric.read_shared_wake")(function* (
        environmentId: string,
        threadId: string,
        scaffoldSessionId: string,
        expectedLifecycleEpoch: number,
      ) {
        const cursor = yield* sql.exec<WakeRow>(
          "SELECT command_id, environment_id, thread_id, scaffold_session_id, expected_lifecycle_epoch, target_lifecycle_epoch, actor_id, status, attempt_count, next_attempt_at, detail, updated_at FROM session_command_wakes WHERE environment_id = ? AND thread_id = ? AND scaffold_session_id = ? AND expected_lifecycle_epoch = ? AND status IN ('pending', 'retrying', 'joining', 'awaiting_snapshot', 'ready') ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'retrying' THEN 1 WHEN 'awaiting_snapshot' THEN 2 WHEN 'ready' THEN 3 ELSE 4 END, rowid ASC LIMIT 1",
          environmentId,
          threadId,
          scaffoldSessionId,
          expectedLifecycleEpoch,
        );
        const row = (yield* cursor.toArray()).at(0);
        return row !== undefined &&
          scaffoldWakeIdentityMatches({
            wakeEnvironmentId: row.environment_id,
            wakeThreadId: row.thread_id,
            wakeScaffoldSessionId: row.scaffold_session_id,
            wakeExpectedLifecycleEpoch: row.expected_lifecycle_epoch,
            environmentId,
            threadId,
            scaffoldSessionId,
            expectedLifecycleEpoch,
          })
          ? row
          : undefined;
      });

      const scheduleWakeRetry = Effect.fn("session_fabric.schedule_wake_retry")(function* (
        dueAt: number,
      ) {
        yield* sql
          .exec(
            "UPDATE session_maintenance SET wake_due_at = CASE WHEN wake_due_at IS NULL OR wake_due_at > ? THEN ? ELSE wake_due_at END WHERE id = 1",
            dueAt,
            dueAt,
          )
          .pipe(Effect.asVoid);
        yield* armMaintenanceAlarm();
      });

      const failWake = Effect.fn("session_fabric.fail_wake")(function* (
        row: WakeRow,
        detail: string,
      ) {
        const commandCursor =
          row.environment_id === null || row.thread_id === null
            ? yield* sql.exec<CommandRow>(
                "SELECT command_id, payload_json, status, result_sequence, detail, updated_at FROM session_commands WHERE command_id = ? LIMIT 1",
                row.command_id,
              )
            : yield* sql.exec<CommandRow>(
                "SELECT command_id, payload_json, status, result_sequence, detail, updated_at FROM session_commands WHERE command_id IN (SELECT command_id FROM session_command_wakes WHERE environment_id = ? AND thread_id = ? AND scaffold_session_id = ? AND expected_lifecycle_epoch = ? AND status IN ('pending', 'retrying', 'joining', 'awaiting_snapshot', 'ready')) ORDER BY rowid ASC",
                row.environment_id,
                row.thread_id,
                row.scaffold_session_id,
                row.expected_lifecycle_epoch,
              );
        for (const commandRow of yield* commandCursor.toArray()) {
          if (!shouldReplayCommand(commandRow.status)) continue;
          const command = decodeCommand(commandRow.payload_json);
          yield* storeReceipt({
            sessionId: command.sessionId,
            commandId: command.commandId,
            status: "rejected",
            resultSequence: null,
            detail,
            updatedAt: yield* currentIso,
          });
        }
      });

      const requestScaffoldWake = Effect.fn("session_fabric.request_scaffold_wake")(function* (
        commandId: string,
      ) {
        const row = yield* readWake(commandId);
        if (row === undefined || !scaffoldWakeRequestsAuthority(row.status)) return;
        if (row.environment_id === null || row.thread_id === null) {
          return yield* failWake(row, "Scaffold wake identity is unavailable");
        }
        const environmentId = row.environment_id;
        const threadId = row.thread_id;
        const commandCursor = yield* sql.exec<CommandRow>(
          "SELECT command_id, payload_json, status, result_sequence, detail, updated_at FROM session_commands WHERE command_id = ? LIMIT 1",
          row.command_id,
        );
        const commandRow = (yield* commandCursor.toArray()).at(0);
        const settlementEventId = settlementEventIdFromCompensationCommand(row.command_id);
        const pauseCursor =
          settlementEventId === null
            ? null
            : yield* sql.exec<SettlePauseRow>(
                "SELECT settlement_event_id, fabric_session_id, environment_id, thread_id, scaffold_session_id, expected_lifecycle_epoch, target_lifecycle_epoch, status, attempt_count, next_attempt_at, detail, updated_at FROM session_settle_pauses WHERE settlement_event_id = ? AND status = 'compensating' LIMIT 1",
                settlementEventId,
              );
        const pause = pauseCursor === null ? undefined : (yield* pauseCursor.toArray()).at(0);
        if (
          (commandRow === undefined || !shouldReplayCommand(commandRow.status)) &&
          pause === undefined
        )
          return;
        const command = commandRow === undefined ? null : decodeCommand(commandRow.payload_json);
        const fabricSessionId = command?.sessionId ?? pause?.fabric_session_id;
        if (fabricSessionId === undefined) return;
        const attemptCount = row.attempt_count + 1;
        const result = yield* Effect.promise(() =>
          wakeScaffoldSession(wakeAuthorityConfig, {
            fabricSessionId,
            commandId: row.command_id,
            environmentId,
            threadId,
            scaffoldSessionId: row.scaffold_session_id,
            expectedLifecycleEpoch: row.expected_lifecycle_epoch,
            actorId: row.actor_id,
          }),
        );
        const updatedAt = yield* currentIso;
        if (result.ok) {
          const targetLifecycleEpoch = result.response.targetLifecycleEpoch;
          const nextAttemptAt = scaffoldWakeHasAttemptsRemaining(attemptCount)
            ? (yield* Clock.currentTimeMillis) + scaffoldWakeRetryDelayMs(attemptCount)
            : null;
          yield* sql
            .exec(
              "UPDATE session_command_wakes SET target_lifecycle_epoch = ?, status = 'awaiting_snapshot', attempt_count = ?, next_attempt_at = ?, detail = NULL, updated_at = ? WHERE command_id = ? AND status IN ('pending', 'retrying', 'awaiting_snapshot')",
              targetLifecycleEpoch,
              attemptCount,
              nextAttemptAt,
              updatedAt,
              row.command_id,
            )
            .pipe(Effect.asVoid);
          yield* sql
            .exec(
              "UPDATE session_command_wakes SET target_lifecycle_epoch = ?, status = 'awaiting_snapshot', attempt_count = ?, next_attempt_at = NULL, detail = NULL, updated_at = ? WHERE environment_id = ? AND thread_id = ? AND scaffold_session_id = ? AND expected_lifecycle_epoch = ? AND status = 'joining'",
              targetLifecycleEpoch,
              attemptCount,
              updatedAt,
              row.environment_id,
              row.thread_id,
              row.scaffold_session_id,
              row.expected_lifecycle_epoch,
            )
            .pipe(Effect.asVoid);
          const snapshot = yield* readSnapshot();
          const meta = yield* readMeta();
          if (
            snapshot !== null &&
            snapshotProvesScaffoldWakeTarget({
              wakeFabricSessionId: fabricSessionId,
              wakeEnvironmentId: row.environment_id,
              wakeThreadId: row.thread_id,
              wakeScaffoldSessionId: row.scaffold_session_id,
              wakeTargetLifecycleEpoch: targetLifecycleEpoch,
              snapshotFabricSessionId: snapshot.session.sessionId,
              snapshotEnvironmentKind: snapshot.session.location.environmentKind,
              snapshotEnvironmentId: snapshot.session.location.environmentId,
              snapshotThreadId: snapshot.session.location.threadId,
              snapshotScaffoldSessionId: snapshot.session.location.scaffoldSessionId,
              snapshotLifecycleEpoch: snapshot.session.location.scaffoldLifecycleEpoch,
              runnerGeneration: meta.runner_generation,
            })
          ) {
            yield* sql
              .exec(
                "UPDATE session_command_wakes SET status = 'ready', next_attempt_at = NULL, detail = NULL, updated_at = ? WHERE environment_id = ? AND thread_id = ? AND scaffold_session_id = ? AND expected_lifecycle_epoch = ? AND status = 'awaiting_snapshot'",
                updatedAt,
                row.environment_id,
                row.thread_id,
                row.scaffold_session_id,
                row.expected_lifecycle_epoch,
              )
              .pipe(Effect.asVoid);
            if (pause !== undefined) {
              yield* sql
                .exec(
                  "UPDATE session_settle_pauses SET status = 'completed', target_lifecycle_epoch = ?, next_attempt_at = NULL, detail = NULL, updated_at = ? WHERE settlement_event_id = ? AND status = 'compensating'",
                  targetLifecycleEpoch,
                  updatedAt,
                  pause.settlement_event_id,
                )
                .pipe(Effect.asVoid);
              yield* sql
                .exec(
                  "UPDATE session_command_wakes SET status = 'completed' WHERE command_id = ?",
                  row.command_id,
                )
                .pipe(Effect.asVoid);
            }
            yield* dispatchPendingCommands();
            return;
          }
          if (nextAttemptAt !== null) {
            yield* scheduleWakeRetry(nextAttemptAt);
            return;
          }
          const detail = `Scaffold runner did not publish lifecycle epoch ${targetLifecycleEpoch} after ${SESSION_FABRIC_WAKE_MAX_ATTEMPTS} wake attempts.`;
          if (pause !== undefined) {
            yield* sql
              .exec(
                "UPDATE session_settle_pauses SET status = 'failed', next_attempt_at = NULL, detail = ?, updated_at = ? WHERE settlement_event_id = ?",
                detail,
                updatedAt,
                pause.settlement_event_id,
              )
              .pipe(Effect.asVoid);
            yield* sql
              .exec(
                "UPDATE session_command_wakes SET status = 'failed', next_attempt_at = NULL, detail = ?, updated_at = ? WHERE command_id = ?",
                detail,
                updatedAt,
                row.command_id,
              )
              .pipe(Effect.asVoid);
          } else {
            yield* failWake(row, detail);
          }
          return;
        }
        if (
          result.classification === "retryable" &&
          scaffoldWakeHasAttemptsRemaining(attemptCount)
        ) {
          const dueAt = (yield* Clock.currentTimeMillis) + scaffoldWakeRetryDelayMs(attemptCount);
          yield* sql
            .exec(
              "UPDATE session_command_wakes SET status = CASE WHEN status = 'awaiting_snapshot' THEN status ELSE 'retrying' END, attempt_count = ?, next_attempt_at = ?, detail = ?, updated_at = ? WHERE command_id = ?",
              attemptCount,
              dueAt,
              result.message,
              updatedAt,
              row.command_id,
            )
            .pipe(Effect.asVoid);
          yield* scheduleWakeRetry(dueAt);
          return;
        }
        if (pause !== undefined) {
          yield* sql
            .exec(
              "UPDATE session_settle_pauses SET status = 'failed', next_attempt_at = NULL, detail = ?, updated_at = ? WHERE settlement_event_id = ?",
              result.message,
              updatedAt,
              pause.settlement_event_id,
            )
            .pipe(Effect.asVoid);
          yield* sql
            .exec(
              "UPDATE session_command_wakes SET status = 'failed', next_attempt_at = NULL, detail = ?, updated_at = ? WHERE command_id = ?",
              result.message,
              updatedAt,
              row.command_id,
            )
            .pipe(Effect.asVoid);
        } else {
          yield* failWake(row, result.message);
        }
      });

      const readActiveSettlePause = Effect.fn("session_fabric.read_active_settle_pause")(
        function* () {
          const cursor = yield* sql.exec<SettlePauseRow>(
            "SELECT settlement_event_id, fabric_session_id, environment_id, thread_id, scaffold_session_id, expected_lifecycle_epoch, target_lifecycle_epoch, status, attempt_count, next_attempt_at, detail, updated_at FROM session_settle_pauses WHERE status IN ('pending', 'in_flight', 'cancel_requested') ORDER BY rowid DESC LIMIT 1",
          );
          return (yield* cursor.toArray()).at(0);
        },
      );

      const readSettlePauseWakeProof = Effect.fn("session_fabric.read_settle_pause_wake_proof")(
        function* (input: {
          readonly fabricSessionId: string;
          readonly environmentId: string;
          readonly threadId: string;
          readonly scaffoldSessionId: string;
          readonly expectedLifecycleEpoch: number;
          readonly targetLifecycleEpoch: number;
        }) {
          const cursor = yield* sql.exec<SettlePauseRow>(
            "SELECT settlement_event_id, fabric_session_id, environment_id, thread_id, scaffold_session_id, expected_lifecycle_epoch, target_lifecycle_epoch, status, attempt_count, next_attempt_at, detail, updated_at FROM session_settle_pauses WHERE fabric_session_id = ? AND environment_id = ? AND thread_id = ? AND scaffold_session_id = ? AND expected_lifecycle_epoch = ? AND target_lifecycle_epoch = ? AND status IN ('completed', 'compensating') LIMIT 1",
            input.fabricSessionId,
            input.environmentId,
            input.threadId,
            input.scaffoldSessionId,
            input.expectedLifecycleEpoch,
            input.targetLifecycleEpoch,
          );
          return (yield* cursor.toArray()).at(0);
        },
      );

      const requestSettlePause = Effect.fn("session_fabric.request_settle_pause")(function* (
        settlementEventId: string,
      ) {
        const cursor = yield* sql.exec<SettlePauseRow>(
          "SELECT settlement_event_id, fabric_session_id, environment_id, thread_id, scaffold_session_id, expected_lifecycle_epoch, target_lifecycle_epoch, status, attempt_count, next_attempt_at, detail, updated_at FROM session_settle_pauses WHERE settlement_event_id = ? LIMIT 1",
          settlementEventId,
        );
        const row = (yield* cursor.toArray()).at(0);
        if (
          row === undefined ||
          (row.status !== "pending" &&
            row.status !== "in_flight" &&
            row.status !== "cancel_requested")
        )
          return;
        const snapshot = yield* readSnapshot();
        if (
          snapshot === null ||
          snapshot.session.sessionId !== row.fabric_session_id ||
          snapshot.session.location.environmentKind !== "scaffold" ||
          snapshot.session.location.environmentId !== row.environment_id ||
          snapshot.session.location.threadId !== row.thread_id ||
          snapshot.session.location.scaffoldSessionId !== row.scaffold_session_id ||
          snapshot.session.location.scaffoldLifecycleEpoch !== row.expected_lifecycle_epoch
        ) {
          yield* sql
            .exec(
              "UPDATE session_settle_pauses SET status = 'failed', next_attempt_at = NULL, detail = 'Stale Scaffold lifecycle epoch', updated_at = ? WHERE settlement_event_id = ?",
              yield* currentIso,
              row.settlement_event_id,
            )
            .pipe(Effect.asVoid);
          yield* sql
            .exec(
              "DELETE FROM session_command_wakes WHERE status = 'joining_pause' AND environment_id = ? AND thread_id = ? AND scaffold_session_id = ?",
              row.environment_id,
              row.thread_id,
              row.scaffold_session_id,
            )
            .pipe(Effect.asVoid);
          yield* dispatchPendingCommands();
          return;
        }
        const attemptCount = row.attempt_count + 1;
        const updatedAt = yield* currentIso;
        yield* sql
          .exec(
            "UPDATE session_settle_pauses SET status = CASE WHEN status = 'cancel_requested' THEN status ELSE 'in_flight' END, attempt_count = ?, next_attempt_at = NULL, updated_at = ? WHERE settlement_event_id = ? AND status IN ('pending', 'in_flight', 'cancel_requested')",
            attemptCount,
            updatedAt,
            row.settlement_event_id,
          )
          .pipe(Effect.asVoid);
        const result = yield* Effect.promise(() =>
          pauseSettledScaffoldSession(settlePauseAuthorityConfig, {
            fabricSessionId: row.fabric_session_id,
            settlementEventId: row.settlement_event_id,
            environmentId: row.environment_id,
            threadId: row.thread_id,
            scaffoldSessionId: row.scaffold_session_id,
            expectedLifecycleEpoch: row.expected_lifecycle_epoch,
          }),
        );
        if (result.ok) {
          const lifecycleAuthority = settlePauseLifecycleAuthority({
            currentLifecycleEpoch: (yield* readMeta()).runner_generation,
            expectedLifecycleEpoch: row.expected_lifecycle_epoch,
            targetLifecycleEpoch: result.response.targetLifecycleEpoch,
          });
          if (lifecycleAuthority === null) {
            yield* sql
              .exec(
                "UPDATE session_settle_pauses SET status = 'failed', next_attempt_at = NULL, detail = 'Stale Scaffold lifecycle epoch', updated_at = ? WHERE settlement_event_id = ?",
                updatedAt,
                row.settlement_event_id,
              )
              .pipe(Effect.asVoid);
            return;
          }
          const latestPause = yield* readActiveSettlePause();
          const cancellationRequested =
            latestPause?.settlement_event_id === row.settlement_event_id &&
            latestPause.status === "cancel_requested";
          const joinedCursor = yield* sql.exec<{ readonly count: number }>(
            "SELECT COUNT(*) AS count FROM session_command_wakes WHERE status = 'joining_pause' AND environment_id = ? AND thread_id = ? AND scaffold_session_id = ? AND expected_lifecycle_epoch = ?",
            row.environment_id,
            row.thread_id,
            row.scaffold_session_id,
            result.response.targetLifecycleEpoch,
          );
          const joinedCommandCount = (yield* joinedCursor.one()).count;
          const needsCompensatingWake = settlePauseNeedsCompensatingWake({
            cancellationRequested,
            joinedCommandCount,
          });
          const compensationCommandId = settlePauseCompensationCommandId(row.settlement_event_id);
          const wakeDueAt = yield* Clock.currentTimeMillis;
          const offlineSnapshot = encodeSnapshot({
            ...snapshot,
            session: { ...snapshot.session, runnerState: "offline" },
          });
          state.raw.storage.transactionSync(() => {
            sql.raw.exec(
              "UPDATE session_meta SET runner_generation = ?, runner_state = 'offline', snapshot_json = ? WHERE id = 1 AND runner_generation = ?",
              lifecycleAuthority,
              offlineSnapshot,
              row.expected_lifecycle_epoch,
            );
            sql.raw.exec(
              "UPDATE session_settle_pauses SET status = ?, target_lifecycle_epoch = ?, next_attempt_at = NULL, detail = NULL, updated_at = ? WHERE settlement_event_id = ?",
              needsCompensatingWake ? "compensating" : "completed",
              result.response.targetLifecycleEpoch,
              updatedAt,
              row.settlement_event_id,
            );
            if (needsCompensatingWake) {
              sql.raw.exec(
                "INSERT OR IGNORE INTO session_command_wakes (command_id, environment_id, thread_id, scaffold_session_id, expected_lifecycle_epoch, target_lifecycle_epoch, actor_id, status, attempt_count, next_attempt_at, detail, updated_at) VALUES (?, ?, ?, ?, ?, NULL, 'session-fabric-settlement', 'pending', 0, ?, NULL, ?)",
                compensationCommandId,
                row.environment_id,
                row.thread_id,
                row.scaffold_session_id,
                result.response.targetLifecycleEpoch,
                wakeDueAt,
                updatedAt,
              );
            }
            sql.raw.exec(
              "UPDATE session_command_wakes SET status = CASE WHEN rowid = (SELECT MIN(rowid) FROM session_command_wakes WHERE status = 'joining_pause' AND environment_id = ? AND thread_id = ? AND scaffold_session_id = ? AND expected_lifecycle_epoch = ?) THEN 'pending' ELSE 'joining' END, next_attempt_at = CASE WHEN rowid = (SELECT MIN(rowid) FROM session_command_wakes WHERE status = 'joining_pause' AND environment_id = ? AND thread_id = ? AND scaffold_session_id = ? AND expected_lifecycle_epoch = ?) THEN ? ELSE NULL END, detail = NULL, updated_at = ? WHERE status = 'joining_pause' AND environment_id = ? AND thread_id = ? AND scaffold_session_id = ? AND expected_lifecycle_epoch = ?",
              row.environment_id,
              row.thread_id,
              row.scaffold_session_id,
              result.response.targetLifecycleEpoch,
              row.environment_id,
              row.thread_id,
              row.scaffold_session_id,
              result.response.targetLifecycleEpoch,
              wakeDueAt,
              updatedAt,
              row.environment_id,
              row.thread_id,
              row.scaffold_session_id,
              result.response.targetLifecycleEpoch,
            );
            sql.raw.exec(
              "UPDATE session_maintenance SET wake_due_at = CASE WHEN wake_due_at IS NULL OR wake_due_at > ? THEN ? ELSE wake_due_at END WHERE id = 1",
              wakeDueAt,
              wakeDueAt,
            );
          });
          yield* setRunnerState("offline");
          const follower = yield* sql.exec<{ readonly command_id: string }>(
            "SELECT command_id FROM session_command_wakes WHERE status = 'pending' AND environment_id = ? AND thread_id = ? AND scaffold_session_id = ? AND expected_lifecycle_epoch = ? ORDER BY rowid ASC LIMIT 1",
            row.environment_id,
            row.thread_id,
            row.scaffold_session_id,
            result.response.targetLifecycleEpoch,
          );
          const command = (yield* follower.toArray()).at(0);
          if (command !== undefined) yield* requestScaffoldWake(command.command_id);
          return;
        }
        if (
          result.classification === "retryable" &&
          scaffoldWakeHasAttemptsRemaining(attemptCount)
        ) {
          const dueAt = (yield* Clock.currentTimeMillis) + scaffoldWakeRetryDelayMs(attemptCount);
          yield* sql
            .exec(
              "UPDATE session_settle_pauses SET next_attempt_at = ?, detail = ?, updated_at = ? WHERE settlement_event_id = ? AND status IN ('in_flight', 'cancel_requested')",
              dueAt,
              result.message,
              updatedAt,
              row.settlement_event_id,
            )
            .pipe(Effect.asVoid);
          yield* sql
            .exec("UPDATE session_maintenance SET pause_due_at = ? WHERE id = 1", dueAt)
            .pipe(Effect.asVoid);
          yield* armMaintenanceAlarm();
          return;
        }
        yield* sql
          .exec(
            "UPDATE session_settle_pauses SET status = 'failed', next_attempt_at = NULL, detail = ?, updated_at = ? WHERE settlement_event_id = ?",
            result.message,
            updatedAt,
            row.settlement_event_id,
          )
          .pipe(Effect.asVoid);
        yield* sql
          .exec(
            "DELETE FROM session_command_wakes WHERE status = 'joining_pause' AND environment_id = ? AND thread_id = ? AND scaffold_session_id = ?",
            row.environment_id,
            row.thread_id,
            row.scaffold_session_id,
          )
          .pipe(Effect.asVoid);
        yield* dispatchPendingCommands();
      });

      const rejectPendingCommands = Effect.fn("session_fabric.reject_pending_commands")(function* (
        detail: string,
      ) {
        const cursor = yield* sql.exec<CommandRow>(
          "SELECT command_id, payload_json, status, result_sequence, detail, updated_at FROM session_commands WHERE status IN ('queued', 'delivered') ORDER BY rowid ASC",
        );
        for (const row of yield* cursor.toArray()) {
          const wake = yield* readWake(row.command_id);
          if (wake !== undefined && scaffoldWakeKeepsCommandPending(wake.status)) continue;
          const command = decodeCommand(row.payload_json);
          yield* storeReceipt({
            sessionId: command.sessionId,
            commandId: command.commandId,
            status: "rejected",
            resultSequence: null,
            detail,
            updatedAt: yield* currentIso,
          });
        }
      });

      const dispatchPendingCommands = Effect.fn("session_fabric.dispatch_pending_commands")(
        function* () {
          const snapshot = yield* readSnapshot();
          if (snapshot === null) return;
          const meta = yield* readMeta();
          const runners = yield* eligibleRunners(snapshot, meta);
          const runner = runners.at(0);
          if (runner === undefined || meta.runner_state !== "online") {
            return yield* rejectPendingCommands("Session runner is offline");
          }
          const cursor = yield* sql.exec<CommandRow>(
            "SELECT command_id, payload_json, status, result_sequence, detail, updated_at FROM session_commands WHERE status IN ('queued', 'delivered') ORDER BY rowid ASC",
          );
          for (const row of yield* cursor.toArray()) {
            if (!shouldReplayCommand(row.status)) continue;
            const command = decodeCommand(row.payload_json);
            const wake = yield* readWake(row.command_id);
            if (wake !== undefined) {
              if (
                wake.environment_id === null ||
                wake.thread_id === null ||
                wake.status !== "ready" ||
                !snapshotProvesScaffoldWakeTarget({
                  wakeFabricSessionId: command.sessionId,
                  wakeEnvironmentId: wake.environment_id,
                  wakeThreadId: wake.thread_id,
                  wakeScaffoldSessionId: wake.scaffold_session_id,
                  wakeTargetLifecycleEpoch: wake.target_lifecycle_epoch,
                  snapshotFabricSessionId: snapshot.session.sessionId,
                  snapshotEnvironmentKind: snapshot.session.location.environmentKind,
                  snapshotEnvironmentId: snapshot.session.location.environmentId,
                  snapshotThreadId: snapshot.session.location.threadId,
                  snapshotScaffoldSessionId: snapshot.session.location.scaffoldSessionId,
                  snapshotLifecycleEpoch: snapshot.session.location.scaffoldLifecycleEpoch,
                  runnerGeneration: meta.runner_generation,
                })
              ) {
                continue;
              }
            }
            const frame = encodeFrame({ type: "command.dispatch", command });
            const sent = yield* runner.send(frame).pipe(Effect.result);
            if (sent._tag === "Failure") {
              if (wake !== undefined && scaffoldWakeKeepsCommandPending(wake.status)) {
                yield* setRunnerState("offline");
                yield* rejectPendingCommands("Session runner disconnected");
                break;
              }
              yield* storeReceipt({
                sessionId: command.sessionId,
                commandId: command.commandId,
                status: "rejected",
                resultSequence: null,
                detail: "Session runner disconnected",
                updatedAt: yield* currentIso,
              });
              continue;
            }
            if (row.status === "queued") {
              const updatedAt = yield* currentIso;
              yield* storeReceipt({
                sessionId: command.sessionId,
                commandId: command.commandId,
                status: "delivered",
                resultSequence: null,
                detail: null,
                updatedAt,
              });
            }
          }
        },
      );

      const synchronizeClient = Effect.fn("session_fabric.synchronize_client")(function* (
        socket: Cloudflare.WebSocket,
        sessionId: SessionFabricSessionId,
        afterEventSequence: number,
        capability: SessionFabricCapabilityClaims | null,
      ) {
        const snapshot = yield* readSnapshot();
        if (snapshot === null || !(yield* canReadSnapshot(capability, snapshot))) {
          return yield* socket.close(
            SESSION_FABRIC_PERMISSION_CLOSE_CODE,
            "Session read capability required",
          );
        }
        yield* socket.send(encodeFrame({ type: "session.snapshot", snapshot }));
        const batch = yield* readEvents(sessionId, afterEventSequence);
        for (const event of batch.events) {
          yield* socket.send(
            encodeFrame({
              type: "session.event",
              sequence: event.sequence,
              published: event.published,
            }),
          );
        }
        const meta = yield* readMeta();
        const synchronizedAt = yield* currentIso;
        yield* socket.send(
          encodeFrame({
            type: "session.synchronized",
            cursor: {
              eventSequence: yield* currentEventSequence(),
              snapshotSequence: meta.snapshot_sequence,
            },
          }),
        );
        yield* socket.send(
          encodeFrame({
            type: "runner.state",
            state: meta.runner_state as "online" | "offline",
            updatedAt: synchronizedAt,
          }),
        );
      });

      const handleRunnerHello = Effect.fn("session_fabric.handle_runner_hello")(function* (
        socket: Cloudflare.WebSocket,
        expectedSessionId: string,
        frame: Extract<SessionFabricClientFrame, { type: "runner.hello" }>,
      ) {
        if (frame.hello.sessionId !== expectedSessionId) {
          return yield* socket.close(
            SESSION_FABRIC_PERMISSION_CLOSE_CODE,
            "Session identity mismatch",
          );
        }
        const attachment = socket.deserializeAttachment<SocketAttachment>();
        if (
          attachment === null ||
          (verifierConfig?.mode !== "disabled" &&
            (attachment.capability === null ||
              !capabilityCanRunSession(attachment.capability, frame.hello)))
        ) {
          return yield* socket.close(
            SESSION_FABRIC_PERMISSION_CLOSE_CODE,
            "Runner capability mismatch",
          );
        }
        const meta = yield* readMeta();
        const localCapability =
          attachment.capability?.role === "runner" &&
          isLocalSessionFabricCapability(attachment.capability)
            ? attachment.capability
            : null;
        if (!localAuthorityColumnsAreConsistent(meta)) {
          return yield* socket.close(
            SESSION_FABRIC_PERMISSION_CLOSE_CODE,
            "Session authority is inconsistent",
          );
        }
        if (localCapability !== null) {
          const pinned = completeLocalAuthority(meta);
          if (
            !localRunnerCanClaimPinnedAuthority({
              claims: localCapability,
              hello: frame.hello,
              pinned,
              sessionAlreadyClaimed: meta.session_id !== null,
            })
          ) {
            return yield* socket.close(
              SESSION_FABRIC_PERMISSION_CLOSE_CODE,
              "Local session authority mismatch",
            );
          }
        } else if (meta.environment_kind !== null) {
          return yield* socket.close(
            SESSION_FABRIC_PERMISSION_CLOSE_CODE,
            "Session authority kind mismatch",
          );
        }
        if (
          !runnerHelloMatchesLease({
            currentGeneration: meta.runner_generation,
            currentRunnerId: meta.runner_id,
            incomingGeneration: frame.hello.runnerGeneration,
            incomingRunnerId: frame.hello.runnerId,
          })
        ) {
          return yield* socket.close(
            SESSION_FABRIC_PERMISSION_CLOSE_CODE,
            "Stale runner generation",
          );
        }
        if (frame.hello.runnerGeneration > meta.runner_generation) {
          yield* rejectPendingCommands("Runner generation changed");
        }
        yield* (
          localCapability === null
            ? sql.exec(
                "UPDATE session_meta SET session_id = ?, runner_id = ?, runner_generation = ?, runner_state = 'online' WHERE id = 1",
                frame.hello.sessionId,
                frame.hello.runnerId,
                frame.hello.runnerGeneration,
              )
            : sql.exec(
                "UPDATE session_meta SET session_id = ?, runner_id = ?, runner_generation = ?, runner_state = 'online', environment_kind = 'local', environment_id = ?, thread_id = ?, actor_id = ? WHERE id = 1",
                frame.hello.sessionId,
                frame.hello.runnerId,
                frame.hello.runnerGeneration,
                localCapability.environmentId,
                localCapability.threadId,
                localCapability.actorId,
              )
        ).pipe(Effect.asVoid);
        socket.serializeAttachment<SocketAttachment>({
          role: "runner",
          sessionId: expectedSessionId,
          peerId: frame.hello.runnerId,
          runnerGeneration: frame.hello.runnerGeneration,
          capability: attachment.capability,
        });
        yield* setRunnerState("online");
        yield* dispatchPendingCommands();
      });

      const handleClientHello = Effect.fn("session_fabric.handle_client_hello")(function* (
        socket: Cloudflare.WebSocket,
        expectedSessionId: string,
        frame: Extract<SessionFabricClientFrame, { type: "client.hello" }>,
      ) {
        if (frame.hello.sessionId !== expectedSessionId) {
          return yield* socket.close(
            SESSION_FABRIC_PERMISSION_CLOSE_CODE,
            "Session identity mismatch",
          );
        }
        const attachment = socket.deserializeAttachment<SocketAttachment>();
        if (
          attachment === null ||
          (verifierConfig?.mode !== "disabled" &&
            attachment.capability?.role !== "viewer" &&
            attachment.capability?.role !== "controller")
        ) {
          return yield* socket.close(
            SESSION_FABRIC_PERMISSION_CLOSE_CODE,
            "Client capability mismatch",
          );
        }
        socket.serializeAttachment<SocketAttachment>({
          role: "client",
          sessionId: expectedSessionId,
          peerId: frame.hello.clientId,
          runnerGeneration: null,
          capability: attachment.capability,
        });
        if (clientHelloShouldSynchronize(frame.hello)) {
          yield* synchronizeClient(
            socket,
            frame.hello.sessionId,
            frame.hello.afterEventSequence,
            attachment.capability,
          );
        }
      });

      const handlePublishedEvent = Effect.fn("session_fabric.handle_published_event")(function* (
        socket: Cloudflare.WebSocket,
        attachment: SocketAttachment,
        published: SessionFabricPublishedEvent,
      ) {
        if (
          attachment.role !== "runner" ||
          attachment.runnerGeneration === null ||
          published.sessionId !== attachment.sessionId ||
          published.runnerId !== attachment.peerId
        ) {
          return;
        }
        const meta = yield* readMeta();
        if (
          !isCurrentRunnerAttachment({
            attachmentGeneration: attachment.runnerGeneration,
            attachmentRunnerId: attachment.peerId,
            currentGeneration: meta.runner_generation,
            currentRunnerId: meta.runner_id,
          })
        ) {
          return;
        }
        const existingCursor = yield* sql.exec<{ event_id: string; stream_sequence: number }>(
          "SELECT event_id, stream_sequence FROM session_events WHERE event_id = ? LIMIT 1",
          published.event.eventId,
        );
        const existingRows = yield* existingCursor.toArray();
        const existing = existingRows.at(0);
        const decision = decideEventAppend({
          currentRunnerGeneration: meta.runner_generation,
          incomingRunnerGeneration: published.runnerGeneration,
          eventAlreadyExists: existing !== undefined,
        });
        if (decision === "duplicate" && existing !== undefined) {
          yield* socket.send(
            encodeFrame({
              type: "session.event-receipt",
              pointer: {
                sessionId: published.sessionId,
                eventId: published.event.eventId,
                sequence: existing.stream_sequence,
              },
            }),
          );
          return;
        }
        if (decision !== "accepted") return;

        const encodedPublished = encodePublishedEvent(published);
        const snapshot = yield* readSnapshot();
        const queuesSettlePause =
          snapshot !== null &&
          settledEventCanQueueScaffoldPause({
            eventType: published.event.type,
            eventThreadId: published.event.aggregateId,
            snapshotThreadId: snapshot.session.location.threadId,
            publication: snapshot.session.publication,
            environmentKind: snapshot.session.location.environmentKind,
            scaffoldSessionId: snapshot.session.location.scaffoldSessionId,
            lifecycleEpoch: snapshot.session.location.scaffoldLifecycleEpoch,
            runnerGeneration: meta.runner_generation,
          });
        const pauseDueAt = yield* Clock.currentTimeMillis;
        const existingEpochPauseCursor =
          queuesSettlePause && snapshot !== null
            ? yield* sql.exec<{
                readonly settlement_event_id: string;
                readonly status: string;
              }>(
                "SELECT settlement_event_id, status FROM session_settle_pauses WHERE fabric_session_id = ? AND expected_lifecycle_epoch = ? LIMIT 1",
                published.sessionId,
                snapshot.session.location.scaffoldLifecycleEpoch ?? -1,
              )
            : null;
        const existingEpochPause =
          existingEpochPauseCursor === null ? [] : yield* existingEpochPauseCursor.toArray();
        const replaceablePause = existingEpochPause.at(0);
        const sequence = state.raw.storage.transactionSync(() => {
          sql.raw.exec(
            "INSERT INTO session_events (event_id, occurred_at, payload_json) VALUES (?, ?, ?)",
            published.event.eventId,
            published.event.occurredAt,
            encodedPublished,
          );
          if (
            eventCancelsPendingSettlePause(published.event.type) &&
            published.event.aggregateId === snapshot?.session.location.threadId
          ) {
            sql.raw.exec(
              "UPDATE session_settle_pauses SET status = CASE WHEN status = 'in_flight' THEN 'cancel_requested' ELSE 'cancelled' END, next_attempt_at = NULL, detail = 'Cancelled by committed session activity', updated_at = ? WHERE status IN ('pending', 'in_flight')",
              published.event.occurredAt,
            );
          }
          if (
            queuesSettlePause &&
            snapshot !== null &&
            snapshot.session.location.scaffoldSessionId !== null &&
            snapshot.session.location.scaffoldLifecycleEpoch !== null &&
            snapshot.session.location.scaffoldLifecycleEpoch !== undefined
          ) {
            if (replaceablePause !== undefined && settlePauseCanResettle(replaceablePause.status)) {
              sql.raw.exec(
                "DELETE FROM session_settle_pauses WHERE settlement_event_id = ? AND status IN ('cancelled', 'failed')",
                replaceablePause.settlement_event_id,
              );
            }
            sql.raw.exec(
              "INSERT OR IGNORE INTO session_settle_pauses (settlement_event_id, fabric_session_id, environment_id, thread_id, scaffold_session_id, expected_lifecycle_epoch, target_lifecycle_epoch, status, attempt_count, next_attempt_at, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', 0, ?, NULL, ?)",
              published.event.eventId,
              published.sessionId,
              snapshot.session.location.environmentId,
              snapshot.session.location.threadId,
              snapshot.session.location.scaffoldSessionId,
              snapshot.session.location.scaffoldLifecycleEpoch,
              pauseDueAt,
              published.event.occurredAt,
            );
            sql.raw.exec(
              "UPDATE session_maintenance SET pause_due_at = CASE WHEN pause_due_at IS NULL OR pause_due_at > ? THEN ? ELSE pause_due_at END WHERE id = 1",
              pauseDueAt,
              pauseDueAt,
            );
          }
          return sql.raw
            .exec<{ stream_sequence: number }>(
              "SELECT stream_sequence FROM session_events WHERE event_id = ?",
              published.event.eventId,
            )
            .one().stream_sequence;
        });
        if (queuesSettlePause) {
          yield* armMaintenanceAlarm().pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("session fabric settle-pause alarm could not be armed", { cause }),
            ),
          );
        }
        yield* broadcast("client", {
          type: "session.event",
          sequence,
          published,
        });
        yield* socket.send(
          encodeFrame({
            type: "session.event-receipt",
            pointer: {
              sessionId: published.sessionId,
              eventId: published.event.eventId,
              sequence,
            },
          }),
        );
        if (queuesSettlePause) {
          yield* requestSettlePause(published.event.eventId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("session fabric settle-pause request failed", {
                eventId: published.event.eventId,
                cause,
              }),
            ),
          );
        }
      });

      const handlePublishedSnapshot = Effect.fn("session_fabric.handle_published_snapshot")(
        function* (
          attachment: SocketAttachment,
          frame: Extract<SessionFabricClientFrame, { type: "session.publish-snapshot" }>,
        ) {
          const published = frame.published;
          if (
            attachment.role !== "runner" ||
            attachment.runnerGeneration === null ||
            published.sessionId !== attachment.sessionId ||
            published.runnerId !== attachment.peerId
          ) {
            return;
          }
          const meta = yield* readMeta();
          if (
            verifierConfig?.mode !== "disabled" &&
            (attachment.capability?.role !== "runner" ||
              published.snapshot.session.sessionId !== attachment.sessionId ||
              published.snapshot.session.publication !== "public" ||
              !(
                (isPublicScaffoldLocation(published.snapshot.session.location) &&
                  !isLocalSessionFabricCapability(attachment.capability) &&
                  attachment.capability.scaffoldSessionId ===
                    published.snapshot.session.location.scaffoldSessionId &&
                  attachment.capability.scaffoldLifecycleEpoch ===
                    published.snapshot.session.location.scaffoldLifecycleEpoch) ||
                (isPublicLocalLocation(published.snapshot.session.location) &&
                  isLocalSessionFabricCapability(attachment.capability) &&
                  localCapabilityMatchesPinnedMeta({
                    capability: attachment.capability,
                    sessionId: published.snapshot.session.sessionId,
                    location: published.snapshot.session.location,
                    meta,
                  }))
              ))
          ) {
            return;
          }
          if (
            !isCurrentRunnerAttachment({
              attachmentGeneration: attachment.runnerGeneration,
              attachmentRunnerId: attachment.peerId,
              currentGeneration: meta.runner_generation,
              currentRunnerId: meta.runner_id,
            }) ||
            published.runnerGeneration !== meta.runner_generation
          ) {
            return;
          }
          const currentSnapshot =
            meta.snapshot_json === null ? null : decodeSnapshot(meta.snapshot_json);
          if (
            !snapshotAuthorityCanAdvance({
              currentSnapshotSequence: meta.snapshot_sequence,
              currentUpdatedAt: currentSnapshot?.session.updatedAt ?? null,
              incomingSnapshotSequence: published.snapshot.session.cursor.snapshotSequence,
              incomingUpdatedAt: published.snapshot.session.updatedAt,
            })
          ) {
            return;
          }
          const normalizedSnapshot = normalizeSnapshotToRelayCursor(
            published.snapshot,
            yield* currentEventSequence(),
            currentSnapshot === null
              ? 0
              : Math.min(
                  currentSnapshot.session.cursor.eventSequence,
                  currentSnapshot.compactedThroughEventSequence,
                ),
          );
          const encodedSnapshot = encodeSnapshot(normalizedSnapshot);
          yield* sql
            .exec(
              "UPDATE session_meta SET snapshot_json = ?, snapshot_sequence = ? WHERE id = 1",
              encodedSnapshot,
              published.snapshot.session.cursor.snapshotSequence,
            )
            .pipe(Effect.asVoid);
          const wakeCursor = yield* sql.exec<WakeRow>(
            "SELECT command_id, environment_id, thread_id, scaffold_session_id, expected_lifecycle_epoch, target_lifecycle_epoch, actor_id, status, attempt_count, next_attempt_at, detail, updated_at FROM session_command_wakes WHERE environment_id = ? AND thread_id = ? AND status = 'awaiting_snapshot' ORDER BY rowid ASC",
            normalizedSnapshot.session.location.environmentId,
            normalizedSnapshot.session.location.threadId,
          );
          for (const wake of yield* wakeCursor.toArray()) {
            const commandCursor = yield* sql.exec<CommandRow>(
              "SELECT command_id, payload_json, status, result_sequence, detail, updated_at FROM session_commands WHERE command_id = ? LIMIT 1",
              wake.command_id,
            );
            const commandRow = (yield* commandCursor.toArray()).at(0);
            const settlementEventId = settlementEventIdFromCompensationCommand(wake.command_id);
            const pauseCursor =
              commandRow !== undefined || settlementEventId === null
                ? null
                : yield* sql.exec<SettlePauseRow>(
                    "SELECT settlement_event_id, fabric_session_id, environment_id, thread_id, scaffold_session_id, expected_lifecycle_epoch, target_lifecycle_epoch, status, attempt_count, next_attempt_at, detail, updated_at FROM session_settle_pauses WHERE settlement_event_id = ? AND status = 'compensating' LIMIT 1",
                    settlementEventId,
                  );
            const pause = pauseCursor === null ? undefined : (yield* pauseCursor.toArray()).at(0);
            if (
              (commandRow === undefined && pause === undefined) ||
              wake.environment_id === null ||
              wake.thread_id === null
            ) {
              continue;
            }
            const command =
              commandRow === undefined ? null : decodeCommand(commandRow.payload_json);
            if (
              snapshotProvesScaffoldWakeTarget({
                wakeFabricSessionId: command?.sessionId ?? pause!.fabric_session_id,
                wakeEnvironmentId: wake.environment_id,
                wakeThreadId: wake.thread_id,
                wakeScaffoldSessionId: wake.scaffold_session_id,
                wakeTargetLifecycleEpoch: wake.target_lifecycle_epoch,
                snapshotFabricSessionId: normalizedSnapshot.session.sessionId,
                snapshotEnvironmentKind: normalizedSnapshot.session.location.environmentKind,
                snapshotEnvironmentId: normalizedSnapshot.session.location.environmentId,
                snapshotThreadId: normalizedSnapshot.session.location.threadId,
                snapshotScaffoldSessionId: normalizedSnapshot.session.location.scaffoldSessionId,
                snapshotLifecycleEpoch: normalizedSnapshot.session.location.scaffoldLifecycleEpoch,
                runnerGeneration: meta.runner_generation,
              })
            ) {
              yield* sql
                .exec(
                  "UPDATE session_command_wakes SET status = 'ready', next_attempt_at = NULL, detail = NULL, updated_at = ? WHERE command_id = ? AND status = 'awaiting_snapshot'",
                  yield* currentIso,
                  wake.command_id,
                )
                .pipe(Effect.asVoid);
              if (pause !== undefined) {
                const completedAt = yield* currentIso;
                yield* sql
                  .exec(
                    "UPDATE session_command_wakes SET status = 'completed', updated_at = ? WHERE command_id = ?",
                    completedAt,
                    wake.command_id,
                  )
                  .pipe(Effect.asVoid);
                yield* sql
                  .exec(
                    "UPDATE session_settle_pauses SET status = 'completed', target_lifecycle_epoch = ?, next_attempt_at = NULL, detail = NULL, updated_at = ? WHERE settlement_event_id = ? AND status = 'compensating'",
                    wake.target_lifecycle_epoch,
                    completedAt,
                    pause.settlement_event_id,
                  )
                  .pipe(Effect.asVoid);
              }
            }
          }
          yield* scheduleDirectoryUpdate();
          yield* broadcast("client", {
            type: "session.snapshot",
            snapshot: normalizedSnapshot,
          });
          yield* dispatchPendingCommands();
        },
      );

      const handlePublishedContext = Effect.fn("session_fabric.handle_published_context")(
        function* (attachment: SocketAttachment, published: SessionFabricContextPublication) {
          if (
            attachment.role !== "runner" ||
            attachment.runnerGeneration === null ||
            published.sessionId !== attachment.sessionId ||
            published.runnerId !== attachment.peerId
          ) {
            return;
          }
          const meta = yield* readMeta();
          if (
            !isCurrentRunnerAttachment({
              attachmentGeneration: attachment.runnerGeneration,
              attachmentRunnerId: attachment.peerId,
              currentGeneration: meta.runner_generation,
              currentRunnerId: meta.runner_id,
            }) ||
            published.runnerGeneration !== meta.runner_generation
          ) {
            return;
          }
          yield* sql
            .exec(
              "INSERT INTO session_context (id, code_diff, continuation_ref, published_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET code_diff = excluded.code_diff, continuation_ref = excluded.continuation_ref, published_at = excluded.published_at",
              published.codeDiff,
              published.continuationRef,
              published.publishedAt,
            )
            .pipe(Effect.asVoid);
        },
      );

      const handleCommand = Effect.fn("session_fabric.handle_command")(function* (
        socket: Cloudflare.WebSocket,
        attachment: SocketAttachment,
        command: SessionFabricCommand,
      ) {
        if (
          attachment.role !== "client" ||
          command.sessionId !== attachment.sessionId ||
          command.clientId !== attachment.peerId ||
          command.commandId !== command.command.commandId
        ) {
          return;
        }
        const snapshot = yield* readSnapshot();
        const meta = yield* readMeta();
        const localAuthority = completeLocalAuthority(meta);
        const commandAuthorized =
          snapshot !== null &&
          snapshot.session.publication === "public" &&
          (verifierConfig?.mode === "disabled" ||
            (attachment.capability !== null &&
              (isLocalSessionFabricCapability(attachment.capability)
                ? localControllerMatchesPinnedAuthority({
                    claims: attachment.capability,
                    sessionId: command.sessionId,
                    publication: snapshot.session.publication,
                    location: snapshot.session.location,
                    pinned: localAuthority,
                  })
                : capabilityCanControlSession({
                    claims: attachment.capability,
                    sessionId: command.sessionId,
                    publication: snapshot.session.publication,
                    location: snapshot.session.location,
                  }))));
        const scaffoldWakeController =
          snapshot !== null &&
          attachment.capability !== null &&
          scaffoldControllerMatchesSnapshotIdentity({
            claims: attachment.capability,
            sessionId: command.sessionId,
            publication: snapshot.session.publication,
            location: snapshot.session.location,
          }) &&
          attachment.capability.role === "controller" &&
          !isLocalSessionFabricCapability(attachment.capability)
            ? attachment.capability
            : null;
        const settlePauseWakeProof =
          scaffoldWakeController !== null &&
          snapshot !== null &&
          snapshot.session.location.scaffoldSessionId !== null &&
          meta.runner_generation === scaffoldWakeController.scaffoldLifecycleEpoch + 1
            ? yield* readSettlePauseWakeProof({
                fabricSessionId: command.sessionId,
                environmentId: snapshot.session.location.environmentId,
                threadId: snapshot.session.location.threadId,
                scaffoldSessionId: snapshot.session.location.scaffoldSessionId,
                expectedLifecycleEpoch: scaffoldWakeController.scaffoldLifecycleEpoch,
                targetLifecycleEpoch: meta.runner_generation,
              })
            : undefined;
        const scaffoldWakeExpectedEpoch =
          scaffoldWakeController === null
            ? null
            : scaffoldWakeExpectedLifecycleEpoch({
                durableLifecycleEpoch: meta.runner_generation,
                controllerLifecycleEpoch: scaffoldWakeController.scaffoldLifecycleEpoch,
                snapshotLifecycleEpoch: snapshot?.session.location.scaffoldLifecycleEpoch,
                settlePauseProof:
                  settlePauseWakeProof === undefined
                    ? undefined
                    : {
                        expectedLifecycleEpoch: settlePauseWakeProof.expected_lifecycle_epoch,
                        targetLifecycleEpoch: settlePauseWakeProof.target_lifecycle_epoch,
                        status: settlePauseWakeProof.status,
                      },
              });
        const sharedWake =
          scaffoldWakeController !== null &&
          scaffoldWakeExpectedEpoch !== null &&
          snapshot !== null &&
          snapshot.session.location.scaffoldSessionId !== null
            ? yield* readSharedWake(
                snapshot.session.location.environmentId,
                snapshot.session.location.threadId,
                snapshot.session.location.scaffoldSessionId,
                scaffoldWakeExpectedEpoch,
              )
            : undefined;
        const activeSettlePause = yield* readActiveSettlePause();
        const joinsInFlightPause =
          commandAuthorized &&
          scaffoldWakeController !== null &&
          snapshot !== null &&
          (activeSettlePause?.status === "in_flight" ||
            activeSettlePause?.status === "cancel_requested") &&
          activeSettlePause.fabric_session_id === command.sessionId &&
          activeSettlePause.environment_id === snapshot.session.location.environmentId &&
          activeSettlePause.thread_id === snapshot.session.location.threadId &&
          activeSettlePause.scaffold_session_id === snapshot.session.location.scaffoldSessionId &&
          activeSettlePause.expected_lifecycle_epoch ===
            snapshot.session.location.scaffoldLifecycleEpoch;
        const runners = snapshot === null ? [] : yield* eligibleRunners(snapshot, meta);
        const existingCursor = yield* sql.exec<CommandRow>(
          "SELECT command_id, payload_json, status, result_sequence, detail, updated_at FROM session_commands WHERE command_id = ? LIMIT 1",
          command.commandId,
        );
        const existing = (yield* existingCursor.toArray()).at(0);
        if ((commandAuthorized || scaffoldWakeController !== null) && existing !== undefined) {
          yield* socket.send(
            encodeFrame({
              type: "command.receipt",
              receipt: decodeCommandReceipt({
                sessionId: command.sessionId,
                commandId: command.commandId,
                status: existing.status,
                resultSequence: existing.result_sequence,
                detail: existing.detail,
                updatedAt: existing.updated_at,
              }),
            }),
          );
          return;
        }
        const shouldWake =
          scaffoldWakeExpectedEpoch !== null &&
          snapshot !== null &&
          offlineScaffoldCommandCanWake({
            controllerMatchesSnapshotIdentity: scaffoldWakeController !== null,
            runnerState: meta.runner_state,
            eligibleRunnerCount: runners.length,
            wakeAlreadyActive: sharedWake !== undefined,
            publication: snapshot.session.publication,
            environmentKind: snapshot.session.location.environmentKind,
            scaffoldSessionId: snapshot.session.location.scaffoldSessionId,
            controllerLifecycleEpoch: scaffoldWakeController?.scaffoldLifecycleEpoch,
            wakeAuthorityConfigured: wakeAuthorityConfig !== null,
          });
        const authorizationDecision =
          shouldWake || joinsInFlightPause
            ? ({ type: "accepted" } as const)
            : decideAuthorizedCommandSubmit({
                controllerMatchesSession: commandAuthorized,
                runnerState: meta.runner_state,
                eligibleRunnerCount: runners.length,
              });
        if (authorizationDecision.type === "rejected") {
          const updatedAt = yield* currentIso;
          const receipt = {
            sessionId: command.sessionId,
            commandId: command.commandId,
            status: "rejected" as const,
            resultSequence: null,
            detail: authorizationDecision.detail,
            updatedAt,
          };
          if (commandAuthorized || scaffoldWakeController !== null) {
            yield* sql
              .exec(
                "INSERT INTO session_commands (command_id, payload_json, status, result_sequence, detail, updated_at) VALUES (?, ?, 'rejected', NULL, ?, ?)",
                command.commandId,
                encodeCommand(command),
                authorizationDecision.detail,
                updatedAt,
              )
              .pipe(Effect.asVoid);
          }
          yield* socket.send(encodeFrame({ type: "command.receipt", receipt }));
          return;
        }
        const decision = decideCommandSubmit(existing);
        if (decision.type === "accepted") {
          if (joinsInFlightPause) {
            yield* sql
              .exec(
                "UPDATE session_settle_pauses SET status = 'cancel_requested', detail = 'Cancellation requested by an authorized command', updated_at = ? WHERE settlement_event_id = ? AND status = 'in_flight'",
                command.submittedAt,
                activeSettlePause?.settlement_event_id ?? "",
              )
              .pipe(Effect.asVoid);
          }
          if (
            joinsInFlightPause &&
            snapshot !== null &&
            snapshot.session.location.scaffoldSessionId !== null &&
            snapshot.session.location.scaffoldLifecycleEpoch !== null &&
            snapshot.session.location.scaffoldLifecycleEpoch !== undefined &&
            scaffoldWakeController !== null
          ) {
            const expectedLifecycleEpoch = snapshot.session.location.scaffoldLifecycleEpoch + 1;
            state.raw.storage.transactionSync(() => {
              sql.raw.exec(
                "INSERT INTO session_commands (command_id, payload_json, status, result_sequence, detail, updated_at) VALUES (?, ?, 'queued', NULL, NULL, ?)",
                command.commandId,
                encodeCommand(command),
                command.submittedAt,
              );
              sql.raw.exec(
                "INSERT INTO session_command_wakes (command_id, environment_id, thread_id, scaffold_session_id, expected_lifecycle_epoch, target_lifecycle_epoch, actor_id, status, attempt_count, next_attempt_at, detail, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 'joining_pause', 0, NULL, NULL, ?)",
                command.commandId,
                snapshot.session.location.environmentId,
                snapshot.session.location.threadId,
                snapshot.session.location.scaffoldSessionId,
                expectedLifecycleEpoch,
                scaffoldWakeController.actorId,
                command.submittedAt,
              );
            });
          } else if (
            shouldWake &&
            snapshot !== null &&
            snapshot.session.location.scaffoldSessionId !== null &&
            scaffoldWakeController !== null
          ) {
            const wakeDueAt = yield* Clock.currentTimeMillis;
            const joinedStatus =
              sharedWake === undefined
                ? "joining"
                : scaffoldWakeFollowerStatus({
                    leaderStatus: sharedWake.status,
                    targetLifecycleEpoch: sharedWake.target_lifecycle_epoch,
                  });
            state.raw.storage.transactionSync(() => {
              sql.raw.exec(
                "INSERT INTO session_commands (command_id, payload_json, status, result_sequence, detail, updated_at) VALUES (?, ?, 'queued', NULL, NULL, ?)",
                command.commandId,
                encodeCommand(command),
                command.submittedAt,
              );
              if (sharedWake === undefined) {
                sql.raw.exec(
                  "INSERT INTO session_command_wakes (command_id, environment_id, thread_id, scaffold_session_id, expected_lifecycle_epoch, target_lifecycle_epoch, actor_id, status, attempt_count, next_attempt_at, detail, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 'pending', 0, ?, NULL, ?)",
                  command.commandId,
                  snapshot.session.location.environmentId,
                  snapshot.session.location.threadId,
                  snapshot.session.location.scaffoldSessionId,
                  scaffoldWakeExpectedEpoch,
                  scaffoldWakeController.actorId,
                  wakeDueAt,
                  command.submittedAt,
                );
                sql.raw.exec(
                  "UPDATE session_maintenance SET wake_due_at = CASE WHEN wake_due_at IS NULL OR wake_due_at > ? THEN ? ELSE wake_due_at END WHERE id = 1",
                  wakeDueAt,
                  wakeDueAt,
                );
              } else {
                sql.raw.exec(
                  "INSERT INTO session_command_wakes (command_id, environment_id, thread_id, scaffold_session_id, expected_lifecycle_epoch, target_lifecycle_epoch, actor_id, status, attempt_count, next_attempt_at, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)",
                  command.commandId,
                  sharedWake.environment_id,
                  sharedWake.thread_id,
                  sharedWake.scaffold_session_id,
                  sharedWake.expected_lifecycle_epoch,
                  sharedWake.target_lifecycle_epoch,
                  scaffoldWakeController.actorId,
                  joinedStatus,
                  sharedWake.attempt_count,
                  command.submittedAt,
                );
              }
            });
            if (sharedWake === undefined) yield* armMaintenanceAlarm();
          } else {
            if (activeSettlePause?.status === "pending") {
              yield* sql
                .exec(
                  "UPDATE session_settle_pauses SET status = 'cancelled', next_attempt_at = NULL, detail = 'Cancelled by an authorized command', updated_at = ? WHERE status = 'pending'",
                  command.submittedAt,
                )
                .pipe(Effect.asVoid);
            }
            yield* sql
              .exec(
                "INSERT INTO session_commands (command_id, payload_json, status, result_sequence, detail, updated_at) VALUES (?, ?, 'queued', NULL, NULL, ?)",
                command.commandId,
                encodeCommand(command),
                command.submittedAt,
              )
              .pipe(Effect.asVoid);
          }
        }
        const row =
          decision.type === "duplicate"
            ? decision.existing
            : yield* sql
                .exec<CommandRow>(
                  "SELECT command_id, payload_json, status, result_sequence, detail, updated_at FROM session_commands WHERE command_id = ?",
                  command.commandId,
                )
                .pipe(Effect.flatMap((cursor) => cursor.one()));
        yield* broadcast("client", {
          type: "command.receipt",
          receipt: decodeCommandReceipt({
            sessionId: command.sessionId,
            commandId: command.commandId,
            status: row.status,
            resultSequence: row.result_sequence,
            detail: row.detail,
            updatedAt: row.updated_at,
          }),
        });
        if (joinsInFlightPause) return;
        if (shouldWake && sharedWake === undefined) yield* requestScaffoldWake(command.commandId);
        else yield* dispatchPendingCommands();
      });

      const handleFrame = Effect.fn("session_fabric.handle_frame")(function* (
        socket: Cloudflare.WebSocket,
        frame: SessionFabricClientFrame,
      ) {
        const attachment = socket.deserializeAttachment<SocketAttachment>();
        if (attachment === null) return;
        switch (frame.type) {
          case "runner.hello":
            return yield* handleRunnerHello(socket, attachment.sessionId, frame);
          case "client.hello":
            return yield* handleClientHello(socket, attachment.sessionId, frame);
          case "session.publish-event":
            return yield* handlePublishedEvent(socket, attachment, frame.published);
          case "session.publish-snapshot":
            return yield* handlePublishedSnapshot(attachment, frame);
          case "session.publish-context":
            return yield* handlePublishedContext(attachment, frame.published);
          case "command.submit":
            return yield* handleCommand(socket, attachment, frame.command);
          case "command.receipt": {
            const meta = yield* readMeta();
            if (
              attachment.role === "runner" &&
              frame.receipt.sessionId === attachment.sessionId &&
              isCurrentRunnerAttachment({
                attachmentGeneration: attachment.runnerGeneration,
                attachmentRunnerId: attachment.peerId,
                currentGeneration: meta.runner_generation,
                currentRunnerId: meta.runner_id,
              })
            ) {
              return yield* storeReceipt(frame.receipt);
            }
            return;
          }
        }
      });

      const rearmMaintenance = Effect.gen(function* () {
        const nextCursor = yield* sql.exec<{ readonly next_attempt_at: number | null }>(
          "SELECT MIN(next_attempt_at) AS next_attempt_at FROM session_command_wakes WHERE status IN ('pending', 'retrying', 'awaiting_snapshot') AND next_attempt_at IS NOT NULL",
        );
        const nextAttemptAt = (yield* nextCursor.one()).next_attempt_at;
        const nextPauseCursor = yield* sql.exec<{ readonly next_attempt_at: number | null }>(
          "SELECT MIN(next_attempt_at) AS next_attempt_at FROM session_settle_pauses WHERE status IN ('pending', 'in_flight', 'cancel_requested') AND next_attempt_at IS NOT NULL",
        );
        const nextPauseAt = (yield* nextPauseCursor.one()).next_attempt_at;
        yield* sql
          .exec(
            "UPDATE session_maintenance SET wake_due_at = ?, pause_due_at = ? WHERE id = 1",
            nextAttemptAt,
            nextPauseAt,
          )
          .pipe(Effect.asVoid);
        yield* armMaintenanceAlarm();
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("session fabric maintenance could not be rearmed", { cause }),
        ),
      );

      const runMaintenance = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cursor = yield* sql.exec<{
          readonly directory_due_at: number | null;
          readonly wake_due_at: number | null;
          readonly pause_due_at: number | null;
        }>(
          "SELECT directory_due_at, wake_due_at, pause_due_at FROM session_maintenance WHERE id = 1",
        );
        const maintenance = yield* cursor.one();
        if (maintenance.directory_due_at !== null && maintenance.directory_due_at <= now) {
          yield* sql
            .exec("UPDATE session_maintenance SET directory_due_at = NULL WHERE id = 1")
            .pipe(Effect.asVoid);
          yield* updateDirectory;
        }
        if (maintenance.wake_due_at !== null && maintenance.wake_due_at <= now) {
          yield* sql
            .exec("UPDATE session_maintenance SET wake_due_at = NULL WHERE id = 1")
            .pipe(Effect.asVoid);
          const dueCursor = yield* sql.exec<WakeRow>(
            "SELECT command_id, environment_id, thread_id, scaffold_session_id, expected_lifecycle_epoch, target_lifecycle_epoch, actor_id, status, attempt_count, next_attempt_at, detail, updated_at FROM session_command_wakes WHERE status IN ('pending', 'retrying', 'awaiting_snapshot') AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? ORDER BY next_attempt_at ASC, rowid ASC",
            now,
          );
          for (const wake of yield* dueCursor.toArray()) {
            yield* requestScaffoldWake(wake.command_id).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("session fabric wake maintenance row failed", {
                  commandId: wake.command_id,
                  cause,
                }),
              ),
            );
          }
        }
        if (maintenance.pause_due_at !== null && maintenance.pause_due_at <= now) {
          yield* sql
            .exec("UPDATE session_maintenance SET pause_due_at = NULL WHERE id = 1")
            .pipe(Effect.asVoid);
          const duePauses = yield* sql.exec<SettlePauseRow>(
            "SELECT settlement_event_id, fabric_session_id, environment_id, thread_id, scaffold_session_id, expected_lifecycle_epoch, target_lifecycle_epoch, status, attempt_count, next_attempt_at, detail, updated_at FROM session_settle_pauses WHERE status IN ('pending', 'in_flight', 'cancel_requested') AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? ORDER BY next_attempt_at ASC, rowid ASC",
            now,
          );
          for (const pause of yield* duePauses.toArray()) {
            yield* requestSettlePause(pause.settlement_event_id).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("session fabric settle-pause maintenance row failed", {
                  eventId: pause.settlement_event_id,
                  cause,
                }),
              ),
            );
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("session fabric maintenance failed", { cause }),
        ),
        Effect.ensuring(rearmMaintenance),
      );

      return {
        getSnapshot: readSnapshot,
        getEventBatch: readEvents,
        getContext: readContext,
        alarm: () => runMaintenance,
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          // Durable Object fetch forwarding may preserve only the relative request
          // target in local runtimes, even when the outer Worker received an
          // absolute URL. Accept both forms so WebSocket upgrades work in dev and
          // production.
          const url = new URL(request.url, "http://session-fabric.local");
          const isWebSocket = request.headers.upgrade?.toLowerCase() === "websocket";
          const capabilityResult = yield* verifyCapability(
            isWebSocket
              ? websocketCapability(request.headers["sec-websocket-protocol"])
              : authorizationCapability(request.headers.authorization),
            request.url,
          ).pipe(Effect.result);
          if (capabilityResult._tag === "Failure") {
            return HttpServerResponse.text("Session fabric authorization required", {
              status: capabilityResult.failure.reason === "unavailable" ? 503 : 401,
            });
          }
          const capability = capabilityResult.success;
          const sessionId = pathSessionId(url);
          if (sessionId === null) {
            return HttpServerResponse.text("Not found", { status: 404 });
          }
          if (url.pathname.endsWith("/authority")) {
            const pinned = completeLocalAuthority(yield* readMeta());
            const authority =
              verifierConfig?.mode === "disabled" && pinned !== null
                ? {
                    fabricSessionId: pinned.sessionId,
                    environmentKind: "local" as const,
                    environmentId: pinned.environmentId,
                    threadId: pinned.threadId,
                    actorId: pinned.actorId,
                  }
                : localAuthorityViewForViewer({ claims: capability, sessionId, pinned });
            return authority === null
              ? HttpServerResponse.empty({ status: 404 })
              : HttpServerResponse.jsonUnsafe(authority, {
                  headers: { "cache-control": "no-store" },
                });
          }
          if (url.pathname.endsWith("/snapshot")) {
            const snapshot = yield* readSnapshot();
            return snapshot === null
              ? HttpServerResponse.empty({ status: 404 })
              : !(yield* canReadSnapshot(capability, snapshot))
                ? HttpServerResponse.empty({ status: 404 })
                : HttpServerResponse.jsonUnsafe(snapshot, {
                    headers: { "cache-control": "no-store" },
                  });
          }
          if (url.pathname.endsWith("/events")) {
            const snapshot = yield* readSnapshot();
            if (snapshot === null || !(yield* canReadSnapshot(capability, snapshot))) {
              return HttpServerResponse.empty({ status: 404 });
            }
            const after = Number(url.searchParams.get("after") ?? "0");
            const batch = yield* readEvents(
              sessionId,
              Number.isSafeInteger(after) && after >= 0 ? after : 0,
            );
            return HttpServerResponse.jsonUnsafe(batch, {
              headers: { "cache-control": "no-store" },
            });
          }
          if (url.pathname.endsWith("/context")) {
            const snapshot = yield* readSnapshot();
            if (snapshot === null || !(yield* canReadSnapshot(capability, snapshot))) {
              return HttpServerResponse.empty({ status: 404 });
            }
            const context = yield* readContext(
              url.searchParams.get("includeCodeDiff") !== "false",
              url.searchParams.get("includeContinuation") !== "false",
            );
            return context === null
              ? HttpServerResponse.empty({ status: 404 })
              : HttpServerResponse.jsonUnsafe(context, {
                  headers: { "cache-control": "no-store" },
                });
          }
          if (request.headers.upgrade?.toLowerCase() !== "websocket") {
            return HttpServerResponse.text("WebSocket upgrade required", { status: 426 });
          }
          const [response, socket] = yield* Cloudflare.upgrade();
          socket.serializeAttachment<SocketAttachment>({
            role: "pending",
            sessionId,
            peerId: null,
            runnerGeneration: null,
            capability,
          });
          return verifierConfig?.mode === "disabled"
            ? response
            : HttpServerResponse.setHeader(
                response,
                "sec-websocket-protocol",
                SESSION_FABRIC_WS_PROTOCOL,
              );
        }),
        webSocketMessage: Effect.fnUntraced(function* (
          socket: Cloudflare.WebSocket,
          message: string | ArrayBuffer,
        ) {
          const attachment = socket.deserializeAttachment<SocketAttachment>();
          if (attachment === null || !(yield* capabilityIsCurrent(attachment.capability))) {
            return yield* socket.close(
              SESSION_FABRIC_AUTHENTICATION_CLOSE_CODE,
              "Session fabric capability expired",
            );
          }
          yield* parseMessage(message).pipe(
            Effect.flatMap((frame) => handleFrame(socket, frame)),
            Effect.catch(() => socket.close(1003, "Invalid session fabric frame")),
          );
        }),
        webSocketClose: Effect.fnUntraced(function* (
          socket: Cloudflare.WebSocket,
          code: number,
          reason: string,
          _wasClean: boolean,
        ) {
          const attachment = socket.deserializeAttachment<SocketAttachment>();
          if (attachment?.role === "runner") {
            const meta = yield* readMeta();
            if (
              isCurrentRunnerAttachment({
                attachmentGeneration: attachment.runnerGeneration,
                attachmentRunnerId: attachment.peerId,
                currentGeneration: meta.runner_generation,
                currentRunnerId: meta.runner_id,
              })
            ) {
              yield* setRunnerState("offline");
              yield* rejectPendingCommands("Session runner disconnected");
            }
          }
          yield* socket.close(code, reason);
        }),
      };
    });
  }).pipe(Effect.orDie),
) {}
