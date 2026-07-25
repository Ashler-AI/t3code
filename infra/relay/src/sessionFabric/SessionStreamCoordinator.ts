// @effect-diagnostics returnEffectInGen:off -- Alchemy Durable Objects intentionally use a two-phase outer/inner Effect.
import type {
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
} from "@t3tools/contracts/session-fabric";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  decideCommandSubmit,
  decideEventAppend,
  decideRunnerGeneration,
  shouldReplayCommand,
} from "./SessionStreamModel.ts";
import SessionDirectory from "./SessionDirectory.ts";

interface SocketAttachment {
  readonly role: "pending" | "client" | "runner";
  readonly sessionId: string;
  readonly peerId: string | null;
  readonly runnerGeneration: number | null;
}

interface MetaRow {
  readonly [key: string]: string | number | null;
  readonly session_id: string | null;
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
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const { sql } = state.storage;

      yield* sql
        .exec(
          "CREATE TABLE IF NOT EXISTS session_meta (id INTEGER PRIMARY KEY CHECK (id = 1), session_id TEXT, runner_generation INTEGER NOT NULL DEFAULT 0, runner_state TEXT NOT NULL DEFAULT 'offline', snapshot_json TEXT, snapshot_sequence INTEGER NOT NULL DEFAULT 0)",
        )
        .pipe(Effect.asVoid);
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
          "SELECT session_id, runner_generation, runner_state, snapshot_json, snapshot_sequence FROM session_meta WHERE id = 1",
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
        return sockets.filter(
          (socket) => socket.deserializeAttachment<SocketAttachment>()?.role === role,
        );
      });

      const broadcast = Effect.fn("session_fabric.broadcast")(function* (
        role: SocketAttachment["role"],
        frame: SessionFabricServerFrame,
      ) {
        const payload = encodeFrame(frame);
        for (const socket of yield* socketsForRole(role)) {
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

      const dispatchPendingCommands = Effect.fn("session_fabric.dispatch_pending_commands")(
        function* () {
          const runners = yield* socketsForRole("runner");
          if (runners.length === 0) return;
          const cursor = yield* sql.exec<CommandRow>(
            "SELECT command_id, payload_json, status, result_sequence, detail, updated_at FROM session_commands WHERE status IN ('queued', 'delivered') ORDER BY rowid ASC",
          );
          for (const row of yield* cursor.toArray()) {
            if (!shouldReplayCommand(row.status)) continue;
            const command = decodeCommand(row.payload_json);
            const frame = encodeFrame({ type: "command.dispatch", command });
            for (const runner of runners) yield* runner.send(frame);
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
      ) {
        const snapshot = yield* readSnapshot();
        if (snapshot !== null) {
          yield* socket.send(encodeFrame({ type: "session.snapshot", snapshot }));
        }
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
          return yield* socket.close(1008, "Session identity mismatch");
        }
        const meta = yield* readMeta();
        if (
          decideRunnerGeneration(meta.runner_generation, frame.hello.runnerGeneration) === "stale"
        ) {
          return yield* socket.close(1008, "Stale runner generation");
        }
        yield* sql
          .exec(
            "UPDATE session_meta SET session_id = ?, runner_generation = ?, runner_state = 'online' WHERE id = 1",
            frame.hello.sessionId,
            frame.hello.runnerGeneration,
          )
          .pipe(Effect.asVoid);
        socket.serializeAttachment<SocketAttachment>({
          role: "runner",
          sessionId: expectedSessionId,
          peerId: frame.hello.runnerId,
          runnerGeneration: frame.hello.runnerGeneration,
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
          return yield* socket.close(1008, "Session identity mismatch");
        }
        socket.serializeAttachment<SocketAttachment>({
          role: "client",
          sessionId: expectedSessionId,
          peerId: frame.hello.clientId,
          runnerGeneration: null,
        });
        yield* synchronizeClient(socket, frame.hello.sessionId, frame.hello.afterEventSequence);
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
          const meta = yield* readMeta();
          if (
            decideRunnerGeneration(meta.runner_generation, published.runnerGeneration) === "stale"
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
            decideRunnerGeneration(meta.runner_generation, published.runnerGeneration) === "stale"
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
        const existingCursor = yield* sql.exec<CommandRow>(
          "SELECT command_id, payload_json, status, result_sequence, detail, updated_at FROM session_commands WHERE command_id = ? LIMIT 1",
          command.commandId,
        );
        const decision = decideCommandSubmit((yield* existingCursor.toArray()).at(0));
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
            return yield* handleCommand(attachment, frame.command);
          case "command.receipt":
            if (attachment.role === "runner" && frame.receipt.sessionId === attachment.sessionId) {
              return yield* storeReceipt(frame.receipt);
            }
            return;
        }
      });

      return {
        getSnapshot: readSnapshot,
        getEventBatch: readEvents,
        getContext: readContext,
        alarm: () => updateDirectory,
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url);
          const sessionId = pathSessionId(url);
          if (sessionId === null) {
            return HttpServerResponse.text("Not found", { status: 404 });
          }
          if (url.pathname.endsWith("/snapshot")) {
            const snapshot = yield* readSnapshot();
            return snapshot === null
              ? HttpServerResponse.empty({ status: 404 })
              : HttpServerResponse.jsonUnsafe(snapshot, {
                  headers: { "cache-control": "no-store" },
                });
          }
          if (url.pathname.endsWith("/events")) {
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
          });
          return response;
        }),
        webSocketMessage: Effect.fnUntraced(function* (
          socket: Cloudflare.DurableWebSocket,
          message: string | ArrayBuffer,
        ) {
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
          if (attachment?.role === "runner") yield* setRunnerState("offline");
          yield* socket.close(code, reason);
        }),
      };
    });
  }),
) {}
