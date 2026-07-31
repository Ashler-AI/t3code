// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  OmpSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  advanceOmpEventCursor,
  buildOmpSteerRequest,
  makeOmpEventId,
  makeOmpSourceEventId,
  makeOmpAdapter,
  ompPromptSettlementBelongsToContext,
  parseOmpResume,
  parseOmpSteerResult,
  resumedOmpCursorForSession,
} from "./OmpAdapter.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const compatibilityFixturePath = NodePath.join(
  __dirname,
  "../acp/fixtures/omp-acp-harness-fixture.ts",
);

async function makeMockOmpWrapper(extraEnv?: Readonly<Record<string, string>>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "omp");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh\n${envExports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"\n`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function makeOmpCompatibilityWrapper(mode: "success" | "error" = "success") {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-compat-"));
  const wrapperPath = NodePath.join(dir, "omp");
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh\nexport T3_OMP_ACP_FIXTURE_MODE=${JSON.stringify(mode)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(compatibilityFixturePath)} "$@"\n`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function waitForFileContent(
  filePath: string,
  attempts = 40,
  expectedContent?: string,
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const raw = await NodeFSP.readFile(filePath, "utf8");
      if (
        raw.trim().length > 0 &&
        (expectedContent === undefined || raw.includes(expectedContent))
      ) {
        return raw;
      }
    } catch {}
    await NodeTimersPromises.setTimeout(25);
  }
  throw new Error(`Timed out waiting for file content at ${filePath}`);
}

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-omp-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it("requires an OMP prompt settlement to match the active ACP session and turn", () => {
  assert.isFalse(
    ompPromptSettlementBelongsToContext({
      liveAcpSessionId: "new-session",
      expectedAcpSessionId: "old-session",
      liveActiveTurnId: undefined,
      liveSessionActiveTurnId: undefined,
      turnId: "turn" as never,
    }),
  );
});

it("uses OMP's native steering extension and recognizes its idle fallback", () => {
  assert.deepEqual(buildOmpSteerRequest("omp-session", "continue with tests"), {
    method: "_omp/session/steer",
    payload: { sessionId: "omp-session", text: "continue with tests" },
  });
  assert.deepEqual(parseOmpSteerResult({ accepted: true, state: "streaming" }), {
    accepted: true,
    state: "streaming",
  });
  assert.deepEqual(parseOmpSteerResult({ accepted: false, state: "idle" }), {
    accepted: false,
    state: "idle",
  });
});

it("advances OMP replay cursors contiguously and rejects gaps and duplicate boundaries", () => {
  assert.deepEqual(advanceOmpEventCursor({ currentSequence: 4 }), {
    sequence: 5,
    duplicate: false,
  });
  assert.deepEqual(advanceOmpEventCursor({ currentSequence: 4, sourceSequence: 5 }), {
    sequence: 5,
    duplicate: false,
  });
  assert.throws(
    () => advanceOmpEventCursor({ currentSequence: 4, sourceSequence: 7 }),
    /expected 5, received 7/,
  );
  assert.deepEqual(advanceOmpEventCursor({ currentSequence: 7, sourceSequence: 7 }), {
    sequence: 7,
    duplicate: true,
  });
  assert.deepEqual(advanceOmpEventCursor({ currentSequence: 7, sourceSequence: 6 }), {
    sequence: 6,
    duplicate: true,
  });
});

it("restores legacy and monotonic OMP resume cursors with stable event identities", () => {
  assert.deepEqual(parseOmpResume({ schemaVersion: 1, sessionId: "omp-session" }), {
    sessionId: "omp-session",
    eventSequence: 0,
    acpSequence: 0,
  });
  assert.deepEqual(
    parseOmpResume({ schemaVersion: 2, sessionId: "omp-session", eventSequence: 41 }),
    { sessionId: "omp-session", eventSequence: 41, acpSequence: 0 },
  );
  assert.deepEqual(
    parseOmpResume({
      schemaVersion: 3,
      sessionId: "omp-session",
      eventSequence: 41,
      acpSequence: 9,
      activeTurnId: "turn-crashed",
    }),
    {
      sessionId: "omp-session",
      eventSequence: 41,
      acpSequence: 9,
      activeTurnId: TurnId.make("turn-crashed"),
    },
  );
  assert.equal(makeOmpEventId("omp-session", 42), "omp:omp-session:42");
  assert.equal(
    makeOmpSourceEventId("omp-session", 9, "content:assistant_text"),
    "omp:omp-session:acp:9:content%3Aassistant_text",
  );
});

it("starts a fresh OMP runtime at sequence zero unless the durable session identity matches", () => {
  const persisted = parseOmpResume({
    schemaVersion: 3,
    sessionId: "durable-session",
    eventSequence: 41,
    acpSequence: 9,
  });
  assert.deepEqual(resumedOmpCursorForSession("durable-session", persisted), persisted);
  assert.isUndefined(resumedOmpCursorForSession("fresh-session", persisted));
});

it.layer(testLayer)("OmpAdapter", (it) => {
  it.effect("starts omp acp and streams a complete prompt turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const events: ProviderRuntimeEvent[] = [];
      const completed = yield* Deferred.make<void>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "omp");
      assert.deepEqual(session.resumeCursor, {
        schemaVersion: 3,
        sessionId: "mock-session-1",
        eventSequence: 3,
        acpSequence: 0,
      });

      yield* adapter.sendTurn({ threadId, input: "hello omp", attachments: [] });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventFiber);

      assert.includeMembers(
        events.map((event) => event.type),
        ["session.started", "turn.started", "content.delta", "turn.completed"],
      );
      const delta = events.find((event) => event.type === "content.delta");
      assert.equal(
        delta?.type === "content.delta" ? delta.payload.delta : undefined,
        "hello from mock",
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("continues stable event ids after a process-style session restart", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-restart-cursor");
      const wrapperPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const first = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const firstEvents: ProviderRuntimeEvent[] = [];
      const exited = yield* Deferred.make<void>();
      const firstEventFiber = yield* Stream.runForEach(first.streamEvents, (event) =>
        Effect.sync(() => firstEvents.push(event)).pipe(
          Effect.andThen(
            event.type === "session.exited"
              ? Deferred.succeed(exited, undefined).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* first.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const firstTurn = yield* first.sendTurn({ threadId, input: "checkpoint", attachments: [] });
      const firstCursor = parseOmpResume(firstTurn.resumeCursor);
      assert.isDefined(firstCursor);
      yield* first.stopSession(threadId);
      yield* Deferred.await(exited);
      yield* Fiber.interrupt(firstEventFiber);

      const sessionExited = firstEvents.find((event) => event.type === "session.exited");
      assert.equal(sessionExited?.type, "session.exited");
      assert.deepEqual(sessionExited?.resumeCursor, {
        schemaVersion: 3,
        sessionId: "mock-session-1",
        eventSequence: (firstCursor?.eventSequence ?? 0) + 1,
        acpSequence: firstCursor?.acpSequence ?? 0,
      });
      const exitCursor = parseOmpResume(sessionExited?.resumeCursor);
      assert.deepEqual(exitCursor, {
        sessionId: "mock-session-1",
        eventSequence: (firstCursor?.eventSequence ?? 0) + 1,
        acpSequence: firstCursor?.acpSequence ?? 0,
      });
      assert.equal(
        sessionExited?.eventId,
        makeOmpEventId("mock-session-1", exitCursor?.eventSequence ?? 0),
      );

      const second = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const resumedEvents: ProviderRuntimeEvent[] = [];
      const eventFiber = yield* Stream.runForEach(second.streamEvents, (event) =>
        Effect.sync(() => resumedEvents.push(event)),
      ).pipe(Effect.forkChild);
      const resumed = yield* second.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: sessionExited?.resumeCursor,
      });
      yield* Fiber.interrupt(eventFiber);

      const resumedCursor = parseOmpResume(resumed.resumeCursor);
      assert.isDefined(resumedCursor);
      assert.equal(resumedCursor?.eventSequence, (exitCursor?.eventSequence ?? 0) + 3);
      assert.deepEqual(
        resumedEvents.map((event) => event.eventId),
        [1, 2, 3].map((offset) =>
          makeOmpEventId("mock-session-1", (exitCursor?.eventSequence ?? 0) + offset),
        ),
      );
      yield* second.stopSession(threadId);
    }),
  );

  it.effect("steers the restored active turn instead of opening a concurrent prompt", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-resume-active-turn");
      const activeTurnId = TurnId.make("turn-in-flight");
      const requestLogPath = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-resume-steer-log-")).then((dir) =>
          NodePath.join(dir, "requests.ndjson"),
        ),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_OMP_STEER_STATE: "streaming",
        }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const events: ProviderRuntimeEvent[] = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);

      const resumed = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: {
          schemaVersion: 3,
          sessionId: "mock-session-1",
          eventSequence: 20,
          acpSequence: 0,
          activeTurnId,
        },
      });
      const steered = yield* adapter.sendTurn({
        threadId,
        input: "continue the restored turn",
        attachments: [],
      });
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(eventFiber);

      assert.equal(resumed.status, "running");
      assert.equal(resumed.activeTurnId, activeTurnId);
      assert.equal(steered.turnId, activeTurnId);
      const liveSession = (yield* adapter.listSessions())[0];
      assert.equal(liveSession?.status, "running");
      assert.equal(liveSession?.activeTurnId, activeTurnId);
      const lifecycle = events.find((event) => event.type === "session.state.changed");
      assert.equal(lifecycle?.type, "session.state.changed");
      if (lifecycle?.type === "session.state.changed") {
        assert.equal(lifecycle.payload.state, "running");
        assert.equal(lifecycle.payload.reason, "OMP ACP session resumed with an active turn");
      }
      assert.isFalse(events.some((event) => event.type === "turn.started"));
      const requestLog = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      assert.include(requestLog, '"method":"_omp/session/steer"');
      assert.include(
        requestLog,
        '"sessionId":"mock-session-1","text":"continue the restored turn"',
      );
      assert.notInclude(requestLog, '"method":"session/prompt"');
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("replays only the uncheckpointed ACP tail with a stable source event id", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-crash-tail");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ T3_ACP_EMIT_LOAD_REPLAY: "1" }),
      );
      const first = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const firstEvents: ProviderRuntimeEvent[] = [];
      const firstFiber = yield* Stream.runForEach(first.streamEvents, (event) =>
        Effect.sync(() => firstEvents.push(event)),
      ).pipe(Effect.forkChild);

      yield* first.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: {
          schemaVersion: 3,
          sessionId: "mock-session-1",
          eventSequence: 20,
          acpSequence: 1,
          activeTurnId: "turn-crashed",
        },
      });
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(firstFiber);

      const replayed = firstEvents.filter(
        (event) => event.eventId === "omp:mock-session-1:acp:2:content%3Aassistant_text",
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "content.delta");
      assert.deepEqual(replayed[0]?.resumeCursor, {
        schemaVersion: 3,
        sessionId: "mock-session-1",
        eventSequence: 21,
        acpSequence: 2,
        activeTurnId: "turn-crashed",
      });
      yield* first.stopSession(threadId);

      const second = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const secondEvents: ProviderRuntimeEvent[] = [];
      const secondFiber = yield* Stream.runForEach(second.streamEvents, (event) =>
        Effect.sync(() => secondEvents.push(event)),
      ).pipe(Effect.forkChild);
      yield* second.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: {
          schemaVersion: 3,
          sessionId: "mock-session-1",
          eventSequence: 21,
          acpSequence: 2,
          activeTurnId: "turn-crashed",
        },
      });
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(secondFiber);
      assert.equal(
        secondEvents.some(
          (event) => event.eventId === "omp:mock-session-1:acp:2:content%3Aassistant_text",
        ),
        false,
      );
      yield* second.stopSession(threadId);
    }),
  );

  it.effect("keeps canonical ACP source event ids and cursors stable across fixture restarts", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-compat-restart");
      const wrapperPath = yield* Effect.promise(() => makeOmpCompatibilityWrapper());
      const initialResumeCursor = {
        schemaVersion: 3 as const,
        sessionId: "omp-compat-session",
        eventSequence: 40,
        acpSequence: 0,
        activeTurnId: "turn-replay",
      };
      const expectedSourceEventIds = [
        makeOmpSourceEventId("omp-compat-session", 1, "content:fixture-reasoning"),
        makeOmpSourceEventId("omp-compat-session", 2, "tool:fixture-command"),
        makeOmpSourceEventId("omp-compat-session", 3, "tool:fixture-command"),
        makeOmpSourceEventId("omp-compat-session", 4, "tool:fixture-command"),
        makeOmpSourceEventId("omp-compat-session", 5, "content:fixture-assistant"),
      ];

      const first = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const firstEventsFiber = yield* Stream.take(first.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      const firstSession = yield* first.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: initialResumeCursor,
      });
      const firstEvents = Array.from(yield* Fiber.join(firstEventsFiber));
      assert.deepEqual(
        firstEvents
          .map((event) => String(event.eventId))
          .filter((eventId) => eventId.includes(":acp:")),
        expectedSourceEventIds,
      );
      assert.deepEqual(firstSession.resumeCursor, {
        schemaVersion: 3,
        sessionId: "omp-compat-session",
        eventSequence: 48,
        acpSequence: 5,
        activeTurnId: "turn-replay",
      });
      yield* first.stopSession(threadId);

      const restarted = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const restartedEventsFiber = yield* Stream.take(restarted.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* restarted.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: initialResumeCursor,
      });
      const restartedEvents = Array.from(yield* Fiber.join(restartedEventsFiber));
      assert.deepEqual(
        restartedEvents
          .map((event) => String(event.eventId))
          .filter((eventId) => eventId.includes(":acp:")),
        expectedSourceEventIds,
      );
      yield* restarted.stopSession(threadId);

      const checkpointed = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const checkpointedEventsFiber = yield* Stream.take(checkpointed.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      const checkpointedSession = yield* checkpointed.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: firstSession.resumeCursor,
      });
      const checkpointedEvents = Array.from(yield* Fiber.join(checkpointedEventsFiber));
      assert.equal(
        checkpointedEvents.some((event) => String(event.eventId).includes(":acp:")),
        false,
      );
      assert.deepEqual(checkpointedSession.resumeCursor, {
        schemaVersion: 3,
        sessionId: "omp-compat-session",
        eventSequence: 51,
        acpSequence: 5,
        activeTurnId: "turn-replay",
      });
      yield* checkpointed.stopSession(threadId);
    }),
  );

  it.effect(
    "covers OMP terminal-equivalent ACP execute tool calls without native terminal events",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("omp-compat-lifecycle");
        const wrapperPath = yield* Effect.promise(() => makeOmpCompatibilityWrapper());
        const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
        const events: ProviderRuntimeEvent[] = [];
        const requested =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
        const completed = yield* Deferred.make<void>();
        const exited = yield* Deferred.make<void>();
        const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => events.push(event)).pipe(
            Effect.andThen(
              event.type === "user-input.requested"
                ? Deferred.succeed(requested, event).pipe(Effect.ignore)
                : event.type === "turn.completed"
                  ? Deferred.succeed(completed, undefined).pipe(Effect.ignore)
                  : event.type === "session.exited"
                    ? Deferred.succeed(exited, undefined).pipe(Effect.ignore)
                    : Effect.void,
            ),
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const sendTurnFiber = yield* adapter
          .sendTurn({ threadId, input: "run compatibility fixture", attachments: [] })
          .pipe(Effect.forkChild);
        const requestedEvent = yield* Deferred.await(requested);
        assert.deepEqual(requestedEvent.payload.questions, [
          {
            id: "scope",
            header: "Fixture input",
            question: "Which scope should the fixture use?",
            options: [
              { label: "workspace", description: "workspace" },
              { label: "session", description: "session" },
            ],
            multiSelect: false,
          },
        ]);
        yield* adapter.respondToUserInput(
          threadId,
          ApprovalRequestId.make(String(requestedEvent.requestId)),
          { scope: "workspace" },
        );
        yield* Fiber.join(sendTurnFiber);
        yield* Deferred.await(completed);
        yield* adapter.stopSession(threadId);
        yield* Deferred.await(exited);
        yield* Fiber.interrupt(eventFiber);

        assert.deepEqual(
          events.map((event) => event.type),
          [
            "session.started",
            "session.state.changed",
            "thread.started",
            "turn.started",
            "item.started",
            "content.delta",
            "item.completed",
            "item.updated",
            "item.completed",
            "user-input.requested",
            "user-input.resolved",
            "item.started",
            "content.delta",
            "item.completed",
            "turn.completed",
            "session.exited",
          ],
        );
        const content = events.filter((event) => event.type === "content.delta");
        assert.deepEqual(
          content.map((event) => [event.payload.streamKind, event.payload.delta]),
          [
            ["reasoning_text", "fixture reasoning"],
            ["assistant_text", "fixture assistant output"],
          ],
        );
        assert.deepEqual(
          events.flatMap((event) =>
            (event.type === "item.updated" || event.type === "item.completed") &&
            String(event.itemId) === "fixture-command"
              ? [event.payload.status]
              : [],
          ),
          ["inProgress", "completed"],
        );
        const commandCompleted = events.find(
          (event) => event.type === "item.completed" && String(event.itemId) === "fixture-command",
        );
        assert.equal(commandCompleted?.type, "item.completed");
        if (commandCompleted?.type === "item.completed") {
          assert.deepEqual(commandCompleted.payload.data, {
            toolCallId: "fixture-command",
            kind: "execute",
            command: "printf fixture-output",
            rawInput: { command: ["printf", "fixture-output"] },
            rawOutput: { exitCode: 0, stdout: "fixture-output", stderr: "" },
          });
        }
        const turnCompleted = events.find((event) => event.type === "turn.completed");
        assert.equal(turnCompleted?.type, "turn.completed");
        if (turnCompleted?.type === "turn.completed") {
          assert.deepEqual(turnCompleted.payload, { state: "completed", stopReason: "end_turn" });
        }
        const sessionExited = events.find((event) => event.type === "session.exited");
        assert.equal(sessionExited?.type, "session.exited");
        if (sessionExited?.type === "session.exited") {
          assert.deepEqual(sessionExited.payload, { exitKind: "graceful" });
        }
      }),
  );

  it.effect("terminalizes a deterministic ACP runtime error as a failed turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-compat-error");
      const wrapperPath = yield* Effect.promise(() => makeOmpCompatibilityWrapper("error"));
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const events: ProviderRuntimeEvent[] = [];
      const failed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" && event.payload.state === "failed"
              ? Deferred.succeed(failed, event).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const error = yield* Effect.flip(
        adapter.sendTurn({ threadId, input: "fixture error", attachments: [] }),
      );
      const failedEvent = yield* Deferred.await(failed);
      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.include(error.message, "Deterministic OMP compatibility fixture failure");
      assert.equal(failedEvent.payload.state, "failed");
      assert.include(
        failedEvent.payload.errorMessage ?? "",
        "Deterministic OMP compatibility fixture failure",
      );
      assert.deepEqual(
        events
          .filter((event) => event.type === "turn.started" || event.type === "turn.completed")
          .map((event) => event.type),
        ["turn.started", "turn.completed"],
      );

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventFiber);
    }),
  );

  it.effect("sends generic attachments as ACP resource links without embedding file bytes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-file-attachment");
      const requestLogPath = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-request-log-")).then((dir) =>
          NodePath.join(dir, "requests.ndjson"),
        ),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const { attachmentsDir } = yield* ServerConfig;
      const attachmentId = "omp-file-attachment-00000000-0000-4000-8000-000000000001";
      const attachmentPath = NodePath.join(attachmentsDir, `${attachmentId}.bin`);
      yield* Effect.promise(() =>
        NodeFSP.mkdir(attachmentsDir, { recursive: true }).then(() =>
          NodeFSP.writeFile(attachmentPath, "sensitive-file-contents", "utf8"),
        ),
      );
      const completed = yield* Deferred.make<void>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "inspect the attachment",
        attachments: [
          {
            type: "file",
            id: attachmentId,
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 23,
          },
        ],
      });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventFiber);

      const requestLog = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      const promptLine = requestLog
        .split("\n")
        .find((line) => line.includes('"method":"session/prompt"'));
      assert.isDefined(promptLine);
      assert.include(promptLine ?? "", '"type":"resource_link"');
      assert.include(promptLine ?? "", '"name":"notes.txt"');
      assert.include(promptLine ?? "", NodeURL.pathToFileURL(attachmentPath).href);
      assert.notInclude(promptLine ?? "", "sensitive-file-contents");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("invokes provider-qualified OMP skills using native ACP command syntax", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-command-skill");
      const requestLogPath = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-command-skill-")).then((dir) =>
          NodePath.join(dir, "requests.ndjson"),
        ),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const completed = yield* Deferred.make<void>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Use @[skill|omp|skill%3Areview] and keep @[session|local|thread-1|] intact ",
        attachments: [],
      });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventFiber);

      const requestLog = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      const promptLine = requestLog
        .split("\n")
        .find((line) => line.includes('"method":"session/prompt"'));
      assert.include(promptLine ?? "", "Use /skill:review");
      assert.include(promptLine ?? "", "session_reference_resolve");
      assert.include(promptLine ?? "", "session_message_send");
      assert.notInclude(promptLine ?? "", "@[skill|omp|skill%3Areview]");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("preserves OMP thinking, usage, and session metadata updates", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-native-updates");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ T3_ACP_EMIT_OMP_SESSION_UPDATES: "1" }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const events: ProviderRuntimeEvent[] = [];
      const completed = yield* Deferred.make<void>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "inspect", attachments: [] });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventFiber);

      const deltas = events.filter((event) => event.type === "content.delta");
      assert.deepEqual(
        deltas.map((event) => event.payload.streamKind),
        ["reasoning_text", "assistant_text"],
      );
      assert.includeMembers(
        events.map((event) => event.type),
        ["thread.token-usage.updated", "thread.metadata.updated"],
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("projects OMP's resolved model and effort across runtime reroutes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-model-authority");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_EMIT_OMP_SESSION_UPDATES: "1",
          T3_ACP_OMP_CONFIG_OPTIONS: "1",
          T3_ACP_OMP_RUNTIME_MODEL: "anthropic/claude-sonnet-5",
          T3_ACP_OMP_RUNTIME_THINKING: "high",
        }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const events: ProviderRuntimeEvent[] = [];
      const completed = yield* Deferred.make<void>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "openai/gpt-5.6",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
      });
      yield* adapter.sendTurn({ threadId, input: "inspect", attachments: [] });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventFiber);

      const turnStarted = events.find((event) => event.type === "turn.started");
      assert.deepEqual(turnStarted?.payload, {
        model: "openai/gpt-5.6",
        effort: "low",
      });
      const rerouted = events.find((event) => event.type === "model.rerouted");
      assert.deepEqual(rerouted?.payload, {
        fromModel: "openai/gpt-5.6",
        toModel: "anthropic/claude-sonnet-5",
        reason: "omp.config_option_update",
        effort: "high",
      });
      const session = (yield* adapter.listSessions())[0];
      assert.isDefined(session);
      assert.equal(session.model, "anthropic/claude-sonnet-5");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects a model missing from the live OMP catalog before setting ACP config", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-disabled-provider-model");
      const requestLogPath = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-model-unavailable-log-")).then(
          (dir) => NodePath.join(dir, "requests.ndjson"),
        ),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_OMP_CONFIG_OPTIONS: "1",
        }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("omp"),
            model: "anthropic/claude-fable-5",
          },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag === "ProviderAdapterValidationError") {
        assert.equal(error.operation, "startSession/selected-provider-unavailable");
        assert.include(error.issue, 'Selected model "anthropic/claude-fable-5" is unavailable');
        assert.include(error.issue, "Reconnect Claude or switch models");
      }
      const requestLog = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      assert.notInclude(requestLog, '"method":"session/set_config_option"');
    }),
  );

  it.effect("rejects an active Scaffold model outside the launch-time allowlist", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-scaffold-model-policy");
      const requestLogPath = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-scaffold-policy-log-")).then(
          (dir) => NodePath.join(dir, "requests.ndjson"),
        ),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_OMP_CONFIG_OPTIONS: "1",
        }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }), {
        environment: {
          ...process.env,
          SCAFFOLD_RUNTIME_PROFILE: "agent_t3_omp",
          OMP_AGENT_MODEL: "openai/gpt-5.6",
          OMP_AGENT_ALLOWED_MODELS: "openai/gpt-5.6",
        },
      });

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("omp"),
            model: "anthropic/claude-sonnet-5",
          },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag === "ProviderAdapterValidationError") {
        assert.equal(error.operation, "startSession/model-policy");
        assert.include(error.issue, 'Model "anthropic/claude-sonnet-5" is not allowed');
      }
      const requestLog = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      assert.notInclude(requestLog, '"method":"session/set_config_option"');
    }),
  );

  it.effect("rejects a managed mid-session model switch outside the launch allowlist", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-scaffold-model-switch-policy");
      const requestLogPath = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-scaffold-switch-log-")).then(
          (dir) => NodePath.join(dir, "requests.ndjson"),
        ),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_OMP_CONFIG_OPTIONS: "1",
        }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }), {
        environment: {
          ...process.env,
          SCAFFOLD_RUNTIME_PROFILE: "agent_t3_omp",
          OMP_AGENT_MODEL: "openai/gpt-5.6",
          OMP_AGENT_ALLOWED_MODELS: "openai/gpt-5.6",
        },
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "openai/gpt-5.6",
        },
      });
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "try a forbidden model",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("omp"),
            model: "anthropic/claude-sonnet-5",
          },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag === "ProviderAdapterValidationError") {
        assert.equal(error.operation, "sendTurn/model-policy");
      }
      const requestLog = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      assert.notInclude(requestLog, '"method":"session/set_config_option"');
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("routes a mid-turn text send through OMP native steering", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-native-steer");
      const requestLogPath = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-steer-log-")).then((dir) =>
          NodePath.join(dir, "requests.ndjson"),
        ),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_HANG_PROMPT_FOREVER: "1",
          T3_ACP_OMP_STEER_STATE: "streaming",
        }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const startedTurn = yield* Deferred.make<TurnId>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.started" && event.turnId
          ? Deferred.succeed(startedTurn, event.turnId).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "first", attachments: [] })
        .pipe(Effect.forkChild);
      const activeTurnId = yield* Deferred.await(startedTurn);
      const steered = yield* adapter.sendTurn({ threadId, input: "steer", attachments: [] });

      assert.equal(steered.turnId, activeTurnId);
      const requestLog = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      assert.include(requestLog, '"method":"_omp/session/steer"');
      assert.include(requestLog, '"sessionId":"mock-session-1","text":"steer"');

      yield* Fiber.interrupt(firstTurnFiber);
      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventFiber);
    }),
  );

  it.effect("sends ACP cancellation before an active OMP interrupt completes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-native-interrupt");
      const requestLogPath = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-interrupt-log-")).then((dir) =>
          NodePath.join(dir, "requests.ndjson"),
        ),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_HANG_PROMPT_FOREVER: "1",
          T3_ACP_REQUIRE_ACTIVE_PROMPT_FOR_CANCEL: "1",
        }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      const startedTurn = yield* Deferred.make<TurnId>();
      const completedTurn = yield* Deferred.make<ProviderRuntimeEvent>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type === "turn.started" && event.turnId) {
          return Deferred.succeed(startedTurn, event.turnId).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(completedTurn, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const promptFiber = yield* adapter
        .sendTurn({ threadId, input: "hang until interrupted", attachments: [] })
        .pipe(Effect.forkChild);
      const activeTurnId = yield* Deferred.await(startedTurn);
      yield* adapter.interruptTurn(threadId, activeTurnId);

      const requestLog = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      const requestLines = requestLog.split("\n").filter((line) => line.trim().length > 0);
      const promptRequestIndex = requestLines.findIndex((line) =>
        line.includes('"method":"session/prompt"'),
      );
      const cancelRequestIndex = requestLines.findIndex((line) =>
        line.includes('"method":"session/cancel"'),
      );
      assert.isAtLeast(promptRequestIndex, 0);
      assert.isAbove(cancelRequestIndex, promptRequestIndex);
      const cancelRequests = requestLines
        .filter((line) => line.includes('"method":"session/cancel"'))
        .map((line) => JSON.parse(line) as unknown);
      assert.deepEqual(cancelRequests, [
        {
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId: "mock-session-1" },
        },
      ]);

      yield* Fiber.join(promptFiber).pipe(Effect.timeout("2 seconds"));
      const completed = yield* Deferred.await(completedTurn).pipe(Effect.timeout("2 seconds"));
      assert.equal(completed.turnId, activeTurnId);
      assert.deepInclude(completed.payload, {
        state: "cancelled",
        stopReason: "cancelled",
      });

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventFiber);
    }),
  );

  it.effect(
    "fails the turn and discards the OMP session when cancel triggers a prompt rejection",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("omp-native-interrupt-failure");
        const requestLogPath = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-interrupt-failure-log-")).then(
            (dir) => NodePath.join(dir, "requests.ndjson"),
          ),
        );
        const wrapperPath = yield* Effect.promise(() =>
          makeMockOmpWrapper({
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            T3_ACP_HANG_PROMPT_FOREVER: "1",
            T3_ACP_FAIL_PROMPT_ON_CANCEL: "1",
          }),
        );
        const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
        const startedTurn = yield* Deferred.make<TurnId>();
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }).pipe(
            Effect.andThen(
              event.type === "turn.started" && event.turnId
                ? Deferred.succeed(startedTurn, event.turnId).pipe(Effect.ignore)
                : Effect.void,
            ),
          ),
        ).pipe(Effect.forkChild);
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        const promptFiber = yield* adapter
          .sendTurn({ threadId, input: "fail while interrupting", attachments: [] })
          .pipe(Effect.forkChild);
        const activeTurnId = yield* Deferred.await(startedTurn).pipe(Effect.timeout("2 seconds"));
        yield* Effect.promise(() =>
          waitForFileContent(requestLogPath, 80, '"method":"session/prompt"'),
        );

        const interruptError = yield* Effect.flip(
          adapter.interruptTurn(threadId, activeTurnId).pipe(Effect.timeout("3 seconds")),
        );
        assert.equal(interruptError._tag, "ProviderAdapterRequestError");
        if (interruptError._tag === "ProviderAdapterRequestError") {
          assert.equal(interruptError.method, "session/cancel");
          assert.include(interruptError.detail, "Mock cancel cleanup failure");
        }

        const promptError = yield* Effect.flip(
          Fiber.join(promptFiber).pipe(Effect.timeout("3 seconds")),
        );
        assert.equal(promptError._tag, "ProviderAdapterRequestError");
        if (promptError._tag === "ProviderAdapterRequestError") {
          assert.equal(promptError.method, "session/prompt");
          assert.include(promptError.detail, "Mock cancel cleanup failure");
        }

        const terminalEvents = runtimeEvents.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && event.turnId === activeTurnId,
        );
        assert.lengthOf(terminalEvents, 1);
        assert.deepInclude(terminalEvents[0]?.payload, {
          state: "failed",
        });
        assert.include(
          terminalEvents[0]?.payload.state === "failed"
            ? terminalEvents[0].payload.errorMessage
            : "",
          "Mock cancel cleanup failure",
        );
        assert.isFalse(
          terminalEvents.some(
            (event) =>
              event.payload.state === "cancelled" || event.payload.stopReason === "cancelled",
          ),
        );
        const sessionExited = runtimeEvents.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "session.exited" }> =>
            event.type === "session.exited" && event.threadId === threadId,
        );
        assert.deepEqual(sessionExited?.payload, { exitKind: "error" });
        assert.isFalse(yield* adapter.hasSession(threadId));

        yield* Fiber.interrupt(eventFiber);
      }),
  );

  it.effect("configures the cross-provider advisor from OMP's live model catalog", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-advisor-policy");
      const requestLogPath = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-advisor-log-")).then((dir) =>
          NodePath.join(dir, "requests.ndjson"),
        ),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_OMP_ADVISOR_POLICY_OPTIONS: "1",
        }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath: wrapperPath }));
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "openai/gpt-5.6-terra",
        },
      });

      const requestLog = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
      const advisorRequest = requestLog
        .trim()
        .split("\n")
        .find(
          (line) =>
            line.includes('"method":"session/set_config_option"') &&
            line.includes('"configId":"advisor"'),
        );
      assert.include(advisorRequest ?? "", '"value":"anthropic/claude-sonnet-5:high"');
      yield* adapter.stopSession(threadId);
    }),
  );
});
