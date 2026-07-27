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
  isLoopbackSessionFabricRequestUrl,
  isPublicScaffoldLocation,
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
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  decideAuthorizedCommandSubmit,
  decideCommandSubmit,
  decideEventAppend,
  isCurrentRunnerAttachment,
  runnerHelloMatchesLease,
  SESSION_FABRIC_AUTHENTICATION_CLOSE_CODE,
  SESSION_FABRIC_PERMISSION_CLOSE_CODE,
  shouldReplayCommand,
} from "./SessionStreamModel.ts";
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
    /^\/v1\/session-fabric\/sessions\/([^/]+)\/(?:connect|snapshot|events|context)$/,
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

export default class SessionStreamCoordinator extends Cloudflare.DurableObjectNamespace<SessionStreamCoordinator>()(
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
    const verifierConfig = makeSessionFabricCapabilityVerifierConfig({
      mode: Option.getOrUndefined(authMode),
      issuer: Option.getOrUndefined(authIssuer),
      audience: Option.getOrUndefined(authAudience),
      publicKeysJson: Option.getOrUndefined(authPublicKeys),
    });
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const { sql } = state.storage;

      yield* sql
        .exec(
          "CREATE TABLE IF NOT EXISTS session_meta (id INTEGER PRIMARY KEY CHECK (id = 1), session_id TEXT, runner_id TEXT, runner_generation INTEGER NOT NULL DEFAULT 0, runner_state TEXT NOT NULL DEFAULT 'offline', snapshot_json TEXT, snapshot_sequence INTEGER NOT NULL DEFAULT 0)",
        )
        .pipe(Effect.asVoid);
      const metaColumns = yield* sql.exec<{ readonly name: string }>(
        "PRAGMA table_info(session_meta)",
      );
      if (!(yield* metaColumns.toArray()).some((column) => column.name === "runner_id")) {
        yield* sql.exec("ALTER TABLE session_meta ADD COLUMN runner_id TEXT").pipe(Effect.asVoid);
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
          "CREATE TABLE IF NOT EXISTS session_context (id INTEGER PRIMARY KEY CHECK (id = 1), code_diff TEXT, continuation_ref TEXT, published_at TEXT NOT NULL)",
        )
        .pipe(Effect.asVoid);
      yield* sql
        .exec(
          "INSERT OR IGNORE INTO session_meta (id, runner_generation, runner_state, snapshot_sequence) VALUES (1, 0, 'offline', 0)",
        )
        .pipe(Effect.asVoid);

      const readMeta = Effect.fn("session_fabric.read_meta")(function* () {
        const cursor = yield* sql.exec<MetaRow>(
          "SELECT session_id, runner_id, runner_generation, runner_state, snapshot_json, snapshot_sequence FROM session_meta WHERE id = 1",
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
        const current: Array<Cloudflare.DurableWebSocket> = [];
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
        const eligible: Array<Cloudflare.DurableWebSocket> = [];
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
                isPublicScaffoldLocation(snapshot.session.location) &&
                attachment.capability.scaffoldSessionId ===
                  snapshot.session.location.scaffoldSessionId &&
                attachment.capability.scaffoldLifecycleEpoch ===
                  snapshot.session.location.scaffoldLifecycleEpoch))
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

      const scheduleDirectoryUpdate = Effect.fn("session_fabric.schedule_directory_update")(
        function* () {
          yield* state.storage.setAlarm((yield* Clock.currentTimeMillis) + 2_000).pipe(
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
        yield* broadcast("client", { type: "command.receipt", receipt });
      });

      const rejectPendingCommands = Effect.fn("session_fabric.reject_pending_commands")(function* (
        detail: string,
      ) {
        const cursor = yield* sql.exec<CommandRow>(
          "SELECT command_id, payload_json, status, result_sequence, detail, updated_at FROM session_commands WHERE status IN ('queued', 'delivered') ORDER BY rowid ASC",
        );
        for (const row of yield* cursor.toArray()) {
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
            const frame = encodeFrame({ type: "command.dispatch", command });
            const sent = yield* runner.send(frame).pipe(Effect.result);
            if (sent._tag === "Failure") {
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
        socket: Cloudflare.DurableWebSocket,
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
        socket: Cloudflare.DurableWebSocket,
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
        yield* sql
          .exec(
            "UPDATE session_meta SET session_id = ?, runner_id = ?, runner_generation = ?, runner_state = 'online' WHERE id = 1",
            frame.hello.sessionId,
            frame.hello.runnerId,
            frame.hello.runnerGeneration,
          )
          .pipe(Effect.asVoid);
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
        socket: Cloudflare.DurableWebSocket,
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
        yield* synchronizeClient(
          socket,
          frame.hello.sessionId,
          frame.hello.afterEventSequence,
          attachment.capability,
        );
      });

      const handlePublishedEvent = Effect.fn("session_fabric.handle_published_event")(function* (
        socket: Cloudflare.DurableWebSocket,
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
        const sequence = state.storage.transactionSync(() => {
          sql.raw.exec(
            "INSERT INTO session_events (event_id, occurred_at, payload_json) VALUES (?, ?, ?)",
            published.event.eventId,
            published.event.occurredAt,
            encodedPublished,
          );
          return sql.raw
            .exec<{ stream_sequence: number }>(
              "SELECT stream_sequence FROM session_events WHERE event_id = ?",
              published.event.eventId,
            )
            .one().stream_sequence;
        });
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
          if (
            verifierConfig?.mode !== "disabled" &&
            (attachment.capability?.role !== "runner" ||
              published.snapshot.session.sessionId !== attachment.sessionId ||
              published.snapshot.session.publication !== "public" ||
              !isPublicScaffoldLocation(published.snapshot.session.location) ||
              attachment.capability.scaffoldSessionId !==
                published.snapshot.session.location.scaffoldSessionId ||
              attachment.capability.scaffoldLifecycleEpoch !==
                published.snapshot.session.location.scaffoldLifecycleEpoch)
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
          const encodedSnapshot = encodeSnapshot(published.snapshot);
          yield* sql
            .exec(
              "UPDATE session_meta SET snapshot_json = ?, snapshot_sequence = ? WHERE id = 1",
              encodedSnapshot,
              published.snapshot.session.cursor.snapshotSequence,
            )
            .pipe(Effect.asVoid);
          yield* scheduleDirectoryUpdate();
          yield* broadcast("client", {
            type: "session.snapshot",
            snapshot: published.snapshot,
          });
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
        socket: Cloudflare.DurableWebSocket,
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
        const commandAuthorized =
          snapshot !== null &&
          (verifierConfig?.mode === "disabled" ||
            (attachment.capability !== null &&
              capabilityCanControlSession({
                claims: attachment.capability,
                sessionId: command.sessionId,
                location: snapshot.session.location,
              })));
        const meta = yield* readMeta();
        const runners = snapshot === null ? [] : yield* eligibleRunners(snapshot, meta);
        const existingCursor = yield* sql.exec<CommandRow>(
          "SELECT command_id, payload_json, status, result_sequence, detail, updated_at FROM session_commands WHERE command_id = ? LIMIT 1",
          command.commandId,
        );
        const existing = (yield* existingCursor.toArray()).at(0);
        if (commandAuthorized && existing !== undefined) {
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
        const authorizationDecision = decideAuthorizedCommandSubmit({
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
          if (commandAuthorized) {
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
          yield* sql
            .exec(
              "INSERT INTO session_commands (command_id, payload_json, status, result_sequence, detail, updated_at) VALUES (?, ?, 'queued', NULL, NULL, ?)",
              command.commandId,
              encodeCommand(command),
              command.submittedAt,
            )
            .pipe(Effect.asVoid);
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
        yield* dispatchPendingCommands();
      });

      const handleFrame = Effect.fn("session_fabric.handle_frame")(function* (
        socket: Cloudflare.DurableWebSocket,
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

      return {
        getSnapshot: readSnapshot,
        getEventBatch: readEvents,
        getContext: readContext,
        alarm: () => updateDirectory,
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
          socket: Cloudflare.DurableWebSocket,
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
          socket: Cloudflare.DurableWebSocket,
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
