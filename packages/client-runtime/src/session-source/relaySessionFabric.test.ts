import {
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  SESSION_FABRIC_PROTOCOL_VERSION,
  SessionFabricClientFrame,
  SessionFabricClientId,
  SessionFabricServerFrame,
  SessionFabricSessionId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type SessionFabricClientFrame as SessionFabricClientFrameType,
  type SessionFabricServerFrame as SessionFabricServerFrameType,
  type SessionFabricSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  makeRelaySessionFabricHttpUrl,
  makeRelaySessionFabricUiSessionSource,
  makeRelaySessionFabricWebSocketUrl,
} from "./relaySessionFabric.ts";

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
      environmentKind: "local",
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      repositoryRoot: project.workspaceRoot,
      worktreePath: thread.worktreePath,
      scaffoldSessionId: null,
      scaffoldSessionUrl: null,
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
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();
  private readonly relay: TestRelay;

  constructor(url: string, relay: TestRelay) {
    this.url = url;
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
  clientHelloCount = 0;

  readonly construct = (url: string) => {
    const socket = new TestWebSocket(url, this);
    this.sockets.push(socket);
    return socket as unknown as globalThis.WebSocket;
  };

  receive(socket: TestWebSocket, frame: SessionFabricClientFrameType) {
    if (frame.type === "client.hello") {
      this.clientHelloCount += 1;
      socket.serverFrame({ type: "session.snapshot", snapshot });
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

  private broadcast(frame: SessionFabricServerFrameType) {
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

function makeSource(relay: TestRelay, clientId: string) {
  return makeRelaySessionFabricUiSessionSource({
    relayBaseUrl: "https://relay.example.test/base/",
    sessionId: SESSION_ID,
    clientId: SessionFabricClientId.make(clientId),
    environmentId: ENVIRONMENT_ID,
    environmentLabel: "Relay test",
    fetch: (() => Promise.resolve(new Response(JSON.stringify(snapshot)))) as typeof fetch,
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
});
