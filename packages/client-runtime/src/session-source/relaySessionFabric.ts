import {
  OrchestrationDispatchCommandError,
  SESSION_FABRIC_PROTOCOL_VERSION,
  SessionFabricClientFrame,
  SessionFabricServerFrame,
  SessionFabricSessionId,
  SessionFabricSnapshot as SessionFabricSnapshotSchema,
  type ClientOrchestrationCommand,
  type OrchestrationShellStreamItem,
  type OrchestrationSubscribeShellInput,
  type OrchestrationSubscribeThreadInput,
  type OrchestrationThreadStreamItem,
  type SessionFabricClientId,
  type SessionFabricCommandReceipt,
  type SessionFabricServerFrame as SessionFabricServerFrameType,
  type SessionFabricSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";

import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { UiSessionSourceCapabilities, UiSessionSourceShape } from "./source.ts";

const CAPABILITIES: UiSessionSourceCapabilities = {
  shellResumeCompletionMarker: true,
  threadResumeCompletionMarker: true,
};

const decodeSnapshot = Schema.decodeUnknownEffect(SessionFabricSnapshotSchema);
const decodeServerFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SessionFabricServerFrame),
);
const encodeClientFrame = Schema.encodeSync(Schema.fromJsonString(SessionFabricClientFrame));

type WebSocketConstructor = (
  url: string,
  protocols?: string | Array<string>,
) => globalThis.WebSocket;

export interface RelaySessionFabricSourceOptions {
  readonly relayBaseUrl: string | URL;
  readonly sessionId: SessionFabricSessionId;
  readonly clientId: SessionFabricClientId;
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly webSocketConstructor?: WebSocketConstructor;
  readonly now?: () => string;
  readonly reconnectDelay?: Duration.Input;
  readonly dispatchTimeout?: Duration.Input;
}

const currentIso = () => DateTime.formatIso(DateTime.nowUnsafe());

export function makeRelaySessionFabricHttpUrl(
  relayBaseUrl: string | URL,
  sessionId: SessionFabricSessionId,
  resource: "snapshot" | "events",
): URL {
  const url = new URL(relayBaseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/session-fabric/sessions/${encodeURIComponent(sessionId)}/${resource}`;
  url.search = "";
  url.hash = "";
  return url;
}

export function makeRelaySessionFabricWebSocketUrl(
  relayBaseUrl: string | URL,
  sessionId: SessionFabricSessionId,
): URL | null {
  const url = makeRelaySessionFabricHttpUrl(relayBaseUrl, sessionId, "snapshot");
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else return null;
  url.pathname = url.pathname.replace(/\/snapshot$/, "/connect");
  return url;
}

function isThreadSnapshot(snapshot: SessionFabricSnapshot, threadId: ThreadId): boolean {
  return snapshot.thread.thread.id === threadId;
}

export function makeRelaySessionFabricUiSessionSource(
  options: RelaySessionFabricSourceOptions,
): UiSessionSourceShape {
  const now = options.now ?? currentIso;
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
  const webSocketConstructor: WebSocketConstructor =
    options.webSocketConstructor ?? ((url, protocols) => new globalThis.WebSocket(url, protocols));
  const webSocketLayer = Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor);
  const socketUrl = makeRelaySessionFabricWebSocketUrl(options.relayBaseUrl, options.sessionId);

  const unavailable = (message: string) =>
    new EnvironmentRpcUnavailableError({
      environmentId: options.environmentId,
      message,
    });

  const loadSnapshot = Effect.fn("relay_session_fabric.load_snapshot")(function* () {
    const url = makeRelaySessionFabricHttpUrl(options.relayBaseUrl, options.sessionId, "snapshot");
    const response = yield* Effect.promise(() => fetchImplementation(url)).pipe(Effect.option);
    if (Option.isNone(response) || !response.value.ok) {
      return Option.none<SessionFabricSnapshot>();
    }
    const payload = yield* Effect.promise(() => response.value.json() as Promise<unknown>).pipe(
      Effect.option,
    );
    if (Option.isNone(payload)) return Option.none<SessionFabricSnapshot>();
    const decoded = yield* decodeSnapshot(payload.value).pipe(Effect.option);
    return decoded;
  });

  const makeHello = (afterEventSequence: number) => ({
    type: "client.hello" as const,
    hello: {
      protocolVersion: SESSION_FABRIC_PROTOCOL_VERSION,
      sessionId: options.sessionId,
      clientId: options.clientId,
      afterEventSequence,
      connectedAt: now(),
    },
  });

  const subscribe = <A, R>(input: {
    readonly makeInput: Effect.Effect<
      OrchestrationSubscribeShellInput | OrchestrationSubscribeThreadInput,
      never,
      R
    >;
    readonly project: (
      frame: SessionFabricServerFrameType,
      localSequence: Ref.Ref<number>,
      requestCompletionMarker: boolean,
    ) => Effect.Effect<Option.Option<A>>;
  }): Stream.Stream<A, never, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* input.makeInput;
        const output = yield* Queue.unbounded<A>();
        const fabricSequence = yield* Ref.make(0);
        const localSequence = yield* Ref.make(subscription.afterSequence ?? 0);
        const requestCompletionMarker = subscription.requestCompletionMarker === true;

        if (socketUrl === null) return Stream.fromQueue(output);

        const runConnection = Effect.gen(function* () {
          const socket = yield* Socket.makeWebSocket(socketUrl.toString(), {
            closeCodeIsError: () => true,
            openTimeout: "10 seconds",
          });
          const write = yield* socket.writer;
          const incoming = yield* Queue.unbounded<SessionFabricServerFrameType>();
          const read = socket.runString(
            (message) =>
              decodeServerFrame(message).pipe(
                Effect.flatMap((frame) => Queue.offer(incoming, frame)),
                Effect.catch(() => Effect.void),
              ),
            {
              onOpen: Ref.get(fabricSequence).pipe(
                Effect.flatMap((sequence) => write(encodeClientFrame(makeHello(sequence)))),
                Effect.catchCause(() => Effect.void),
              ),
            },
          );
          const consume = Effect.forever(
            Queue.take(incoming).pipe(
              Effect.flatMap((frame) => {
                const updateFabricSequence =
                  frame.type === "session.event"
                    ? Ref.update(fabricSequence, (sequence) => Math.max(sequence, frame.sequence))
                    : frame.type === "session.synchronized"
                      ? Ref.update(fabricSequence, (sequence) =>
                          Math.max(sequence, frame.cursor.eventSequence),
                        )
                      : Effect.void;
                return updateFabricSequence.pipe(
                  Effect.andThen(input.project(frame, localSequence, requestCompletionMarker)),
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: (item) => Queue.offer(output, item).pipe(Effect.asVoid),
                    }),
                  ),
                );
              }),
            ),
          );
          yield* Effect.raceFirst(read, consume);
        }).pipe(Effect.provide(webSocketLayer));

        yield* Effect.forkScoped(
          Effect.forever(
            runConnection.pipe(
              Effect.catchCause(() => Effect.void),
              Effect.andThen(Effect.sleep(options.reconnectDelay ?? "1 second")),
            ),
          ),
        );
        return Stream.fromQueue(output);
      }),
    );

  const projectShellFrame = (
    frame: SessionFabricServerFrameType,
    localSequence: Ref.Ref<number>,
    requestCompletionMarker: boolean,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamItem>> => {
    switch (frame.type) {
      case "session.snapshot":
        return Ref.set(localSequence, frame.snapshot.shell.snapshotSequence).pipe(
          Effect.as(Option.some({ kind: "snapshot", snapshot: frame.snapshot.shell })),
        );
      case "session.synchronized":
        return Effect.succeed(
          requestCompletionMarker ? Option.some({ kind: "synchronized" as const }) : Option.none(),
        );
      default:
        return Effect.succeed(Option.none());
    }
  };

  const projectThreadFrame = (
    threadId: ThreadId,
    frame: SessionFabricServerFrameType,
    localSequence: Ref.Ref<number>,
    requestCompletionMarker: boolean,
  ): Effect.Effect<Option.Option<OrchestrationThreadStreamItem>> => {
    switch (frame.type) {
      case "session.snapshot":
        if (!isThreadSnapshot(frame.snapshot, threadId)) {
          return Effect.succeed(Option.none());
        }
        return Ref.set(localSequence, frame.snapshot.thread.snapshotSequence).pipe(
          Effect.as(Option.some({ kind: "snapshot", snapshot: frame.snapshot.thread })),
        );
      case "session.event":
        if (frame.published.sessionId !== options.sessionId) {
          return Effect.succeed(Option.none());
        }
        return Ref.modify(localSequence, (sequence) => {
          const eventSequence = frame.published.event.sequence;
          return eventSequence <= sequence
            ? [Option.none(), sequence]
            : [
                Option.some({ kind: "event" as const, event: frame.published.event }),
                eventSequence,
              ];
        });
      case "session.synchronized":
        return Effect.succeed(
          requestCompletionMarker ? Option.some({ kind: "synchronized" as const }) : Option.none(),
        );
      default:
        return Effect.succeed(Option.none());
    }
  };

  const dispatch: UiSessionSourceShape["dispatch"] = (command) => {
    if (socketUrl === null) {
      return Effect.fail(unavailable("The session fabric Relay URL is invalid."));
    }
    return Effect.scoped(
      Effect.gen(function* () {
        const receipt = yield* Deferred.make<SessionFabricCommandReceipt>();
        const socket = yield* Socket.makeWebSocket(socketUrl.toString(), {
          closeCodeIsError: () => true,
          openTimeout: "10 seconds",
        });
        const write = yield* socket.writer;
        const submittedAt = now();
        const run = socket.runString(
          (message) =>
            decodeServerFrame(message).pipe(
              Effect.flatMap((frame) => {
                if (
                  frame.type !== "command.receipt" ||
                  frame.receipt.commandId !== command.commandId
                ) {
                  return Effect.void;
                }
                return frame.receipt.status === "accepted" || frame.receipt.status === "rejected"
                  ? Deferred.succeed(receipt, frame.receipt).pipe(Effect.asVoid)
                  : Effect.void;
              }),
              Effect.catch(() => Effect.void),
            ),
          {
            onOpen: Effect.gen(function* () {
              yield* write(encodeClientFrame(makeHello(0)));
              yield* write(
                encodeClientFrame({
                  type: "command.submit",
                  command: {
                    sessionId: options.sessionId,
                    commandId: command.commandId,
                    clientId: options.clientId,
                    command,
                    submittedAt,
                  },
                }),
              );
            }).pipe(Effect.catchCause(() => Effect.void)),
          },
        );
        yield* Effect.forkScoped(run);
        const completed = yield* Deferred.await(receipt).pipe(
          Effect.timeout(options.dispatchTimeout ?? "30 seconds"),
          Effect.mapError(() => unavailable("The session runner did not accept the command.")),
        );
        if (completed.status === "accepted") {
          return { sequence: completed.resultSequence };
        }
        return yield* new OrchestrationDispatchCommandError({
          message: completed.detail ?? "The session runner rejected this command.",
        });
      }).pipe(Effect.provide(webSocketLayer)),
    );
  };

  return {
    authoritativeShellSnapshot: () =>
      loadSnapshot().pipe(Effect.map(Option.map((snapshot) => snapshot.shell))),
    authoritativeThreadSnapshot: (_prepared, threadId) =>
      loadSnapshot().pipe(
        Effect.map(
          Option.flatMap((snapshot) =>
            isThreadSnapshot(snapshot, threadId) ? Option.some(snapshot.thread) : Option.none(),
          ),
        ),
      ),
    subscribeShell: (makeInput) =>
      subscribe({
        makeInput: makeInput(CAPABILITIES),
        project: projectShellFrame,
      }),
    subscribeThread: (makeInput) =>
      Stream.unwrap(
        makeInput(CAPABILITIES).pipe(
          Effect.map((threadInput) =>
            subscribe({
              makeInput: Effect.succeed(threadInput),
              project: (frame, localSequence, requestCompletionMarker) =>
                projectThreadFrame(
                  threadInput.threadId,
                  frame,
                  localSequence,
                  requestCompletionMarker,
                ),
            }),
          ),
        ),
      ),
    dispatch,
    listThreads: () =>
      loadSnapshot().pipe(Effect.map(Option.map((snapshot) => snapshot.shell.threads))),
    listSessions: () =>
      loadSnapshot().pipe(
        Effect.map(
          Option.map((snapshot) =>
            snapshot.shell.threads.flatMap((thread) =>
              thread.session === null ? [] : [{ thread, session: thread.session }],
            ),
          ),
        ),
      ),
  };
}
