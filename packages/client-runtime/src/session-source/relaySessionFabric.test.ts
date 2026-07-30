import {
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  SessionFabricClientFrame,
  SessionFabricClientId,
  SessionFabricServerFrame,
  SessionFabricSessionId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationShellStreamItem,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type OrchestrationThreadStreamItem,
  type SessionFabricClientFrame as SessionFabricClientFrameType,
  type SessionFabricServerFrame as SessionFabricServerFrameType,
  type SessionFabricSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  makeRelaySessionFabricHttpUrl,
  makeRelaySessionFabricUiSessionSource,
  makeRelaySessionFabricWebSocketUrl,
} from "./relaySessionFabric.ts";
import {
  makeRuntimeSessionFabricAuthorization,
  makeSessionFabricCapabilityAuthorization,
} from "./sessionFabricAuthorization.ts";

const SESSION_ID = SessionFabricSessionId.make("session-fabric-1");
const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");
const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const NOW = "2026-07-24T20:00:00.000Z";

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "T3 Code",
  workspaceRoot: "/workspace/t3code",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const thread: OrchestrationThread = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Multiplayer session",
  modelSelection: {
    instanceId: ProviderInstanceId.make("omp"),
    model: "gpt-5.6-terra",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: "/workspace/t3code",
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const threadShell: OrchestrationThreadShell = {
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  modelSelection: thread.modelSelection,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  latestTurn: thread.latestTurn,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  archivedAt: thread.archivedAt,
  settledOverride: thread.settledOverride,
  settledAt: thread.settledAt,
  session: thread.session,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const snapshot: SessionFabricSnapshot = {
  session: {
    sessionId: SESSION_ID,
    title: thread.title,
    publication: "public",
    runnerState: "online",
    location: {
      environmentKind: "scaffold",
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      repositoryRoot: project.workspaceRoot,
      worktreePath: thread.worktreePath,
      scaffoldSessionId: "ses-scaffold-1",
      scaffoldSessionUrl: "https://scaffold.example/sessions/ses-scaffold-1",
      scaffoldLifecycleEpoch: 2,
    },
    initialPrompt: "Build multiplayer sessions",
    searchableText: "Build multiplayer sessions\nThe relay is connected.",
    summary: null,
    cursor: { eventSequence: 1, snapshotSequence: 7 },
    lastEventAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  },
  shell: {
    snapshotSequence: 7,
    projects: [project],
    threads: [threadShell],
    updatedAt: NOW,
  },
  thread: {
    snapshotSequence: 7,
    thread,
  },
  compactedThroughEventSequence: 1,
};

const TURN_ID = TurnId.make("turn-1");
const RUNNING_AT = "2026-07-24T20:01:00.000Z";
const COMPLETED_AT = "2026-07-24T20:05:00.000Z";
const runningSession = {
  threadId: THREAD_ID,
  status: "running" as const,
  providerName: "omp",
  providerInstanceId: ProviderInstanceId.make("omp"),
  runtimeMode: "full-access" as const,
  activeTurnId: TURN_ID,
  lastError: null,
  updatedAt: RUNNING_AT,
};
const runningLatestTurn = {
  turnId: TURN_ID,
  state: "running" as const,
  requestedAt: RUNNING_AT,
  startedAt: RUNNING_AT,
  completedAt: null,
  assistantMessageId: null,
};

function makeRunningSnapshot(shellTitle = threadShell.title): SessionFabricSnapshot {
  return {
    ...snapshot,
    shell: {
      ...snapshot.shell,
      threads: [
        {
          ...threadShell,
          title: shellTitle,
          latestTurn: runningLatestTurn,
          session: runningSession,
        },
      ],
    },
    thread: {
      ...snapshot.thread,
      thread: {
        ...thread,
        title: shellTitle,
        latestTurn: runningLatestTurn,
        session: runningSession,
      },
    },
  };
}

function makeSessionSetFrame(input?: {
  readonly eventSequence?: number;
  readonly fabricSequence?: number;
  readonly status?: "idle" | "ready";
  readonly updatedAt?: string;
}): SessionFabricServerFrameType {
  const eventSequence = input?.eventSequence ?? 8;
  const updatedAt = input?.updatedAt ?? COMPLETED_AT;
  return {
    type: "session.event",
    sequence: input?.fabricSequence ?? 2,
    published: {
      sessionId: SESSION_ID,
      runnerId: "runner-1" as never,
      runnerGeneration: 0,
      event: {
        sequence: eventSequence,
        eventId: EventId.make(`event-${eventSequence}`),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: updatedAt,
        commandId: CommandId.make(`command-${eventSequence}`),
        causationEventId: null,
        correlationId: CommandId.make(`command-${eventSequence}`),
        metadata: {},
        type: "thread.session-set",
        payload: {
          threadId: THREAD_ID,
          session: {
            ...runningSession,
            status: input?.status ?? "ready",
            activeTurnId: null,
            updatedAt,
          },
        },
      },
    },
  };
}

const makeMetaUpdatedEvent = (sequence: number, title: string): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread",
  aggregateId: THREAD_ID,
  occurredAt: NOW,
  commandId: CommandId.make(`command-${sequence}`),
  causationEventId: null,
  correlationId: CommandId.make(`command-${sequence}`),
  metadata: {},
  type: "thread.meta-updated",
  payload: {
    threadId: THREAD_ID,
    title,
    updatedAt: NOW,
  },
});

const staleEvent = makeMetaUpdatedEvent(6, "Stale title");
const liveEvent = makeMetaUpdatedEvent(8, "Shared title");
const encodeServerFrame = Schema.encodeSync(Schema.fromJsonString(SessionFabricServerFrame));
const decodeClientFrame = Schema.decodeUnknownSync(Schema.fromJsonString(SessionFabricClientFrame));

type SocketEventType = "open" | "message" | "close" | "error";
type SocketEvent = {
  readonly code?: number;
  readonly data?: unknown;
  readonly reason?: string;
  readonly type: SocketEventType;
};
type SocketListener = (event: SocketEvent) => void;

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = TestWebSocket.CONNECTING;
  readonly url: string;
  readonly protocols: ReadonlyArray<string>;
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();
  private readonly relay: TestRelay;

  constructor(url: string, relay: TestRelay, protocols?: string | Array<string>) {
    this.url = url;
    this.protocols = typeof protocols === "string" ? [protocols] : (protocols ?? []);
    this.relay = relay;
  }

  addEventListener(type: SocketEventType, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEventType, listener: SocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: SocketEventType) {
    return this.listeners.get(type)?.size ?? 0;
  }

  send(data: string) {
    this.relay.receive(this, decodeClientFrame(data));
  }

  close(code = 1000, reason = "") {
    if (this.readyState === TestWebSocket.CLOSED) return;
    this.readyState = TestWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverFrame(frame: SessionFabricServerFrameType) {
    this.emit("message", { data: encodeServerFrame(frame), type: "message" });
  }

  private emit(type: SocketEventType, event: SocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class TestRelay {
  readonly sockets: TestWebSocket[] = [];
  readonly clientHellos: Array<
    Extract<SessionFabricClientFrameType, { type: "client.hello" }>["hello"]
  > = [];
  clientHelloCount = 0;
  private readonly initialSnapshot: SessionFabricSnapshot;
  private readonly emitReplayEvent: boolean;

  constructor(initialSnapshot: SessionFabricSnapshot = snapshot, emitReplayEvent = true) {
    this.initialSnapshot = initialSnapshot;
    this.emitReplayEvent = emitReplayEvent;
  }

  readonly construct = (url: string, protocols?: string | Array<string>) => {
    const socket = new TestWebSocket(url, this, protocols);
    this.sockets.push(socket);
    return socket as unknown as globalThis.WebSocket;
  };

  receive(socket: TestWebSocket, frame: SessionFabricClientFrameType) {
    if (frame.type === "client.hello") {
      this.clientHelloCount += 1;
      this.clientHellos.push(frame.hello);
      if (frame.hello.synchronize === false) return;
      socket.serverFrame({ type: "session.snapshot", snapshot: this.initialSnapshot });
      if (this.emitReplayEvent) {
        socket.serverFrame({
          type: "session.event",
          sequence: 1,
          published: {
            sessionId: SESSION_ID,
            runnerId: "runner-1" as never,
            runnerGeneration: 0,
            event: staleEvent,
          },
        });
      }
      socket.serverFrame({
        type: "session.synchronized",
        cursor: { eventSequence: 1, snapshotSequence: 7 },
      });
      return;
    }
    if (frame.type !== "command.submit") return;
    socket.serverFrame({
      type: "command.receipt",
      receipt: {
        sessionId: SESSION_ID,
        commandId: frame.command.commandId,
        status: "accepted",
        resultSequence: 8,
        detail: null,
        updatedAt: NOW,
      },
    });
    this.broadcast({
      type: "session.event",
      sequence: 2,
      published: {
        sessionId: SESSION_ID,
        runnerId: "runner-1" as never,
        runnerGeneration: 0,
        event: liveEvent,
      },
    });
  }

  broadcast(frame: SessionFabricServerFrameType) {
    for (const socket of this.sockets) {
      if (socket.readyState === TestWebSocket.OPEN) socket.serverFrame(frame);
    }
  }
}

const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({} as never);

const awaitSocketCount = Effect.fn("TestRelay.awaitSocketCount")(function* (
  relay: TestRelay,
  count: number,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (relay.sockets.length >= count) return;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error(`Expected ${count} Relay websocket clients.`));
});

const awaitHelloCount = Effect.fn("TestRelay.awaitHelloCount")(function* (
  relay: TestRelay,
  count: number,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (relay.clientHelloCount >= count) return;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error(`Expected ${count} Relay client hellos.`));
});

const awaitCloseListener = Effect.fn("TestRelay.awaitCloseListener")(function* (
  socket: TestWebSocket,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (socket.listenerCount("close") > 0) return;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the Relay websocket close listener."));
});

function makeSource(
  relay: TestRelay,
  clientId: string,
  fetchImplementation: typeof fetch = (() =>
    Promise.resolve(new Response(JSON.stringify(snapshot)))) as typeof fetch,
) {
  const capabilityFetch = () => {
    throw new Error("Loopback disabled auth must not request a session fabric capability.");
  };
  return makeRelaySessionFabricUiSessionSource({
    relayBaseUrl: "http://127.0.0.1:8787/base/",
    sessionId: SESSION_ID,
    clientId: SessionFabricClientId.make(clientId),
    environmentId: ENVIRONMENT_ID,
    environmentLabel: "Relay test",
    authorization: makeRuntimeSessionFabricAuthorization({
      endpoint: "http://localhost:5733/api/session-fabric/capabilities",
      authMode: "disabled",
      appUrl: "http://localhost:5733/session-fabric:session-fabric-1/thread-1",
      relayBaseUrl: "http://127.0.0.1:8787/base/",
      localDevAutoAuthEnabled: true,
      fetch: capabilityFetch as typeof fetch,
    }),
    fetch: fetchImplementation,
    webSocketConstructor: relay.construct,
    now: () => NOW,
  });
}

describe("Relay session fabric UI source", () => {
  it.effect("loads the runtime schema module and fetches its authoritative snapshot", () =>
    Effect.gen(function* () {
      const relay = new TestRelay();
      const source = makeSource(relay, "client-import-proof");
      const loaded = yield* source.authoritativeThreadSnapshot({} as never, THREAD_ID);

      expect(Option.isSome(loaded)).toBe(true);
      expect(
        makeRelaySessionFabricHttpUrl(
          "https://relay.test/base/",
          SESSION_ID,
          "snapshot",
        ).toString(),
      ).toBe("https://relay.test/base/v1/session-fabric/sessions/session-fabric-1/snapshot");
      expect(
        makeRelaySessionFabricWebSocketUrl("https://relay.test/base/", SESSION_ID)?.toString(),
      ).toBe("wss://relay.test/base/v1/session-fabric/sessions/session-fabric-1/connect");
    }),
  );

  it.effect("does not replace a fetched snapshot with a later stale response", () =>
    Effect.gen(function* () {
      const relay = new TestRelay();
      const newerSnapshot = {
        ...snapshot,
        shell: {
          ...snapshot.shell,
          snapshotSequence: 9,
          updatedAt: "2026-07-24T20:09:00.000Z",
        },
      };
      let fetchCount = 0;
      const source = makeSource(relay, "client-stale-http-snapshot", (() =>
        Promise.resolve(
          new Response(JSON.stringify(fetchCount++ === 0 ? newerSnapshot : snapshot)),
        )) as typeof fetch);

      const first = yield* source.authoritativeShellSnapshot({} as never);
      const second = yield* source.authoritativeShellSnapshot({} as never);

      expect(Option.map(first, (value) => value.snapshotSequence)).toEqual(Option.some(9));
      expect(Option.map(second, (value) => value.snapshotSequence)).toEqual(Option.some(9));
    }),
  );

  it.effect("preserves newer thread detail when shell sequences are equal", () =>
    Effect.gen(function* () {
      const relay = new TestRelay();
      const newerThreadSnapshot: SessionFabricSnapshot = {
        ...snapshot,
        thread: {
          snapshotSequence: 9,
          thread: { ...snapshot.thread.thread, title: "Newer thread detail" },
        },
      };
      const olderThreadSnapshot: SessionFabricSnapshot = {
        ...snapshot,
        thread: {
          snapshotSequence: 8,
          thread: { ...snapshot.thread.thread, title: "Older thread detail" },
        },
      };
      let fetchCount = 0;
      const source = makeSource(relay, "client-stale-http-thread", (() =>
        Promise.resolve(
          new Response(
            JSON.stringify(fetchCount++ === 0 ? newerThreadSnapshot : olderThreadSnapshot),
          ),
        )) as typeof fetch);

      const first = yield* source.authoritativeThreadSnapshot({} as never, THREAD_ID);
      const second = yield* source.authoritativeThreadSnapshot({} as never, THREAD_ID);

      expect(Option.map(first, (value) => value.snapshotSequence)).toEqual(Option.some(9));
      expect(Option.map(second, (value) => value.snapshotSequence)).toEqual(Option.some(9));
      expect(Option.map(second, (value) => value.thread.title)).toEqual(
        Option.some("Newer thread detail"),
      );
    }),
  );

  it.live("merges a live session overlay onto a newer complete projection", () =>
    Effect.gen(function* () {
      const relay = new TestRelay(makeRunningSnapshot());
      const projectedAfterInterveningEvent: SessionFabricSnapshot = {
        ...makeRunningSnapshot("Intervening title"),
        shell: {
          ...makeRunningSnapshot("Intervening title").shell,
          snapshotSequence: 8,
        },
        thread: {
          ...makeRunningSnapshot("Intervening title").thread,
          snapshotSequence: 8,
        },
      };
      const source = makeSource(relay, "client-partial-session-overlay", (() =>
        Promise.resolve(Response.json(projectedAfterInterveningEvent))) as typeof fetch);
      const items = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const streamed = yield* Effect.forkChild(
        source
          .subscribeShell(() => Effect.succeed({ afterSequence: 0, requestCompletionMarker: true }))
          .pipe(
            Stream.runForEach((item) => Queue.offer(items, item)),
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
      );

      yield* awaitSocketCount(relay, 1);
      relay.sockets[0]!.open();
      yield* awaitHelloCount(relay, 1);
      expect(yield* Queue.take(items)).toEqual(expect.objectContaining({ kind: "snapshot" }));
      expect(yield* Queue.take(items)).toEqual({ kind: "synchronized" });
      relay.broadcast(makeSessionSetFrame({ eventSequence: 9 }));
      expect(yield* Queue.take(items)).toEqual(
        expect.objectContaining({ kind: "thread-upserted", sequence: 9 }),
      );

      const projected = yield* source.authoritativeThreadSnapshot({} as never, THREAD_ID);
      yield* Fiber.interrupt(streamed);

      expect(Option.map(projected, (value) => value.snapshotSequence)).toEqual(Option.some(8));
      expect(Option.map(projected, (value) => value.thread.title)).toEqual(
        Option.some("Intervening title"),
      );
      expect(Option.map(projected, (value) => value.thread.session?.status)).toEqual(
        Option.some("ready"),
      );
      expect(Option.map(projected, (value) => value.thread.latestTurn?.state)).toEqual(
        Option.some("completed"),
      );
    }),
  );

  it.live("accepts the first cold shell and thread websocket snapshots at sequence zero", () =>
    Effect.gen(function* () {
      const zeroSnapshot: SessionFabricSnapshot = {
        ...snapshot,
        session: {
          ...snapshot.session,
          cursor: { eventSequence: 0, snapshotSequence: 0 },
        },
        shell: { ...snapshot.shell, snapshotSequence: 0 },
        thread: { ...snapshot.thread, snapshotSequence: 0 },
        compactedThroughEventSequence: 0,
      };
      const relay = new TestRelay(zeroSnapshot, false);
      const source = makeSource(relay, "client-cold-sequence-zero", (() =>
        Promise.resolve(new Response(null, { status: 503 }))) as typeof fetch);
      expect(yield* source.authoritativeThreadSnapshot({} as never, THREAD_ID)).toEqual(
        Option.none(),
      );
      const items = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
      const streamed = yield* Effect.forkChild(
        source
          .subscribeThread(() =>
            Effect.succeed({
              threadId: THREAD_ID,
              afterSequence: 0,
              requestCompletionMarker: true,
            }),
          )
          .pipe(
            Stream.runForEach((item) => Queue.offer(items, item)),
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
      );

      yield* awaitSocketCount(relay, 1);
      relay.sockets[0]!.open();
      yield* awaitHelloCount(relay, 1);
      expect(yield* Queue.take(items)).toEqual(
        expect.objectContaining({
          kind: "snapshot",
          snapshot: expect.objectContaining({ snapshotSequence: 0 }),
        }),
      );
      expect(yield* Queue.take(items)).toEqual({ kind: "synchronized" });
      relay.broadcast({ type: "session.snapshot", snapshot: zeroSnapshot });
      for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;
      expect(yield* Queue.poll(items)).toEqual(Option.none());
      yield* Fiber.interrupt(streamed);

      const shellRelay = new TestRelay(zeroSnapshot, false);
      const shellSource = makeSource(shellRelay, "client-cold-shell-sequence-zero", (() =>
        Promise.resolve(new Response(null, { status: 503 }))) as typeof fetch);
      expect(yield* shellSource.authoritativeShellSnapshot({} as never)).toEqual(Option.none());
      const shellItems = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const shellStreamed = yield* Effect.forkChild(
        shellSource
          .subscribeShell(() => Effect.succeed({ afterSequence: 0, requestCompletionMarker: true }))
          .pipe(
            Stream.runForEach((item) => Queue.offer(shellItems, item)),
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
      );

      yield* awaitSocketCount(shellRelay, 1);
      shellRelay.sockets[0]!.open();
      yield* awaitHelloCount(shellRelay, 1);
      expect(yield* Queue.take(shellItems)).toEqual(
        expect.objectContaining({
          kind: "snapshot",
          snapshot: expect.objectContaining({ snapshotSequence: 0 }),
        }),
      );
      expect(yield* Queue.take(shellItems)).toEqual({ kind: "synchronized" });
      shellRelay.broadcast({ type: "session.snapshot", snapshot: zeroSnapshot });
      for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;
      expect(yield* Queue.poll(shellItems)).toEqual(Option.none());
      yield* Fiber.interrupt(shellStreamed);
    }),
  );

  it.effect(
    "lets two independent clients observe and interact with one session without browser storage",
    () =>
      Effect.gen(function* () {
        const relay = new TestRelay();
        const first = makeSource(relay, "client-first");
        const second = makeSource(relay, "client-second");
        const subscribe = (source: ReturnType<typeof makeSource>) =>
          source
            .subscribeThread(() =>
              Effect.succeed({
                threadId: THREAD_ID,
                afterSequence: 0,
                requestCompletionMarker: true,
              }),
            )
            .pipe(
              Stream.take(3),
              Stream.runCollect,
              Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            );

        const firstFrames = yield* Effect.forkChild(subscribe(first));
        const secondFrames = yield* Effect.forkChild(subscribe(second));
        yield* awaitSocketCount(relay, 2);
        expect(relay.sockets.map((socket) => socket.protocols)).toEqual([[], []]);
        expect(relay.sockets[0]!.url).toBe(
          "ws://127.0.0.1:8787/base/v1/session-fabric/sessions/session-fabric-1/connect",
        );
        relay.sockets[0]!.open();
        relay.sockets[1]!.open();
        yield* awaitHelloCount(relay, 2);

        const command = {
          type: "thread.meta.update" as const,
          commandId: CommandId.make("command-8"),
          threadId: THREAD_ID,
          title: "Shared title",
        };
        const dispatched = yield* Effect.forkChild(
          first
            .dispatch(command)
            .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor)),
        );
        yield* awaitSocketCount(relay, 3);
        relay.sockets[2]!.open();

        expect(yield* Fiber.join(dispatched)).toEqual({ sequence: 8 });
        const [firstItems, secondItems] = yield* Effect.all([
          Fiber.join(firstFrames),
          Fiber.join(secondFrames),
        ]);
        for (const items of [Array.from(firstItems), Array.from(secondItems)]) {
          expect(items.map((item) => item.kind)).toEqual(["snapshot", "synchronized", "event"]);
          expect(items.at(-1)).toMatchObject({
            kind: "event",
            event: { sequence: 8, payload: { title: "Shared title" } },
          });
          expect(items).not.toContainEqual(
            expect.objectContaining({
              kind: "event",
              event: expect.objectContaining({ sequence: 6 }),
            }),
          );
        }
      }),
  );

  it.live("projects live session completion into the shell stream", () =>
    Effect.gen(function* () {
      const relay = new TestRelay(makeRunningSnapshot());
      const source = makeSource(relay, "client-shell-completion");
      const items = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const streamed = yield* Effect.forkChild(
        source
          .subscribeShell(() => Effect.succeed({ afterSequence: 0, requestCompletionMarker: true }))
          .pipe(
            Stream.runForEach((item) => Queue.offer(items, item)),
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
      );

      yield* awaitSocketCount(relay, 1);
      relay.sockets[0]!.open();
      yield* awaitHelloCount(relay, 1);
      expect(yield* Queue.take(items)).toEqual(expect.objectContaining({ kind: "snapshot" }));
      expect(yield* Queue.take(items)).toEqual({ kind: "synchronized" });
      relay.broadcast(makeSessionSetFrame());

      for (let attempt = 0; attempt < 100; attempt += 1) yield* Effect.yieldNow;
      const completion = yield* Queue.poll(items);
      yield* Fiber.interrupt(streamed);
      expect(completion).toEqual(
        Option.some(
          expect.objectContaining({
            kind: "thread-upserted",
            sequence: 8,
            thread: expect.objectContaining({
              session: expect.objectContaining({ status: "ready", activeTurnId: null }),
              latestTurn: expect.objectContaining({
                state: "completed",
                completedAt: COMPLETED_AT,
              }),
            }),
          }),
        ),
      );
    }),
  );

  it.live("keeps event 8 authoritative in thread detail across stale HTTP and remount", () =>
    Effect.gen(function* () {
      const staleSnapshot = makeRunningSnapshot();
      const relay = new TestRelay(staleSnapshot);
      const source = makeSource(relay, "client-event-http-floor", (() =>
        Promise.resolve(new Response(JSON.stringify(staleSnapshot)))) as typeof fetch);
      const firstItems = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const first = yield* Effect.forkChild(
        source
          .subscribeShell(() => Effect.succeed({ afterSequence: 0, requestCompletionMarker: true }))
          .pipe(
            Stream.runForEach((item) => Queue.offer(firstItems, item)),
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
      );

      yield* awaitSocketCount(relay, 1);
      relay.sockets[0]!.open();
      yield* awaitHelloCount(relay, 1);
      expect(yield* Queue.take(firstItems)).toEqual(expect.objectContaining({ kind: "snapshot" }));
      expect(yield* Queue.take(firstItems)).toEqual({ kind: "synchronized" });
      relay.broadcast(makeSessionSetFrame());
      expect(yield* Queue.take(firstItems)).toEqual(
        expect.objectContaining({ kind: "thread-upserted", sequence: 8 }),
      );

      const fetched = yield* source.authoritativeThreadSnapshot({} as never, THREAD_ID);
      expect(Option.map(fetched, (value) => value.snapshotSequence)).toEqual(Option.some(7));
      expect(Option.map(fetched, (value) => value.thread.session?.status)).toEqual(
        Option.some("ready"),
      );
      expect(Option.map(fetched, (value) => value.thread.latestTurn?.state)).toEqual(
        Option.some("completed"),
      );

      const secondItems = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
      const second = yield* Effect.forkChild(
        source
          .subscribeThread(() =>
            Effect.succeed({
              threadId: THREAD_ID,
              afterSequence: 0,
              requestCompletionMarker: true,
            }),
          )
          .pipe(
            Stream.runForEach((item) => Queue.offer(secondItems, item)),
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
      );
      yield* awaitSocketCount(relay, 2);
      relay.sockets[1]!.open();
      yield* awaitHelloCount(relay, 2);
      const secondSnapshot = yield* Queue.take(secondItems);
      yield* Fiber.interrupt(first);
      yield* Fiber.interrupt(second);

      expect(secondSnapshot).toEqual(
        expect.objectContaining({
          kind: "snapshot",
          snapshot: expect.objectContaining({
            snapshotSequence: 7,
            thread: expect.objectContaining({
              session: expect.objectContaining({ status: "ready" }),
              latestTurn: expect.objectContaining({ state: "completed" }),
            }),
          }),
        }),
      );
    }),
  );

  it.live("projects the same live completion independently for concurrent shell subscribers", () =>
    Effect.gen(function* () {
      const relay = new TestRelay(makeRunningSnapshot());
      const source = makeSource(relay, "client-dual-shell-completion");
      const firstItems = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const secondItems = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const subscribe = (items: Queue.Queue<OrchestrationShellStreamItem>) =>
        source
          .subscribeShell(() => Effect.succeed({ afterSequence: 0, requestCompletionMarker: true }))
          .pipe(
            Stream.runForEach((item) => Queue.offer(items, item)),
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          );
      const first = yield* Effect.forkChild(subscribe(firstItems));
      const second = yield* Effect.forkChild(subscribe(secondItems));

      yield* awaitSocketCount(relay, 2);
      relay.sockets[0]!.open();
      relay.sockets[1]!.open();
      yield* awaitHelloCount(relay, 2);
      for (const items of [firstItems, secondItems]) {
        expect(yield* Queue.take(items)).toEqual(expect.objectContaining({ kind: "snapshot" }));
        expect(yield* Queue.take(items)).toEqual({ kind: "synchronized" });
      }

      relay.broadcast(makeSessionSetFrame());
      for (let attempt = 0; attempt < 100; attempt += 1) yield* Effect.yieldNow;
      const firstCompletion = yield* Queue.poll(firstItems);
      const secondCompletion = yield* Queue.poll(secondItems);
      yield* Fiber.interrupt(first);
      yield* Fiber.interrupt(second);

      for (const completion of [firstCompletion, secondCompletion]) {
        expect(completion).toEqual(
          Option.some(
            expect.objectContaining({
              kind: "thread-upserted",
              sequence: 8,
              thread: expect.objectContaining({
                session: expect.objectContaining({ status: "ready" }),
                latestTurn: expect.objectContaining({
                  state: "completed",
                  completedAt: COMPLETED_AT,
                }),
              }),
            }),
          ),
        );
      }
    }),
  );

  it.live("ignores a stale snapshot that arrives after live shell completion", () =>
    Effect.gen(function* () {
      const relay = new TestRelay(makeRunningSnapshot());
      const source = makeSource(relay, "client-stale-shell-snapshot");
      const items = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const streamed = yield* Effect.forkChild(
        source
          .subscribeShell(() => Effect.succeed({ afterSequence: 0, requestCompletionMarker: true }))
          .pipe(
            Stream.runForEach((item) => Queue.offer(items, item)),
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
      );

      yield* awaitSocketCount(relay, 1);
      relay.sockets[0]!.open();
      yield* awaitHelloCount(relay, 1);
      expect(yield* Queue.take(items)).toEqual(expect.objectContaining({ kind: "snapshot" }));
      expect(yield* Queue.take(items)).toEqual({ kind: "synchronized" });

      relay.broadcast(makeSessionSetFrame());
      expect(yield* Queue.take(items)).toEqual(
        expect.objectContaining({ kind: "thread-upserted", sequence: 8 }),
      );
      relay.broadcast({ type: "session.snapshot", snapshot: makeRunningSnapshot("Stale title") });
      for (let attempt = 0; attempt < 100; attempt += 1) yield* Effect.yieldNow;
      expect(yield* Queue.poll(items)).toEqual(Option.none());

      relay.broadcast(
        makeSessionSetFrame({
          eventSequence: 9,
          fabricSequence: 3,
          status: "idle",
          updatedAt: "2026-07-24T20:06:00.000Z",
        }),
      );
      const followUp = yield* Queue.take(items);
      yield* Fiber.interrupt(streamed);
      expect(followUp).toEqual(
        expect.objectContaining({
          kind: "thread-upserted",
          sequence: 9,
          thread: expect.objectContaining({
            title: threadShell.title,
            latestTurn: expect.objectContaining({
              state: "completed",
              completedAt: COMPLETED_AT,
            }),
          }),
        }),
      );
    }),
  );

  it.effect("uses viewer authority for reads and a separate controller for commands", () =>
    Effect.gen(function* () {
      const relay = new TestRelay();
      const fetchCalls: Array<{ readonly url: string; readonly authorization: string | null }> = [];
      const capabilityCalls: string[] = [];
      const authorization = makeSessionFabricCapabilityAuthorization({
        endpoint: "https://t3.example/api/session-fabric/capabilities",
        now: () => Date.parse("2026-07-24T20:00:00.000Z"),
        fetch: (async (_input, init) => {
          const role = (JSON.parse(String(init?.body)) as { role: string }).role;
          capabilityCalls.push(role);
          return Response.json({
            capability: `${role}-secret`,
            tokenType: "Bearer",
            role,
            scopes:
              role === "viewer"
                ? ["directory:read", "session:read"]
                : ["session:read", "session:command"],
            expiresAt: "2026-07-24T21:00:00.000Z",
            issuer: "scaffold",
            audience: "session-fabric",
            keyId: "key-1",
            bindings:
              role === "viewer"
                ? {}
                : {
                    fabricSessionId: SESSION_ID,
                    scaffoldSessionId: "ses-scaffold-1",
                    scaffoldLifecycleEpoch: 2,
                  },
          });
        }) as typeof fetch,
      });
      const source = makeRelaySessionFabricUiSessionSource({
        relayBaseUrl: "https://relay.example.test/base/",
        sessionId: SESSION_ID,
        clientId: SessionFabricClientId.make("client-authorized"),
        environmentId: ENVIRONMENT_ID,
        environmentLabel: "Relay test",
        authorization,
        fetch: (async (input, init) => {
          fetchCalls.push({
            url: String(input),
            authorization: new Headers(init?.headers).get("authorization"),
          });
          return Response.json(snapshot);
        }) as typeof fetch,
        webSocketConstructor: relay.construct,
        now: () => NOW,
      });

      yield* source.authoritativeThreadSnapshot({} as never, THREAD_ID);
      expect(fetchCalls).toEqual([
        {
          url: "https://relay.example.test/base/v1/session-fabric/sessions/session-fabric-1/snapshot",
          authorization: "Bearer viewer-secret",
        },
      ]);

      const dispatched = yield* Effect.forkChild(
        source
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("command-authorized"),
            threadId: THREAD_ID,
            title: "Authorized",
          })
          .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor)),
      );
      yield* awaitSocketCount(relay, 1);
      expect(relay.sockets[0]!.url).not.toContain("secret");
      expect(relay.sockets[0]!.protocols).toEqual([
        "t3.session-fabric.v1",
        "t3.session-fabric.capability.controller-secret",
      ]);
      relay.sockets[0]!.open();
      expect(yield* Fiber.join(dispatched)).toEqual({ sequence: 8 });
      expect(relay.clientHellos.at(-1)).toMatchObject({
        afterEventSequence: 0,
        synchronize: false,
      });
      expect(capabilityCalls).toEqual(["viewer", "controller"]);
    }),
  );

  it.live("resumes viewer sockets from the authoritative relay event cursor", () =>
    Effect.gen(function* () {
      const authoritative = {
        ...snapshot,
        session: {
          ...snapshot.session,
          cursor: { eventSequence: 23, snapshotSequence: 7 },
        },
        compactedThroughEventSequence: 23,
      };
      const relay = new TestRelay(authoritative, false);
      const source = makeSource(relay, "client-authoritative-resume", (() =>
        Promise.resolve(Response.json(authoritative))) as typeof fetch);
      expect(yield* source.authoritativeThreadSnapshot({} as never, THREAD_ID)).toEqual(
        Option.some(authoritative.thread),
      );
      const streamed = yield* Effect.forkChild(
        source
          .subscribeThread(() =>
            Effect.succeed({
              threadId: THREAD_ID,
              afterSequence: 0,
              requestCompletionMarker: true,
            }),
          )
          .pipe(
            Stream.runDrain,
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
      );

      yield* awaitSocketCount(relay, 1);
      relay.sockets[0]!.open();
      yield* awaitHelloCount(relay, 1);
      yield* Fiber.interrupt(streamed);

      expect(relay.clientHellos[0]).toMatchObject({ afterEventSequence: 23 });
      expect(relay.clientHellos[0]?.synchronize).toBeUndefined();
    }),
  );

  it.effect("accepts cursor-newer Scaffold replacement and local transition records", () =>
    Effect.gen(function* () {
      const relay = new TestRelay();
      const replacementSnapshot: SessionFabricSnapshot = {
        ...snapshot,
        session: {
          ...snapshot.session,
          location: {
            ...snapshot.session.location,
            scaffoldSessionId: "ses-scaffold-replacement",
            scaffoldSessionUrl: "https://scaffold.example/sessions/ses-scaffold-replacement",
            scaffoldLifecycleEpoch: 0,
          },
          cursor: { eventSequence: 2, snapshotSequence: 8 },
          updatedAt: "2026-07-24T19:10:00.000Z",
        },
      };
      const localTransitionSnapshot: SessionFabricSnapshot = {
        ...replacementSnapshot,
        session: {
          ...replacementSnapshot.session,
          location: {
            ...replacementSnapshot.session.location,
            environmentKind: "local",
            scaffoldSessionId: null,
            scaffoldSessionUrl: null,
            scaffoldLifecycleEpoch: null,
          },
          cursor: { eventSequence: 3, snapshotSequence: 9 },
          updatedAt: "2026-07-24T18:10:00.000Z",
        },
      };
      let snapshotFetchCount = 0;
      const capabilityBodies: Array<Record<string, unknown>> = [];
      const authorization = makeSessionFabricCapabilityAuthorization({
        endpoint: "https://t3.example/api/session-fabric/capabilities",
        fetch: (async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
            role: "viewer" | "controller";
          };
          capabilityBodies.push(body);
          return Response.json({
            capability: `${body.role}-replacement-secret`,
            tokenType: "Bearer",
            role: body.role,
            scopes:
              body.role === "viewer"
                ? ["directory:read", "session:read"]
                : ["session:read", "session:command"],
            expiresAt: "2026-07-24T21:00:00.000Z",
            issuer: "scaffold",
            audience: "session-fabric",
            keyId: "key-1",
            bindings:
              body.role === "viewer"
                ? {}
                : body.environmentKind === "local"
                  ? {
                      fabricSessionId: body.fabricSessionId,
                      environmentKind: "local",
                      environmentId: body.environmentId,
                      threadId: body.threadId,
                    }
                  : {
                      fabricSessionId: body.fabricSessionId,
                      scaffoldSessionId: body.scaffoldSessionId,
                      scaffoldLifecycleEpoch: body.scaffoldLifecycleEpoch,
                    },
          });
        }) as typeof fetch,
      });
      const source = makeRelaySessionFabricUiSessionSource({
        relayBaseUrl: "https://relay.example.test/",
        sessionId: SESSION_ID,
        clientId: SessionFabricClientId.make("client-scaffold-replacement"),
        environmentId: ENVIRONMENT_ID,
        environmentLabel: "Relay test",
        authorization,
        fetch: (() =>
          Promise.resolve(
            Response.json(
              [snapshot, replacementSnapshot, localTransitionSnapshot][snapshotFetchCount++] ??
                localTransitionSnapshot,
            ),
          )) as typeof fetch,
        webSocketConstructor: relay.construct,
      });

      yield* source.authoritativeThreadSnapshot({} as never, THREAD_ID);
      yield* source.authoritativeThreadSnapshot({} as never, THREAD_ID);
      const dispatched = yield* Effect.forkChild(
        source
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("command-scaffold-replacement"),
            threadId: THREAD_ID,
            title: "Replacement",
          })
          .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor)),
      );
      yield* awaitSocketCount(relay, 1);
      relay.sockets[0]!.open();
      expect(yield* Fiber.join(dispatched)).toEqual({ sequence: 8 });
      expect(capabilityBodies.at(-1)).toMatchObject({
        role: "controller",
        scaffoldSessionId: "ses-scaffold-replacement",
        scaffoldLifecycleEpoch: 0,
      });

      yield* source.authoritativeThreadSnapshot({} as never, THREAD_ID);
      const localDispatch = yield* Effect.forkChild(
        source
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("command-local-transition"),
            threadId: THREAD_ID,
            title: "Local transition",
          })
          .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor)),
      );
      yield* awaitSocketCount(relay, 2);
      relay.sockets[1]!.open();
      expect(yield* Fiber.join(localDispatch)).toEqual({ sequence: 8 });
      expect(capabilityBodies.at(-1)).toMatchObject({
        role: "controller",
        environmentKind: "local",
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
      });
    }),
  );

  it.effect("uses an exact local controller binding for a public local session", () =>
    Effect.gen(function* () {
      const relay = new TestRelay();
      const capabilityBodies: unknown[] = [];
      const localSnapshot: SessionFabricSnapshot = {
        ...snapshot,
        session: {
          ...snapshot.session,
          location: {
            ...snapshot.session.location,
            environmentKind: "local",
            scaffoldSessionId: null,
            scaffoldSessionUrl: null,
            scaffoldLifecycleEpoch: null,
          },
        },
      };
      const authorization = makeSessionFabricCapabilityAuthorization({
        endpoint: "https://t3.example/api/session-fabric/capabilities",
        fetch: (async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { role: string };
          capabilityBodies.push(body);
          return Response.json({
            capability: `${body.role}.local.token`,
            tokenType: "Bearer",
            role: body.role,
            scopes:
              body.role === "viewer"
                ? ["directory:read", "session:read"]
                : ["session:read", "session:command"],
            expiresAt: "2026-07-24T21:00:00.000Z",
            issuer: "scaffold",
            audience: "session-fabric",
            keyId: "key-1",
            bindings:
              body.role === "viewer"
                ? {}
                : {
                    fabricSessionId: SESSION_ID,
                    environmentKind: "local",
                    environmentId: ENVIRONMENT_ID,
                    threadId: THREAD_ID,
                  },
          });
        }) as typeof fetch,
      });
      const source = makeRelaySessionFabricUiSessionSource({
        relayBaseUrl: "https://relay.example.test/",
        sessionId: SESSION_ID,
        clientId: SessionFabricClientId.make("client-local-controller"),
        environmentId: ENVIRONMENT_ID,
        environmentLabel: "Local relay test",
        authorization,
        fetch: (() => Promise.resolve(Response.json(localSnapshot))) as typeof fetch,
        webSocketConstructor: relay.construct,
      });

      yield* source.authoritativeThreadSnapshot({} as never, THREAD_ID);
      const dispatched = yield* Effect.forkChild(
        source
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("command-local-authorized"),
            threadId: THREAD_ID,
            title: "Local authorized",
          })
          .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor)),
      );
      yield* awaitSocketCount(relay, 1);
      relay.sockets[0]!.open();
      expect(yield* Fiber.join(dispatched)).toEqual({ sequence: 8 });
      expect(capabilityBodies).toEqual([
        { role: "viewer" },
        {
          role: "controller",
          fabricSessionId: SESSION_ID,
          environmentKind: "local",
          environmentId: ENVIRONMENT_ID,
          threadId: THREAD_ID,
        },
      ]);
    }),
  );

  it.effect("refreshes an expired viewer websocket capability once", () =>
    Effect.gen(function* () {
      const relay = new TestRelay();
      let capabilityCalls = 0;
      const authorization = makeSessionFabricCapabilityAuthorization({
        endpoint: "https://t3.example/api/session-fabric/capabilities",
        now: () => Date.parse("2026-07-24T20:00:00.000Z"),
        fetch: (async () => {
          capabilityCalls += 1;
          return Response.json({
            capability: `viewer-${capabilityCalls}`,
            tokenType: "Bearer",
            role: "viewer",
            scopes: ["directory:read", "session:read"],
            expiresAt: "2026-07-24T21:00:00.000Z",
            issuer: "scaffold",
            audience: "session-fabric",
            keyId: "key-1",
            bindings: {},
          });
        }) as typeof fetch,
      });
      const source = makeRelaySessionFabricUiSessionSource({
        relayBaseUrl: "https://relay.example.test/",
        sessionId: SESSION_ID,
        clientId: SessionFabricClientId.make("client-refresh"),
        environmentId: ENVIRONMENT_ID,
        environmentLabel: "Relay test",
        authorization,
        fetch: (() => Promise.resolve(Response.json(snapshot))) as typeof fetch,
        webSocketConstructor: relay.construct,
        reconnectDelay: 0,
        now: () => NOW,
      });
      const streamed = yield* Effect.forkChild(
        source
          .subscribeThread(() =>
            Effect.succeed({
              threadId: THREAD_ID,
              afterSequence: 0,
              requestCompletionMarker: true,
            }),
          )
          .pipe(
            Stream.runDrain,
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
      );

      yield* awaitSocketCount(relay, 1);
      expect(relay.sockets[0]!.protocols.at(-1)).toBe("t3.session-fabric.capability.viewer-1");
      relay.sockets[0]!.open();
      yield* awaitHelloCount(relay, 1);
      relay.sockets[0]!.close(4401, "expired");
      yield* awaitSocketCount(relay, 2);
      expect(relay.sockets[1]!.protocols.at(-1)).toBe("t3.session-fabric.capability.viewer-2");
      yield* awaitCloseListener(relay.sockets[1]!);
      relay.sockets[1]!.close(4401, "revoked");
      for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;

      yield* Fiber.interrupt(streamed);
      expect(capabilityCalls).toBe(2);
      expect(relay.sockets).toHaveLength(2);
    }),
  );

  it.effect("does not reconnect a viewer websocket denied with 4403", () =>
    Effect.gen(function* () {
      const relay = new TestRelay();
      let capabilityCalls = 0;
      const source = makeRelaySessionFabricUiSessionSource({
        relayBaseUrl: "https://relay.example.test/",
        sessionId: SESSION_ID,
        clientId: SessionFabricClientId.make("client-read-only"),
        environmentId: ENVIRONMENT_ID,
        environmentLabel: "Relay test",
        authorization: makeSessionFabricCapabilityAuthorization({
          endpoint: "https://t3.example/api/session-fabric/capabilities",
          fetch: (async () => {
            capabilityCalls += 1;
            return Response.json({
              capability: "viewer-secret",
              tokenType: "Bearer",
              role: "viewer",
              scopes: ["directory:read", "session:read"],
              expiresAt: "2026-07-24T21:00:00.000Z",
              issuer: "scaffold",
              audience: "session-fabric",
              keyId: "key-1",
              bindings: {},
            });
          }) as typeof fetch,
        }),
        fetch: (() => Promise.resolve(Response.json(snapshot))) as typeof fetch,
        webSocketConstructor: relay.construct,
        reconnectDelay: 0,
      });
      const streamed = yield* Effect.forkChild(
        source
          .subscribeThread(() =>
            Effect.succeed({
              threadId: THREAD_ID,
              afterSequence: 0,
              requestCompletionMarker: true,
            }),
          )
          .pipe(
            Stream.runDrain,
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
      );

      yield* awaitSocketCount(relay, 1);
      yield* awaitCloseListener(relay.sockets[0]!);
      relay.sockets[0]!.close(4403, "read only");
      for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;

      yield* Fiber.interrupt(streamed);
      expect(relay.sockets).toHaveLength(1);
      expect(capabilityCalls).toBe(1);
    }),
  );

  it.effect("forces one viewer refresh when an upgrade fails as 1006", () =>
    Effect.gen(function* () {
      const relay = new TestRelay();
      let capabilityCalls = 0;
      const source = makeRelaySessionFabricUiSessionSource({
        relayBaseUrl: "https://relay.example.test/",
        sessionId: SESSION_ID,
        clientId: SessionFabricClientId.make("client-upgrade-refresh"),
        environmentId: ENVIRONMENT_ID,
        environmentLabel: "Relay test",
        authorization: makeSessionFabricCapabilityAuthorization({
          endpoint: "https://t3.example/api/session-fabric/capabilities",
          fetch: (async () => {
            capabilityCalls += 1;
            return Response.json({
              capability: `viewer-${capabilityCalls}`,
              tokenType: "Bearer",
              role: "viewer",
              scopes: ["directory:read", "session:read"],
              expiresAt: "2026-07-24T21:00:00.000Z",
              issuer: "scaffold",
              audience: "session-fabric",
              keyId: "key-1",
              bindings: {},
            });
          }) as typeof fetch,
        }),
        fetch: (() => Promise.resolve(Response.json(snapshot))) as typeof fetch,
        webSocketConstructor: relay.construct,
        reconnectDelay: 0,
      });
      const streamed = yield* Effect.forkChild(
        source
          .subscribeThread(() =>
            Effect.succeed({
              threadId: THREAD_ID,
              afterSequence: 0,
              requestCompletionMarker: true,
            }),
          )
          .pipe(
            Stream.runDrain,
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          ),
      );

      yield* awaitSocketCount(relay, 1);
      yield* awaitCloseListener(relay.sockets[0]!);
      relay.sockets[0]!.close(1006, "upgrade rejected");
      yield* awaitSocketCount(relay, 2);
      expect(relay.sockets[1]!.protocols.at(-1)).toBe("t3.session-fabric.capability.viewer-2");
      yield* awaitCloseListener(relay.sockets[1]!);
      relay.sockets[1]!.close(1006, "upgrade rejected again");
      for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;

      yield* Fiber.interrupt(streamed);
      expect(capabilityCalls).toBe(2);
      expect(relay.sockets).toHaveLength(2);
    }),
  );

  it.effect("keeps a shared session read-only when controller authority is denied", () =>
    Effect.gen(function* () {
      const relay = new TestRelay();
      const source = makeRelaySessionFabricUiSessionSource({
        relayBaseUrl: "https://relay.example.test/",
        sessionId: SESSION_ID,
        clientId: SessionFabricClientId.make("client-viewer-only"),
        environmentId: ENVIRONMENT_ID,
        environmentLabel: "Relay test",
        authorization: makeSessionFabricCapabilityAuthorization({
          endpoint: "https://t3.example/api/session-fabric/capabilities",
          fetch: (async (_input, init) => {
            const role = (JSON.parse(String(init?.body)) as { role: string }).role;
            return role === "controller"
              ? new Response(null, { status: 403 })
              : Response.json({
                  capability: "viewer-secret",
                  tokenType: "Bearer",
                  role: "viewer",
                  scopes: ["directory:read", "session:read"],
                  expiresAt: "2026-07-24T21:00:00.000Z",
                  issuer: "scaffold",
                  audience: "session-fabric",
                  keyId: "key-1",
                  bindings: {},
                });
          }) as typeof fetch,
        }),
        fetch: (() => Promise.resolve(Response.json(snapshot))) as typeof fetch,
        webSocketConstructor: relay.construct,
      });

      const error = yield* source
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("command-denied"),
          threadId: THREAD_ID,
          title: "Denied",
        })
        .pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.flip,
        );
      expect(error.message).toContain("read-only");
      expect(relay.sockets).toHaveLength(0);
    }),
  );

  it.effect("keeps a shared session read-only when the relay closes commands with 4403", () =>
    Effect.gen(function* () {
      const relay = new TestRelay();
      const source = makeRelaySessionFabricUiSessionSource({
        relayBaseUrl: "https://relay.example.test/",
        sessionId: SESSION_ID,
        clientId: SessionFabricClientId.make("client-controller-read-only"),
        environmentId: ENVIRONMENT_ID,
        environmentLabel: "Relay test",
        authorization: makeSessionFabricCapabilityAuthorization({
          endpoint: "https://t3.example/api/session-fabric/capabilities",
          fetch: (async (_input, init) => {
            const role = (JSON.parse(String(init?.body)) as { role: string }).role;
            return Response.json({
              capability: `${role}-secret`,
              tokenType: "Bearer",
              role,
              scopes:
                role === "viewer"
                  ? ["directory:read", "session:read"]
                  : ["session:read", "session:command"],
              expiresAt: "2026-07-24T21:00:00.000Z",
              issuer: "scaffold",
              audience: "session-fabric",
              keyId: "key-1",
              bindings:
                role === "viewer"
                  ? {}
                  : {
                      fabricSessionId: SESSION_ID,
                      scaffoldSessionId: "ses-scaffold-1",
                      scaffoldLifecycleEpoch: 2,
                    },
            });
          }) as typeof fetch,
        }),
        fetch: (() => Promise.resolve(Response.json(snapshot))) as typeof fetch,
        webSocketConstructor: relay.construct,
      });

      const dispatched = yield* Effect.forkChild(
        source
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("command-controller-denied"),
            threadId: THREAD_ID,
            title: "Denied",
          })
          .pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.flip,
          ),
      );
      yield* awaitSocketCount(relay, 1);
      yield* awaitCloseListener(relay.sockets[0]!);
      relay.sockets[0]!.close(4403, "read only");

      const error = yield* Fiber.join(dispatched);
      expect(error.message).toContain("read-only");
      expect(relay.sockets).toHaveLength(1);
    }),
  );
});
