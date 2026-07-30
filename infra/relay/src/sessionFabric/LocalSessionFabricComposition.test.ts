import {
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  SessionFabricClientFrame,
  SessionFabricClientId,
  SessionFabricRunnerId,
  SessionFabricServerFrame,
  SessionFabricSessionId,
  ThreadId,
  type OrchestrationEvent,
  type SessionFabricCapabilityClaims,
  type SessionFabricCapabilityGrant,
  type SessionFabricClientFrame as SessionFabricClientFrameType,
  type SessionFabricRunnerHello,
  type SessionFabricServerFrame as SessionFabricServerFrameType,
  type SessionFabricSnapshot,
} from "@t3tools/contracts";
import {
  makeRelaySessionFabricUiSessionSource,
  type SessionFabricAuthorizationShape,
} from "@t3tools/client-runtime/session-source";
import { capabilityCanReadSession } from "@t3tools/shared/sessionFabricCapability";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EnvironmentSupervisor from "../../../../packages/client-runtime/src/connection/supervisor.ts";
import {
  localControllerMatchesPinnedAuthority,
  localRunnerCanClaimPinnedAuthority,
  type LocalSessionFabricPinnedAuthority,
} from "./SessionStreamCoordinator.ts";
import { decideAuthorizedCommandSubmit } from "./SessionStreamModel.ts";

const NOW = "2026-07-28T20:00:00.000Z";
const SESSION_ID = SessionFabricSessionId.make("sf:environment-a:thread-a");
const ENVIRONMENT_ID = EnvironmentId.make("environment-a");
const THREAD_ID = ThreadId.make("thread-a");
const PROJECT_ID = ProjectId.make("project-a");
const RUNNER_ID = SessionFabricRunnerId.make("runner:environment-a");

const snapshot: SessionFabricSnapshot = {
  session: {
    sessionId: SESSION_ID,
    title: "Local shared session",
    publication: "public",
    runnerState: "online",
    location: {
      environmentKind: "local",
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      repositoryRoot: "/workspace/project-a",
      worktreePath: "/workspace/project-a",
      scaffoldSessionId: null,
      scaffoldSessionUrl: null,
      scaffoldLifecycleEpoch: null,
    },
    initialPrompt: "Share this local session",
    searchableText: "Share this local session",
    summary: null,
    cursor: { eventSequence: 0, snapshotSequence: 1 },
    lastEventAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  },
  shell: {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project A",
        workspaceRoot: "/workspace/project-a",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Local shared session",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "gpt-5.6-terra",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: "/workspace/project-a",
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
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
    updatedAt: NOW,
  },
  thread: {
    snapshotSequence: 1,
    thread: {
      id: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Local shared session",
      modelSelection: {
        instanceId: ProviderInstanceId.make("omp"),
        model: "gpt-5.6-terra",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: "/workspace/project-a",
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
    },
  },
  compactedThroughEventSequence: 0,
};

const baseClaims = {
  v: 1,
  iss: "https://local.test",
  aud: "ashler-session-fabric",
  sub: "actor-a",
  jti: "capability",
  iat: 100,
  nbf: 100,
  exp: 200,
} as const;

const runnerClaims = {
  ...baseClaims,
  role: "runner",
  scopes: ["session:publish", "session:execute"],
  fabricSessionId: SESSION_ID,
  environmentKind: "local",
  environmentId: ENVIRONMENT_ID,
  threadId: THREAD_ID,
  runnerId: RUNNER_ID,
  actorId: "actor-a",
} as const satisfies SessionFabricCapabilityClaims;

const runnerHello = {
  protocolVersion: 1,
  sessionId: SESSION_ID,
  runnerId: RUNNER_ID,
  runnerGeneration: 0,
  location: snapshot.session.location,
  publication: "public",
  lastCommittedEventSequence: 0,
  connectedAt: NOW,
} as const satisfies SessionFabricRunnerHello;

const pinned: LocalSessionFabricPinnedAuthority = {
  sessionId: SESSION_ID,
  environmentId: ENVIRONMENT_ID,
  threadId: THREAD_ID,
  runnerId: RUNNER_ID,
  actorId: "actor-a",
};

const viewerClaims = (actorId: string): SessionFabricCapabilityClaims => ({
  ...baseClaims,
  sub: actorId,
  jti: `viewer-${actorId}`,
  role: "viewer",
  scopes: ["directory:read", "session:read"],
  actorId,
});

const controllerClaims = (actorId: string): SessionFabricCapabilityClaims => ({
  ...baseClaims,
  sub: actorId,
  jti: `controller-${actorId}`,
  role: "controller",
  scopes: ["session:read", "session:command"],
  fabricSessionId: SESSION_ID,
  environmentKind: "local",
  environmentId: ENVIRONMENT_ID,
  threadId: THREAD_ID,
  actorId,
});

const encodeServerFrame = Schema.encodeSync(Schema.fromJsonString(SessionFabricServerFrame));
const decodeClientFrame = Schema.decodeUnknownSync(Schema.fromJsonString(SessionFabricClientFrame));

type SocketEvent = {
  readonly type: "open" | "message" | "close" | "error";
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
};
type SocketListener = (event: SocketEvent) => void;

class ComposedSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = ComposedSocket.CONNECTING;
  private readonly listeners = new Map<SocketEvent["type"], Set<SocketListener>>();
  readonly relay: ComposedRelay;
  readonly claims: SessionFabricCapabilityClaims;

  constructor(relay: ComposedRelay, claims: SessionFabricCapabilityClaims) {
    this.relay = relay;
    this.claims = claims;
  }

  addEventListener(type: SocketEvent["type"], listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEvent["type"], listener: SocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.relay.receive(this, decodeClientFrame(data));
  }

  close(code = 1000, reason = "") {
    this.readyState = ComposedSocket.CLOSED;
    this.emit({ type: "close", code, reason });
  }

  open() {
    this.readyState = ComposedSocket.OPEN;
    this.emit({ type: "open" });
  }

  serverFrame(frame: SessionFabricServerFrameType) {
    this.emit({ type: "message", data: encodeServerFrame(frame) });
  }

  private emit(event: SocketEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
}

class ComposedRelay {
  readonly sockets: ComposedSocket[] = [];
  readonly claimsByToken = new Map<string, SessionFabricCapabilityClaims>();
  acceptedCommands = 0;
  rejectedCommands = 0;
  private eventSequence = 1;
  private readonly terminalReceipts = new Map<
    string,
    Extract<SessionFabricServerFrameType, { type: "command.receipt" }>["receipt"]
  >();

  constructor() {
    if (
      !localRunnerCanClaimPinnedAuthority({
        claims: runnerClaims,
        hello: runnerHello,
        pinned: null,
        sessionAlreadyClaimed: false,
      })
    ) {
      throw new Error("runner A could not pin the local session authority");
    }
  }

  register(token: string, claims: SessionFabricCapabilityClaims) {
    this.claimsByToken.set(token, claims);
  }

  readonly construct = (_url: string, protocols?: string | string[]) => {
    const values = typeof protocols === "string" ? [protocols] : (protocols ?? []);
    const token = values.at(-1)?.replace("t3.session-fabric.capability.", "") ?? "";
    const claims = this.claimsByToken.get(token);
    if (claims === undefined) throw new Error(`unknown capability token: ${token}`);
    const socket = new ComposedSocket(this, claims);
    this.sockets.push(socket);
    return socket as unknown as globalThis.WebSocket;
  };

  receive(socket: ComposedSocket, frame: SessionFabricClientFrameType) {
    if (frame.type === "client.hello") {
      if (capabilityCanReadSession(socket.claims, snapshot)) {
        socket.serverFrame({ type: "session.snapshot", snapshot });
        socket.serverFrame({
          type: "session.synchronized",
          cursor: { eventSequence: this.eventSequence, snapshotSequence: 1 },
        });
      } else {
        socket.close(4403, "read denied");
      }
      return;
    }
    if (frame.type !== "command.submit") return;

    const authorized = localControllerMatchesPinnedAuthority({
      claims: socket.claims,
      sessionId: frame.command.sessionId,
      publication: snapshot.session.publication,
      location: snapshot.session.location,
      pinned,
    });
    const decision = decideAuthorizedCommandSubmit({
      controllerMatchesSession: authorized,
      runnerState: snapshot.session.runnerState,
      eligibleRunnerCount: 1,
    });
    if (decision.type === "rejected") {
      this.rejectedCommands += 1;
      socket.serverFrame({
        type: "command.receipt",
        receipt: {
          sessionId: SESSION_ID,
          commandId: frame.command.commandId,
          status: "rejected",
          resultSequence: null,
          detail: decision.detail,
          updatedAt: NOW,
        },
      });
      return;
    }

    const existing = this.terminalReceipts.get(frame.command.commandId);
    if (existing !== undefined) {
      socket.serverFrame({ type: "command.receipt", receipt: existing });
      return;
    }

    this.acceptedCommands += 1;
    this.eventSequence += 1;
    const event: OrchestrationEvent = {
      sequence: this.eventSequence,
      eventId: EventId.make(`event-${this.eventSequence}`),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      occurredAt: NOW,
      commandId: frame.command.commandId,
      causationEventId: null,
      correlationId: frame.command.commandId,
      metadata: {},
      type: "thread.meta-updated",
      payload: { threadId: THREAD_ID, title: "Accepted from actor A", updatedAt: NOW },
    };
    const receipt = {
      sessionId: SESSION_ID,
      commandId: frame.command.commandId,
      status: "accepted" as const,
      resultSequence: event.sequence,
      detail: null,
      updatedAt: NOW,
    };
    this.terminalReceipts.set(frame.command.commandId, receipt);
    socket.serverFrame({ type: "command.receipt", receipt });
    this.broadcast({
      type: "session.event",
      sequence: this.eventSequence,
      published: {
        sessionId: SESSION_ID,
        runnerId: RUNNER_ID,
        runnerGeneration: 0,
        event,
      },
    });
  }

  private broadcast(frame: SessionFabricServerFrameType) {
    for (const socket of this.sockets) {
      if (socket.readyState === ComposedSocket.OPEN) socket.serverFrame(frame);
    }
  }
}

function grant(role: "viewer" | "controller", actorId: string): SessionFabricCapabilityGrant {
  return {
    capability: `${role}-${actorId}`,
    tokenType: "Bearer",
    role,
    scopes:
      role === "viewer" ? ["directory:read", "session:read"] : ["session:read", "session:command"],
    expiresAt: "2026-07-28T21:00:00.000Z",
    issuer: "https://local.test",
    audience: "ashler-session-fabric",
    keyId: "local-key",
    bindings:
      role === "viewer"
        ? {}
        : {
            fabricSessionId: SESSION_ID,
            environmentKind: "local",
            environmentId: ENVIRONMENT_ID,
            threadId: THREAD_ID,
          },
  };
}

function authorization(actorId: string): SessionFabricAuthorizationShape {
  return {
    mode: "capability",
    viewer: () => Effect.succeed(grant("viewer", actorId)),
    controller: () => Effect.succeed(grant("controller", actorId)),
    invalidate: () => {},
  };
}

const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({} as never);

describe("local session fabric composition", () => {
  it.effect(
    "keeps runner actor A pinned while authenticated viewers share one exactly-once command result without browser storage",
    () =>
      Effect.gen(function* () {
        expect("localStorage" in globalThis).toBe(false);
        expect("sessionStorage" in globalThis).toBe(false);

        const relay = new ComposedRelay();
        for (const actorId of ["actor-a", "actor-b"]) {
          relay.register(`viewer-${actorId}`, viewerClaims(actorId));
          relay.register(`controller-${actorId}`, controllerClaims(actorId));
        }

        const makeSource = (actorId: string) =>
          makeRelaySessionFabricUiSessionSource({
            relayBaseUrl: "https://relay.example.test/",
            sessionId: SESSION_ID,
            clientId: SessionFabricClientId.make(`client-${actorId}`),
            environmentId: ENVIRONMENT_ID,
            environmentLabel: `Local ${actorId}`,
            authorization: authorization(actorId),
            fetch: (() => Promise.resolve(Response.json(snapshot))) as typeof fetch,
            webSocketConstructor: relay.construct,
            now: () => NOW,
          });
        const actorA = makeSource("actor-a");
        const actorB = makeSource("actor-b");

        expect(yield* actorB.authoritativeThreadSnapshot({} as never, THREAD_ID)).toBeDefined();

        const eventsA = yield* Queue.unbounded<OrchestrationEvent>();
        const eventsB = yield* Queue.unbounded<OrchestrationEvent>();
        const subscribe = (
          source: ReturnType<typeof makeSource>,
          output: Queue.Queue<OrchestrationEvent>,
        ) =>
          source
            .subscribeThread(() =>
              Effect.succeed({
                threadId: THREAD_ID,
                afterSequence: 0,
                requestCompletionMarker: true,
              }),
            )
            .pipe(
              Stream.runForEach((item) =>
                item.kind === "event" ? Queue.offer(output, item.event) : Effect.void,
              ),
              Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            );
        const streamA = yield* Effect.forkChild(subscribe(actorA, eventsA));
        const streamB = yield* Effect.forkChild(subscribe(actorB, eventsB));
        while (relay.sockets.length < 2) yield* Effect.yieldNow;
        relay.sockets[0]!.open();
        relay.sockets[1]!.open();

        const acceptedByActorB = yield* Effect.forkChild(
          actorB
            .dispatch({
              type: "thread.meta.update",
              commandId: CommandId.make("command-b"),
              threadId: THREAD_ID,
              title: "Accepted from actor B",
            })
            .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor)),
        );
        while (relay.sockets.length < 3) yield* Effect.yieldNow;
        relay.sockets[2]!.open();
        expect(yield* Fiber.join(acceptedByActorB)).toEqual({ sequence: 2 });

        const commandA = {
          type: "thread.meta.update" as const,
          commandId: CommandId.make("command-a"),
          threadId: THREAD_ID,
          title: "Accepted from actor A",
        };
        const acceptedFiber = yield* Effect.forkChild(
          actorA
            .dispatch(commandA)
            .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor)),
        );
        while (relay.sockets.length < 4) yield* Effect.yieldNow;
        relay.sockets[3]!.open();
        const accepted = yield* Fiber.join(acceptedFiber);
        expect(accepted).toEqual({ sequence: 3 });

        const duplicateFiber = yield* Effect.forkChild(
          actorA
            .dispatch(commandA)
            .pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor)),
        );
        while (relay.sockets.length < 5) yield* Effect.yieldNow;
        relay.sockets[4]!.open();
        const duplicate = yield* Fiber.join(duplicateFiber);
        expect(duplicate).toEqual({ sequence: 3 });

        expect((yield* Queue.take(eventsA)).commandId).toBe("command-b");
        expect((yield* Queue.take(eventsB)).commandId).toBe("command-b");
        expect((yield* Queue.take(eventsA)).commandId).toBe("command-a");
        expect((yield* Queue.take(eventsB)).commandId).toBe("command-a");
        expect(yield* Queue.size(eventsA)).toBe(0);
        expect(yield* Queue.size(eventsB)).toBe(0);
        expect(relay.acceptedCommands).toBe(2);
        expect(relay.rejectedCommands).toBe(0);

        yield* Fiber.interrupt(streamA);
        yield* Fiber.interrupt(streamB);
      }),
  );
});
