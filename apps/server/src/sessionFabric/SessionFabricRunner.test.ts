import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SessionFabricClientFrame as SessionFabricClientFrameSchema,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  SessionFabricSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

import {
  buildSessionFabricContextPublication,
  buildSessionFabricPublishedEvent,
  buildSessionFabricSnapshot,
  coalesceSessionFabricSnapshotRefreshes,
  makeSessionFabricWebSocketProtocols,
  makeSessionFabricWebSocketUrl,
  make as makeSessionFabricRunner,
  resolveSessionFabricRunnerConfig,
  resolveSessionFabricSessionId,
  requestLocalSessionFabricRunnerCapability,
  requestScaffoldSessionFabricRunnerCapability,
  SESSION_FABRIC_SNAPSHOT_REFRESH_WINDOW_MS,
  sessionFabricCommandReceipt,
  shouldPublishSessionFabricContext,
  sessionFabricCapabilityRefreshDelayMs,
  sessionFabricReconnectDelayMs,
} from "./SessionFabricRunner.ts";

type TestSocketEventType = "open" | "message" | "close" | "error";
type TestSocketEvent = {
  readonly code?: number;
  readonly data?: unknown;
  readonly reason?: string;
  readonly type: TestSocketEventType;
};
type TestSocketListener = (event: TestSocketEvent) => void;

class TestSessionFabricWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = TestSessionFabricWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  readonly protocols: string | string[] | undefined;
  private readonly listeners = new Map<TestSocketEventType, Set<TestSocketListener>>();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  addEventListener(type: TestSocketEventType, listener: TestSocketListener, _options?: unknown) {
    const listeners = this.listeners.get(type) ?? new Set<TestSocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: TestSocketEventType, listener: TestSocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === TestSessionFabricWebSocket.CLOSED) return;
    this.readyState = TestSessionFabricWebSocket.CLOSED;
    this.emit("close", { type: "close", code, reason });
  }

  open() {
    this.readyState = TestSessionFabricWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  closeFromPeer(code: number, reason: string) {
    this.readyState = TestSessionFabricWebSocket.CLOSED;
    this.emit("close", { type: "close", code, reason });
  }

  private emit(type: TestSocketEventType, event: TestSocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const decodeTestClientFrame = Schema.decodeUnknownSync(
  Schema.fromJsonString(SessionFabricClientFrameSchema),
);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const awaitSocket = Effect.fn("SessionFabricRunnerTest.await_socket")(function* (
  sockets: ReadonlyArray<TestSessionFabricWebSocket>,
  index: number,
) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const socket = sockets[index];
    if (socket !== undefined) return socket;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error(`Expected session fabric socket ${index + 1}.`));
});

const awaitFrame = Effect.fn("SessionFabricRunnerTest.await_frame")(function* (
  socket: TestSessionFabricWebSocket,
  type: ReturnType<typeof decodeTestClientFrame>["type"],
) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const frame = socket.sent
      .map((sent) => decodeTestClientFrame(sent))
      .find((candidate) => candidate.type === type);
    if (frame !== undefined) return frame;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error(`Expected session fabric frame '${type}'.`));
});

describe("SessionFabricRunner", () => {
  it("keeps a deterministic local session id and applies a handoff override only to its thread", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const targetThreadId = ThreadId.make("thread-1");
    const otherThreadId = ThreadId.make("thread-2");
    const overrideSessionId = SessionFabricSessionId.make("global-session-1");
    expect(
      resolveSessionFabricSessionId({
        environmentId,
        threadId: targetThreadId,
        overrideSessionId,
        overrideThreadId: targetThreadId,
      }),
    ).toBe(overrideSessionId);
    expect(
      resolveSessionFabricSessionId({
        environmentId,
        threadId: otherThreadId,
        overrideSessionId,
        overrideThreadId: targetThreadId,
      }),
    ).toBe("sf:environment-1:thread-2");
  });

  it("derives Scaffold mode from the actual sandbox session and builds the DO socket URL", () => {
    const config = resolveSessionFabricRunnerConfig({
      relayUrl: Option.some(new URL("https://relay.example.test/base/")),
      environmentKind: Option.none(),
      publication: "public",
      runnerGeneration: -2,
      overrideSessionId: Option.none(),
      overrideThreadId: Option.none(),
      scaffoldSessionId: Option.some("ses_scaffold"),
      scaffoldSessionUrl: Option.none(),
      scaffoldSessionDetailUrl: Option.none(),
      scaffoldCapabilityBaseUrl: Option.some(new URL("https://worker.example.test/")),
      scaffoldLifecycleEpoch: Option.some(4),
      runtimeApiToken: Option.some("runtime-secret"),
      authMode: "required",
      capabilityDeployment: Option.none(),
      scaffoldDefaultDeployment: Option.none(),
    });
    expect(config.environmentKind).toBe("scaffold");
    expect(config.runnerGeneration).toBe(4);
    expect(config.scaffoldLifecycleEpoch).toBe(4);
    expect(config.scaffoldCapabilityBaseUrl?.toString()).toBe("https://worker.example.test/");
    expect(
      makeSessionFabricWebSocketUrl(
        config.relayUrl!,
        SessionFabricSessionId.make("global-session-1"),
      )?.toString(),
    ).toBe("wss://relay.example.test/base/v1/session-fabric/sessions/global-session-1/connect");
  });

  it("publishes a session-scoped snapshot with searchable transcript context", () => {
    const threadId = ThreadId.make("thread-1");
    const project = {
      id: "project-1",
      title: "Harness",
      workspaceRoot: "/workspace/harness",
    };
    const threadShell = {
      id: threadId,
      projectId: "project-1",
      title: "Repair the relay",
    };
    const shell = {
      snapshotSequence: 8,
      projects: [project],
      threads: [threadShell],
      updatedAt: "2026-07-24T20:00:00.000Z",
    } as unknown as OrchestrationShellSnapshot;
    const detail = {
      snapshotSequence: 8,
      thread: {
        id: threadId,
        projectId: "project-1",
        title: "Repair the relay",
        worktreePath: "/workspace/worktrees/thread-1",
        messages: [
          {
            role: "user",
            text: "Make multiplayer reliable",
          },
          {
            role: "assistant",
            text: "The stream now reconnects.",
          },
        ],
        activities: [
          {
            id: "activity-1",
            tone: "info",
            kind: "context-window.updated",
            summary: "Earlier full searchable context",
            payload: { usedTokens: 100 },
            turnId: "turn-1",
            createdAt: "2026-07-24T19:30:00.000Z",
          },
          {
            id: "activity-2",
            tone: "info",
            kind: "context-window.updated",
            summary: "Ran the focused test",
            payload: { usedTokens: 200 },
            turnId: "turn-1",
            createdAt: "2026-07-24T19:31:00.000Z",
          },
        ],
        proposedPlans: [],
        createdAt: "2026-07-24T19:00:00.000Z",
        updatedAt: "2026-07-24T20:00:00.000Z",
      },
    } as unknown as OrchestrationThreadDetailSnapshot;
    const snapshot = buildSessionFabricSnapshot({
      sessionId: SessionFabricSessionId.make("global-session-1"),
      environmentId: EnvironmentId.make("environment-1"),
      environmentKind: "scaffold",
      scaffoldSessionId: "ses_scaffold",
      scaffoldSessionUrl: "https://scaffold.example.test/sessions/ses_scaffold/agent",
      scaffoldSessionDetailUrl: "https://scaffold-agent.example.test/?q=ses_scaffold",
      scaffoldLifecycleEpoch: 3,
      publication: "public",
      acknowledgedEventSequence: 5,
      shell,
      detail,
    });
    expect(snapshot?.shell.projects).toEqual([project]);
    expect(snapshot?.shell.threads).toEqual([threadShell]);
    expect(snapshot?.session.initialPrompt).toBe("Make multiplayer reliable");
    expect(snapshot?.session.searchableText).toContain("The stream now reconnects.");
    expect(snapshot?.session.searchableText).toContain("Ran the focused test");
    expect(snapshot?.session.searchableText).toContain("Earlier full searchable context");
    expect(snapshot?.thread.thread.activities).toHaveLength(1);
    expect(snapshot?.thread.thread.activities[0]?.id).toBe("activity-2");
    expect(snapshot?.session.cursor).toEqual({ eventSequence: 5, snapshotSequence: 8 });
    expect(snapshot?.session.location).toMatchObject({
      environmentKind: "scaffold",
      scaffoldSessionId: "ses_scaffold",
      scaffoldSessionUrl: "https://scaffold.example.test/sessions/ses_scaffold/agent",
      scaffoldSessionDetailUrl: "https://scaffold-agent.example.test/?q=ses_scaffold",
      scaffoldLifecycleEpoch: 3,
    });
  });

  it("projects committed activity events before publishing them", () => {
    const published = buildSessionFabricPublishedEvent({
      sessionId: SessionFabricSessionId.make("global-session-1"),
      runnerId: "runner-1" as never,
      runnerGeneration: 2,
      event: {
        type: "thread.activity-appended",
        sequence: 12,
        aggregateKind: "thread",
        aggregateId: "thread-1",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-1",
            tone: "tool",
            kind: "tool.completed",
            summary: "Read a file",
            payload: {
              itemType: "tool_call",
              data: {
                path: "src/large.ts",
                rawOutput: { content: `first line\n${"x".repeat(4_000)}` },
                unusedProviderEnvelope: "discard me",
              },
            },
            turnId: "turn-1",
            createdAt: "2026-07-24T19:31:00.000Z",
          },
        },
      } as never,
    });

    expect(published.event.payload).toMatchObject({
      activity: {
        payload: {
          data: {
            files: [{ path: "src/large.ts" }],
            rawOutput: { content: "first line" },
          },
        },
      },
    });
    expect(JSON.stringify(published)).not.toContain("unusedProviderEnvelope");
    expect(JSON.stringify(published)).not.toContain("xxxx");
  });

  it.effect("coalesces continued snapshot refreshes at the fixed bounded window", () =>
    Effect.gen(function* () {
      const input = yield* Queue.unbounded<void>();
      const output = yield* Queue.unbounded<void>();
      yield* coalesceSessionFabricSnapshotRefreshes(Stream.fromQueue(input)).pipe(
        Stream.runForEach((refresh) => Queue.offer(output, refresh)),
        Effect.forkScoped,
      );

      yield* Queue.offer(input, undefined);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      yield* Queue.offer(input, undefined);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("999 millis");
      yield* Queue.offer(input, undefined);
      yield* Effect.yieldNow;

      expect(Option.isNone(yield* Queue.poll(output))).toBe(true);
      yield* TestClock.adjust("1 millis");
      yield* Queue.take(output);
      expect(Option.isNone(yield* Queue.poll(output))).toBe(true);
      expect(SESSION_FABRIC_SNAPSHOT_REFRESH_WINDOW_MS).toBe(2_000);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it("publishes context initially and only when checkpoint progress advances", () => {
    expect(
      shouldPublishSessionFabricContext({
        previousCheckpointTurnCount: null,
        checkpointTurnCount: 0,
        force: true,
      }),
    ).toBe(true);
    expect(
      shouldPublishSessionFabricContext({
        previousCheckpointTurnCount: 2,
        checkpointTurnCount: 2,
        force: false,
      }),
    ).toBe(false);
    expect(
      shouldPublishSessionFabricContext({
        previousCheckpointTurnCount: 2,
        checkpointTurnCount: 3,
        force: false,
      }),
    ).toBe(true);
    expect(
      shouldPublishSessionFabricContext({
        previousCheckpointTurnCount: 3,
        checkpointTurnCount: 2,
        force: false,
      }),
    ).toBe(true);
    expect(
      shouldPublishSessionFabricContext({
        previousCheckpointTurnCount: 2,
        checkpointTurnCount: 0,
        force: false,
      }),
    ).toBe(true);
  });

  it("authenticates the socket and spreads capability refreshes before expiry", () => {
    const grant = {
      capability: "header.payload.signature",
      tokenType: "Bearer",
      role: "runner",
      scopes: ["session:publish", "session:execute"],
      expiresAt: "2026-07-24T20:15:00.000Z",
      issuer: "scaffold",
      audience: "session-fabric",
      keyId: "proof-1",
      bindings: { scaffoldSessionId: "ses_scaffold", scaffoldLifecycleEpoch: 4 },
    } as const;
    expect(makeSessionFabricWebSocketProtocols(grant)).toEqual([
      "t3.session-fabric.v1",
      "t3.session-fabric.capability.header.payload.signature",
    ]);
    const now = Date.parse("2026-07-24T20:00:00.000Z");
    const expiresAt = Date.parse(grant.expiresAt);
    const firstIdentity = {
      sessionId: SessionFabricSessionId.make("sf:environment-1:thread-1"),
      threadId: ThreadId.make("thread-1"),
    };
    const secondIdentity = {
      sessionId: SessionFabricSessionId.make("sf:environment-2:thread-2"),
      threadId: ThreadId.make("thread-2"),
    };
    const firstDelay = sessionFabricCapabilityRefreshDelayMs(grant.expiresAt, now, firstIdentity);
    const secondDelay = sessionFabricCapabilityRefreshDelayMs(grant.expiresAt, now, secondIdentity);

    expect(firstDelay).toBe(
      sessionFabricCapabilityRefreshDelayMs(grant.expiresAt, now, firstIdentity),
    );
    expect(secondDelay).not.toBe(firstDelay);
    for (const delay of [firstDelay, secondDelay]) {
      const refreshAt = now + delay;
      expect(expiresAt - refreshAt).toBeGreaterThanOrEqual(30_000);
      expect(expiresAt - refreshAt).toBeLessThanOrEqual(90_000);
      expect(refreshAt).toBeLessThan(expiresAt);
    }
    expect(JSON.stringify({ protocols: makeSessionFabricWebSocketProtocols(null) })).not.toContain(
      grant.capability,
    );
    expect(makeSessionFabricWebSocketProtocols(null)).toEqual([]);
  });

  it("rejects an auth-disabled Scaffold runner", () => {
    expect(() =>
      resolveSessionFabricRunnerConfig({
        relayUrl: Option.some(new URL("https://relay.example.test/")),
        environmentKind: Option.some("scaffold"),
        publication: "public",
        runnerGeneration: 0,
        overrideSessionId: Option.none(),
        overrideThreadId: Option.none(),
        scaffoldSessionId: Option.some("ses_scaffold"),
        scaffoldSessionUrl: Option.some("https://scaffold.example.test/?q=ses_scaffold"),
        scaffoldSessionDetailUrl: Option.none(),
        scaffoldCapabilityBaseUrl: Option.some(new URL("https://worker.example.test/")),
        scaffoldLifecycleEpoch: Option.some(4),
        runtimeApiToken: Option.some("runtime-secret"),
        authMode: "disabled",
        capabilityDeployment: Option.none(),
        scaffoldDefaultDeployment: Option.none(),
      }),
    ).toThrow("only be disabled for a local runner");
  });

  it("backs off failed relay connections with a stable per-session spread", () => {
    const sessionId = "sf:environment-1:thread-1";
    const first = sessionFabricReconnectDelayMs(1, sessionId);
    const second = sessionFabricReconnectDelayMs(2, sessionId);
    const saturated = sessionFabricReconnectDelayMs(6, sessionId);

    expect(first).toBeGreaterThanOrEqual(1_000);
    expect(first).toBeLessThanOrEqual(1_250);
    expect(second).toBeGreaterThanOrEqual(2_000);
    expect(second).toBeLessThanOrEqual(2_500);
    expect(saturated).toBeGreaterThanOrEqual(24_000);
    expect(saturated).toBeLessThanOrEqual(30_000);
    expect(sessionFabricReconnectDelayMs(20, sessionId)).toBe(saturated);
    expect(sessionFabricReconnectDelayMs(1, "sf:environment-1:thread-2")).not.toBe(first);
  });

  it.effect("reconnects after an established socket EOF and republishes committed state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("environment-reconnect");
        const projectId = ProjectId.make("project-reconnect");
        const threadId = ThreadId.make("thread-reconnect");
        const sessionId = SessionFabricSessionId.make(`sf:${environmentId}:${threadId}`);
        const modelSelection = {
          instanceId: ProviderInstanceId.make("omp"),
          model: "openai/gpt-5.6-sol",
        } as const;
        const createdAt = "2026-07-24T19:00:00.000Z";
        let latestSequence = 12;
        let afterReconnect = false;

        const message = (sequence: number, text: string) => ({
          id: MessageId.make(`message-${sequence}`),
          role: "assistant" as const,
          text,
          turnId: null,
          streaming: false,
          createdAt: `2026-07-24T19:${sequence}:00.000Z`,
          updatedAt: `2026-07-24T19:${sequence}:00.000Z`,
        });
        const committedEvent = (sequence: number, text: string) =>
          ({
            sequence,
            eventId: EventId.make(`event-${sequence}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: `2026-07-24T19:${sequence}:00.000Z`,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.message-sent",
            payload: {
              threadId,
              messageId: MessageId.make(`message-${sequence}`),
              role: "assistant",
              text,
              turnId: null,
              streaming: false,
              createdAt: `2026-07-24T19:${sequence}:00.000Z`,
              updatedAt: `2026-07-24T19:${sequence}:00.000Z`,
            },
          }) as const;
        const beforeEvent = committedEvent(12, "Before the relay EOF");
        const recoveredEvent = committedEvent(13, "Authoritative state after reconnect");

        const shell = (): OrchestrationShellSnapshot => ({
          snapshotSequence: latestSequence,
          projects: [
            {
              id: projectId,
              title: "Reconnect project",
              workspaceRoot: "/workspace/reconnect",
              defaultModelSelection: modelSelection,
              scripts: [],
              createdAt,
              updatedAt: afterReconnect ? recoveredEvent.occurredAt : beforeEvent.occurredAt,
            },
          ],
          threads: [
            {
              id: threadId,
              projectId,
              title: "Reconnect the fabric runner",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              latestTurn: null,
              createdAt,
              updatedAt: afterReconnect ? recoveredEvent.occurredAt : beforeEvent.occurredAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              session: null,
              latestUserMessageAt: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: false,
            },
          ],
          updatedAt: afterReconnect ? recoveredEvent.occurredAt : beforeEvent.occurredAt,
        });
        const detail = (): OrchestrationThreadDetailSnapshot => ({
          snapshotSequence: latestSequence,
          thread: {
            id: threadId,
            projectId,
            title: "Reconnect the fabric runner",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            latestTurn: null,
            createdAt,
            updatedAt: afterReconnect ? recoveredEvent.occurredAt : beforeEvent.occurredAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            deletedAt: null,
            messages: [
              message(12, "Before the relay EOF"),
              ...(afterReconnect ? [message(13, "Authoritative state after reconnect")] : []),
            ],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
        });

        const sockets: TestSessionFabricWebSocket[] = [];
        const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            class TestWebSocketConstructor extends TestSessionFabricWebSocket {
              constructor(url: string, protocols?: string | string[]) {
                super(url, protocols);
                sockets.push(this);
              }
            }
            Object.defineProperty(globalThis, "WebSocket", {
              configurable: true,
              writable: true,
              value: TestWebSocketConstructor,
            });
          }),
          () =>
            Effect.sync(() => {
              if (originalWebSocket === undefined) Reflect.deleteProperty(globalThis, "WebSocket");
              else Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
            }),
        );

        const runner = yield* makeSessionFabricRunner.pipe(
          Effect.provideService(
            ServerEnvironment.ServerEnvironment,
            ServerEnvironment.ServerEnvironment.of({
              getEnvironmentId: Effect.succeed(environmentId),
              getDescriptor: Effect.die("unused environment descriptor"),
            }),
          ),
          Effect.provideService(
            OrchestrationEngine.OrchestrationEngineService,
            OrchestrationEngine.OrchestrationEngineService.of({
              readEvents: () =>
                Stream.fromIterable(afterReconnect ? [beforeEvent, recoveredEvent] : [beforeEvent]),
              dispatch: () => Effect.die("unused command dispatch"),
              streamDomainEvents: Stream.never,
              latestSequence: Effect.sync(() => latestSequence),
            }),
          ),
          Effect.provideService(
            ProjectionSnapshotQuery.ProjectionSnapshotQuery,
            ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
              getShellSnapshot: () => Effect.sync(shell),
              getThreadDetailSnapshot: () => Effect.succeed(Option.some(detail())),
            } as never),
          ),
          Effect.provideService(
            CheckpointDiffQuery.CheckpointDiffQuery,
            CheckpointDiffQuery.CheckpointDiffQuery.of({
              getTurnDiff: () => Effect.die("unused turn diff"),
              getFullThreadDiff: () => Effect.die("unused full thread diff"),
            }),
          ),
          Effect.provideService(ServerConfig.ServerConfig, {} as never),
          Effect.provideService(WorkspacePaths.WorkspacePaths, {} as never),
          Effect.provide(
            Layer.mergeAll(
              FileSystem.layerNoop({}),
              NodePath.layer,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    T3CODE_SESSION_FABRIC_AUTH_MODE: "disabled",
                    T3CODE_SESSION_FABRIC_ENVIRONMENT_KIND: "local",
                    T3CODE_SESSION_FABRIC_RELAY_URL: "https://relay.example.test/",
                  },
                }),
              ),
            ),
          ),
        );
        yield* runner.start();

        const firstSocket = yield* awaitSocket(sockets, 0);
        firstSocket.open();
        const firstHello = yield* awaitFrame(firstSocket, "runner.hello");
        const firstSnapshot = yield* awaitFrame(firstSocket, "session.publish-snapshot");
        if (firstHello.type !== "runner.hello") return yield* Effect.die("missing runner hello");
        if (firstSnapshot.type !== "session.publish-snapshot") {
          return yield* Effect.die("missing session snapshot");
        }
        expect(firstHello.hello.lastCommittedEventSequence).toBe(12);
        expect(firstSnapshot.published.snapshot.session.searchableText).toContain(
          "Before the relay EOF",
        );

        latestSequence = 13;
        afterReconnect = true;
        firstSocket.closeFromPeer(1006, "established socket EOF");
        for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
        yield* TestClock.adjust(sessionFabricReconnectDelayMs(1, sessionId));

        const secondSocket = yield* awaitSocket(sockets, 1);
        secondSocket.open();
        const secondHello = yield* awaitFrame(secondSocket, "runner.hello");
        const secondSnapshot = yield* awaitFrame(secondSocket, "session.publish-snapshot");
        if (secondHello.type !== "runner.hello") return yield* Effect.die("missing runner hello");
        if (secondSnapshot.type !== "session.publish-snapshot") {
          return yield* Effect.die("missing session snapshot");
        }
        expect(secondHello.hello.lastCommittedEventSequence).toBe(13);
        expect(secondSnapshot.published.snapshot.session.searchableText).toContain(
          "Authoritative state after reconnect",
        );

        for (let attempt = 0; attempt < 1_000; attempt += 1) {
          const recoveredWasReplayed = secondSocket.sent
            .map((sent) => decodeTestClientFrame(sent))
            .some(
              (frame) =>
                frame.type === "session.publish-event" && frame.published.event.sequence === 13,
            );
          if (recoveredWasReplayed) break;
          yield* Effect.yieldNow;
        }
        expect(
          secondSocket.sent
            .map((sent) => decodeTestClientFrame(sent))
            .filter(
              (frame) =>
                frame.type === "session.publish-event" && frame.published.event.sequence === 13,
            ),
        ).toHaveLength(1);
        expect(sockets).toHaveLength(2);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it("rejects mixed local and Scaffold runtime bindings", () => {
    expect(() =>
      resolveSessionFabricRunnerConfig({
        relayUrl: Option.some(new URL("https://relay.example.test/")),
        environmentKind: Option.some("local"),
        publication: "public",
        runnerGeneration: 0,
        overrideSessionId: Option.none(),
        overrideThreadId: Option.none(),
        scaffoldSessionId: Option.none(),
        scaffoldSessionUrl: Option.none(),
        scaffoldSessionDetailUrl: Option.none(),
        scaffoldCapabilityBaseUrl: Option.some(new URL("https://worker.example.test/")),
        scaffoldLifecycleEpoch: Option.none(),
        runtimeApiToken: Option.none(),
        authMode: "required",
        capabilityDeployment: Option.some("staging"),
        scaffoldDefaultDeployment: Option.none(),
      }),
    ).toThrow("cannot include Scaffold runtime bindings");
  });

  it("requires a valid direct capability origin for a Scaffold runner", () => {
    const baseConfig = {
      relayUrl: Option.some(new URL("https://relay.example.test/")),
      environmentKind: Option.some("scaffold" as const),
      publication: "public" as const,
      runnerGeneration: 0,
      overrideSessionId: Option.none(),
      overrideThreadId: Option.none(),
      scaffoldSessionId: Option.some("ses_scaffold"),
      scaffoldSessionUrl: Option.some("https://scaffold.example.test/?q=ses_scaffold"),
      scaffoldSessionDetailUrl: Option.none(),
      scaffoldLifecycleEpoch: Option.some(4),
      runtimeApiToken: Option.some("runtime-secret"),
      authMode: "required" as const,
      capabilityDeployment: Option.none(),
      scaffoldDefaultDeployment: Option.none(),
    };
    expect(() =>
      resolveSessionFabricRunnerConfig({
        ...baseConfig,
        scaffoldCapabilityBaseUrl: Option.none(),
      }),
    ).toThrow("requires a capability base URL");
    expect(() =>
      resolveSessionFabricRunnerConfig({
        ...baseConfig,
        scaffoldCapabilityBaseUrl: Option.some(
          new URL("https://worker.example.test/not-an-origin"),
        ),
      }),
    ).toThrow("must be an HTTP origin");
  });

  it("requests a Scaffold runner capability from the direct Worker origin", async () => {
    const config = resolveSessionFabricRunnerConfig({
      relayUrl: Option.some(new URL("https://relay.example.test/")),
      environmentKind: Option.some("scaffold"),
      publication: "public",
      runnerGeneration: 0,
      overrideSessionId: Option.none(),
      overrideThreadId: Option.none(),
      scaffoldSessionId: Option.some("ses_scaffold"),
      scaffoldSessionUrl: Option.some(
        "https://scaffold-staging.internal.ashler.com/sessions/ses_scaffold/agent/",
      ),
      scaffoldSessionDetailUrl: Option.some(
        "https://scaffold-agent-staging.internal.ashler.com/?q=ses_scaffold",
      ),
      scaffoldCapabilityBaseUrl: Option.some(
        new URL("https://scaffold-control-plane-staging.workers.dev/"),
      ),
      scaffoldLifecycleEpoch: Option.some(7),
      runtimeApiToken: Option.some("runtime-secret"),
      authMode: "required",
      capabilityDeployment: Option.none(),
      scaffoldDefaultDeployment: Option.none(),
    });
    const requests: Array<{
      url: string;
      init: Parameters<typeof globalThis.fetch>[1];
    }> = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return Response.json({
        capability: "header.payload.signature",
        tokenType: "Bearer",
        role: "runner",
        scopes: ["session:publish", "session:execute"],
        expiresAt: "2026-07-24T20:15:00.000Z",
        issuer: "scaffold",
        audience: "session-fabric",
        keyId: "proof-1",
        bindings: {
          scaffoldSessionId: "ses_scaffold",
          scaffoldLifecycleEpoch: 7,
        },
      });
    }) as typeof globalThis.fetch;

    await requestScaffoldSessionFabricRunnerCapability({
      capabilityBaseUrl: config.scaffoldCapabilityBaseUrl!,
      runtimeApiToken: config.runtimeApiToken!,
      scaffoldSessionId: config.scaffoldSessionId!,
      lifecycleEpoch: config.scaffoldLifecycleEpoch!,
      fetch,
      now: () => Date.parse("2026-07-24T20:00:00.000Z"),
    });

    expect(config.scaffoldSessionUrl).toContain("scaffold-staging.internal.ashler.com");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://scaffold-control-plane-staging.workers.dev/api/sessions/ses_scaffold/session-fabric/runner-capability",
    );
    expect(requests[0]?.url).not.toContain("scaffold-staging.internal.ashler.com");
    expect(requests[0]?.init?.headers).toMatchObject({
      "x-scaffold-runtime-api-token": "runtime-secret",
    });
    expect(decodeJson(String(requests[0]?.init?.body))).toEqual({ lifecycleEpoch: 7 });
  });

  it("uses the OAuth-backed global capability endpoint for an exact local runner binding", async () => {
    const environmentId = EnvironmentId.make("environment-local");
    const sessionId = SessionFabricSessionId.make("sf:environment-local:thread-1");
    const requests: Array<{
      url: string;
      init: Parameters<typeof globalThis.fetch>[1];
    }> = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return Response.json({
        capability: "header.payload.signature",
        tokenType: "Bearer",
        role: "runner",
        scopes: ["session:publish", "session:execute"],
        expiresAt: "2026-07-24T20:15:00.000Z",
        issuer: "scaffold",
        audience: "session-fabric",
        keyId: "proof-1",
        bindings: {
          fabricSessionId: sessionId,
          environmentKind: "local",
          environmentId,
          threadId: "thread-1",
        },
      });
    }) as typeof globalThis.fetch;
    const grant = await requestLocalSessionFabricRunnerCapability({
      deployment: "staging",
      fabricSessionId: sessionId,
      environmentId,
      threadId: ThreadId.make("thread-1"),
      runnerId: "runner:environment-local" as never,
      target: {
        baseUrl: "https://scaffold.example.test/",
        authMode: "oauth",
        authorization: "Bearer oauth-user-token",
      },
      fetch,
      now: () => Date.parse("2026-07-24T20:00:00.000Z"),
    });
    expect(grant.bindings).toEqual({
      fabricSessionId: sessionId,
      environmentKind: "local",
      environmentId,
      threadId: "thread-1",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://scaffold.example.test/api/session-fabric/capabilities");
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: "Bearer oauth-user-token",
    });
    expect(decodeJson(String(requests[0]?.init?.body))).toEqual({
      role: "runner",
      fabricSessionId: sessionId,
      environmentKind: "local",
      environmentId,
      threadId: "thread-1",
      runnerId: "runner:environment-local",
    });
  });

  it("rejects a local runner capability with a different response binding", async () => {
    const sessionId = SessionFabricSessionId.make("sf:environment-local:thread-1");
    const fetch = (async () =>
      Response.json({
        capability: "header.payload.signature",
        tokenType: "Bearer",
        role: "runner",
        scopes: ["session:publish", "session:execute"],
        expiresAt: "2026-07-24T20:15:00.000Z",
        issuer: "scaffold",
        audience: "session-fabric",
        keyId: "proof-1",
        bindings: {
          fabricSessionId: sessionId,
          environmentKind: "local",
          environmentId: "environment-other",
          threadId: "thread-1",
        },
      })) as unknown as typeof globalThis.fetch;

    await expect(
      requestLocalSessionFabricRunnerCapability({
        deployment: "staging",
        fabricSessionId: sessionId,
        environmentId: EnvironmentId.make("environment-local"),
        threadId: ThreadId.make("thread-1"),
        runnerId: "runner:environment-local" as never,
        target: {
          baseUrl: "https://scaffold.example.test/",
          authMode: "oauth",
          authorization: "Bearer oauth-user-token",
        },
        fetch,
        now: () => Date.parse("2026-07-24T20:00:00.000Z"),
      }),
    ).rejects.toThrow("invalid local session fabric capability");
  });

  it("returns the orchestration engine's original sequence on accepted duplicate dispatch", () => {
    const command = {
      sessionId: SessionFabricSessionId.make("global-session-1"),
      commandId: "command-1",
    } as never;
    expect(
      sessionFabricCommandReceipt({
        command,
        resultSequence: 17,
        accepted: true,
        updatedAt: "2026-07-24T20:00:00.000Z",
      }),
    ).toMatchObject({
      status: "accepted",
      resultSequence: 17,
    });
  });

  it("publishes an opaque fabric continuation instead of a provider-native cursor", () => {
    expect(
      buildSessionFabricContextPublication({
        sessionId: SessionFabricSessionId.make("global-session-1"),
        runnerId: "runner-1" as never,
        runnerGeneration: 2,
        codeDiff: "diff --git a/file.ts b/file.ts",
        publishedAt: "2026-07-24T20:00:00.000Z",
      }),
    ).toEqual({
      sessionId: SessionFabricSessionId.make("global-session-1"),
      runnerId: "runner-1",
      runnerGeneration: 2,
      codeDiff: "diff --git a/file.ts b/file.ts",
      continuationRef: "session-fabric:global-session-1",
      publishedAt: "2026-07-24T20:00:00.000Z",
    });
  });
});
