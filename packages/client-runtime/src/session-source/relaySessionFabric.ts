import {
  OrchestrationDispatchCommandError,
  SESSION_FABRIC_PROTOCOL_VERSION,
  SessionFabricClientFrame,
  SessionFabricServerFrame,
  SessionFabricSessionId,
  SessionFabricSnapshot as SessionFabricSnapshotSchema,
  type OrchestrationEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationSubscribeShellInput,
  type OrchestrationSubscribeThreadInput,
  type OrchestrationThreadStreamItem,
  type SessionFabricClientId,
  type SessionFabricCommandReceipt,
  type SessionFabricSessionRecord,
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
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";

import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { latestTurnAfterSessionSet } from "../state/threadReducer.ts";
import {
  SessionFabricAuthorizationError,
  type SessionFabricAuthorizationShape,
  type SessionFabricControllerBinding,
  sessionFabricAuthorizationHeaders,
  sessionFabricWebSocketProtocols,
} from "./sessionFabricAuthorization.ts";
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

const isSessionFabricAuthorizationError = Schema.is(SessionFabricAuthorizationError);

function relayCloseCode(cause: unknown, fallback = 1006): number {
  if (isSessionFabricAuthorizationError(cause)) {
    if (cause.reason === "permission") return 4403;
    if (cause.reason === "authentication") return 4401;
    return fallback;
  }
  if (Socket.SocketError.is(cause) && cause.reason._tag === "SocketCloseError") {
    return cause.reason.code;
  }
  return fallback;
}

export interface RelaySessionFabricSourceOptions {
  readonly relayBaseUrl: string | URL;
  readonly sessionId: SessionFabricSessionId;
  readonly clientId: SessionFabricClientId;
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly authorization: SessionFabricAuthorizationShape;
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
  let latestKnownSnapshot: SessionFabricSnapshot | null = null;
  let latestSessionSet: Extract<
    OrchestrationEvent,
    { readonly type: "thread.session-set" }
  > | null = null;

  const sessionRecordDominates = (
    candidate: SessionFabricSessionRecord,
    current: SessionFabricSessionRecord,
  ): boolean => {
    const sameScaffoldSession =
      candidate.location.environmentKind === "scaffold" &&
      current.location.environmentKind === "scaffold" &&
      candidate.location.scaffoldSessionId !== null &&
      candidate.location.scaffoldSessionId === current.location.scaffoldSessionId;
    const lifecycleDominates =
      !sameScaffoldSession ||
      (candidate.location.scaffoldLifecycleEpoch ?? -1) >=
        (current.location.scaffoldLifecycleEpoch ?? -1);
    const cursorDominates =
      candidate.cursor.eventSequence >= current.cursor.eventSequence &&
      candidate.cursor.snapshotSequence >= current.cursor.snapshotSequence;
    if (!cursorDominates || !lifecycleDominates) return false;
    const cursorAdvanced =
      candidate.cursor.eventSequence > current.cursor.eventSequence ||
      candidate.cursor.snapshotSequence > current.cursor.snapshotSequence;
    return cursorAdvanced || candidate.updatedAt >= current.updatedAt;
  };

  const applySessionSetToThread = <
    A extends Pick<
      SessionFabricSnapshot["thread"]["thread"],
      "id" | "latestTurn" | "session" | "updatedAt"
    >,
  >(
    candidate: A,
    snapshotSequence: number,
  ): A => {
    const event = latestSessionSet;
    if (
      event === null ||
      event.payload.threadId !== candidate.id ||
      event.sequence <= snapshotSequence
    ) {
      return candidate;
    }
    return {
      ...candidate,
      session: event.payload.session,
      latestTurn: latestTurnAfterSessionSet(candidate.latestTurn, event.payload.session),
      updatedAt: event.occurredAt,
    };
  };

  const applySessionSetOverlay = (candidate: SessionFabricSnapshot): SessionFabricSnapshot => ({
    ...candidate,
    shell: {
      ...candidate.shell,
      threads: candidate.shell.threads.map((thread) =>
        applySessionSetToThread(thread, candidate.shell.snapshotSequence),
      ),
    },
    thread: {
      ...candidate.thread,
      thread: applySessionSetToThread(candidate.thread.thread, candidate.thread.snapshotSequence),
    },
  });

  const rememberSnapshot = (candidate: SessionFabricSnapshot): SessionFabricSnapshot => {
    const current = latestKnownSnapshot;
    if (current === null) {
      latestKnownSnapshot = candidate;
      return applySessionSetOverlay(candidate);
    }

    latestKnownSnapshot = {
      session: sessionRecordDominates(candidate.session, current.session)
        ? candidate.session
        : current.session,
      shell:
        candidate.shell.snapshotSequence > current.shell.snapshotSequence
          ? candidate.shell
          : current.shell,
      thread:
        candidate.thread.snapshotSequence > current.thread.snapshotSequence
          ? candidate.thread
          : current.thread,
      compactedThroughEventSequence: Math.max(
        candidate.compactedThroughEventSequence,
        current.compactedThroughEventSequence,
      ),
    };
    return applySessionSetOverlay(latestKnownSnapshot);
  };

  const rememberSessionSet = (
    event: Extract<OrchestrationEvent, { readonly type: "thread.session-set" }>,
  ) => {
    if (latestSessionSet === null || event.sequence > latestSessionSet.sequence) {
      latestSessionSet = event;
    }
  };

  const unavailable = (message: string) =>
    new EnvironmentRpcUnavailableError({
      environmentId: options.environmentId,
      message,
    });

  const fetchSnapshot = (
    forceRefresh: boolean,
  ): Effect.Effect<Option.Option<Response>, SessionFabricAuthorizationError> =>
    Effect.gen(function* () {
      const url = makeRelaySessionFabricHttpUrl(
        options.relayBaseUrl,
        options.sessionId,
        "snapshot",
      );
      const grant = yield* options.authorization.viewer({ forceRefresh });
      const response = yield* Effect.promise(() =>
        fetchImplementation(url, { headers: sessionFabricAuthorizationHeaders(grant) }),
      ).pipe(Effect.option);
      if (
        Option.isSome(response) &&
        response.value.status === 401 &&
        !forceRefresh &&
        options.authorization.mode === "capability"
      ) {
        options.authorization.invalidate("viewer");
        return yield* fetchSnapshot(true);
      }
      return response;
    });

  const loadSnapshot = (): Effect.Effect<Option.Option<SessionFabricSnapshot>> =>
    Effect.gen(function* () {
      const response = yield* fetchSnapshot(false).pipe(
        Effect.catch(() => Effect.succeed(Option.none<Response>())),
      );
      if (Option.isNone(response) || !response.value.ok) {
        return Option.none<SessionFabricSnapshot>();
      }
      const payload = yield* Effect.promise(() => response.value.json() as Promise<unknown>).pipe(
        Effect.option,
      );
      if (Option.isNone(payload)) return Option.none<SessionFabricSnapshot>();
      const decoded = yield* decodeSnapshot(payload.value).pipe(Effect.option);
      if (Option.isNone(decoded)) return decoded;
      return Option.some(rememberSnapshot(decoded.value));
    });

  const controllerBinding = Effect.fn("relay_session_fabric.controller_binding")(function* () {
    const snapshot = latestKnownSnapshot ?? Option.getOrNull(yield* loadSnapshot());
    const location = snapshot?.session.location;
    if (location?.environmentKind === "local") {
      if (
        location.scaffoldSessionId !== null ||
        location.scaffoldSessionUrl !== null ||
        (location.scaffoldLifecycleEpoch !== null && location.scaffoldLifecycleEpoch !== undefined)
      ) {
        return yield* unavailable("The shared local session has a mixed execution binding.");
      }
      return {
        fabricSessionId: options.sessionId,
        environmentKind: "local",
        environmentId: location.environmentId,
        threadId: location.threadId,
      } satisfies SessionFabricControllerBinding;
    }
    if (
      location?.environmentKind !== "scaffold" ||
      location.scaffoldSessionId === null ||
      location.scaffoldLifecycleEpoch === null ||
      location.scaffoldLifecycleEpoch === undefined
    ) {
      return yield* unavailable(
        "The shared session does not have an authoritative Scaffold execution binding.",
      );
    }
    return {
      fabricSessionId: options.sessionId,
      scaffoldSessionId: location.scaffoldSessionId,
      scaffoldLifecycleEpoch: location.scaffoldLifecycleEpoch,
    } satisfies SessionFabricControllerBinding;
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
    readonly makeProject: () => (
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
        const project = input.makeProject();

        if (socketUrl === null) return Stream.fromQueue(output);

        const runConnection = (forceRefresh: boolean) => {
          let closeCode = 1006;
          let opened = false;
          return Effect.gen(function* () {
            const grant = yield* options.authorization.viewer({ forceRefresh });
            const socket = yield* Socket.makeWebSocket(socketUrl.toString(), {
              closeCodeIsError: (code) => {
                closeCode = code;
                return true;
              },
              openTimeout: "10 seconds",
              protocols: [...sessionFabricWebSocketProtocols(grant)],
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
                onOpen: Effect.sync(() => {
                  opened = true;
                }).pipe(
                  Effect.andThen(Ref.get(fabricSequence)),
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
                    Effect.andThen(project(frame, localSequence, requestCompletionMarker)),
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
          }).pipe(
            Effect.provide(webSocketLayer),
            Effect.catch((cause) =>
              Effect.fail({ closeCode: relayCloseCode(cause, closeCode), opened }),
            ),
          );
        };

        const runConnectionLoop = (
          forceRefresh: boolean,
          authRetryUsed: boolean,
        ): Effect.Effect<void, never, Scope.Scope> =>
          runConnection(forceRefresh).pipe(
            Effect.catch((failure) => {
              if (failure.closeCode === 4403) return Effect.void;
              const retryAlreadyUsed = failure.opened ? false : authRetryUsed;
              const mayBeAuthenticationFailure =
                failure.closeCode === 4401 || (failure.closeCode === 1006 && !failure.opened);
              if (mayBeAuthenticationFailure) {
                if (retryAlreadyUsed || options.authorization.mode !== "capability") {
                  return Effect.void;
                }
                options.authorization.invalidate("viewer");
                return runConnectionLoop(true, true);
              }
              return Effect.sleep(options.reconnectDelay ?? "1 second").pipe(
                Effect.andThen(runConnectionLoop(false, retryAlreadyUsed)),
              );
            }),
          );

        yield* Effect.forkScoped(runConnectionLoop(false, false));
        return Stream.fromQueue(output);
      }),
    );

  const makeProjectShellFrame = () => {
    let shellSnapshot =
      latestKnownSnapshot === null ? null : applySessionSetOverlay(latestKnownSnapshot).shell;
    let hasSeenSnapshot = latestKnownSnapshot !== null;

    return (
      frame: SessionFabricServerFrameType,
      localSequence: Ref.Ref<number>,
      requestCompletionMarker: boolean,
    ): Effect.Effect<Option.Option<OrchestrationShellStreamItem>> => {
      switch (frame.type) {
        case "session.snapshot":
          return Ref.modify(localSequence, (sequence) => {
            const remembered = rememberSnapshot(frame.snapshot).shell;
            const snapshotSequence = remembered.snapshotSequence;
            const acceptColdSequenceZero =
              !hasSeenSnapshot && sequence === 0 && snapshotSequence === 0;
            hasSeenSnapshot = true;
            if (!acceptColdSequenceZero && snapshotSequence <= sequence) {
              return [Option.none(), sequence];
            }
            shellSnapshot = remembered;
            return [
              Option.some({ kind: "snapshot" as const, snapshot: shellSnapshot }),
              snapshotSequence,
            ];
          });
        case "session.event": {
          const event = frame.published.event;
          // Relay live updates are committed orchestration events, not the
          // preprojected shell events that direct environments receive.
          if (
            frame.published.sessionId !== options.sessionId ||
            event.type !== "thread.session-set"
          ) {
            return Effect.succeed(Option.none());
          }
          return Ref.modify(localSequence, (sequence) => {
            if (event.sequence <= sequence || shellSnapshot === null) {
              return [Option.none(), sequence];
            }
            const thread = shellSnapshot.threads.find(
              (candidate) => candidate.id === event.payload.threadId,
            );
            if (thread === undefined) return [Option.none(), sequence];

            const updatedThread = {
              ...thread,
              session: event.payload.session,
              latestTurn: latestTurnAfterSessionSet(thread.latestTurn, event.payload.session),
              updatedAt: event.occurredAt,
            };
            shellSnapshot = {
              ...shellSnapshot,
              snapshotSequence: event.sequence,
              threads: shellSnapshot.threads.map((candidate) =>
                candidate.id === updatedThread.id ? updatedThread : candidate,
              ),
              updatedAt: event.occurredAt,
            };
            rememberSessionSet(event);
            return [
              Option.some({
                kind: "thread-upserted" as const,
                sequence: event.sequence,
                thread: updatedThread,
              }),
              event.sequence,
            ];
          });
        }
        case "session.synchronized":
          return Effect.succeed(
            requestCompletionMarker
              ? Option.some({ kind: "synchronized" as const })
              : Option.none(),
          );
        default:
          return Effect.succeed(Option.none());
      }
    };
  };

  const makeProjectThreadFrame = (threadId: ThreadId) => {
    let threadSnapshot =
      latestKnownSnapshot !== null && isThreadSnapshot(latestKnownSnapshot, threadId)
        ? applySessionSetOverlay(latestKnownSnapshot).thread
        : null;
    let hasSeenSnapshot = latestKnownSnapshot !== null;

    return (
      frame: SessionFabricServerFrameType,
      localSequence: Ref.Ref<number>,
      requestCompletionMarker: boolean,
    ): Effect.Effect<Option.Option<OrchestrationThreadStreamItem>> => {
      switch (frame.type) {
        case "session.snapshot": {
          const remembered = rememberSnapshot(frame.snapshot);
          if (!isThreadSnapshot(remembered, threadId)) {
            return Effect.succeed(Option.none());
          }
          return Ref.modify(localSequence, (sequence) => {
            const snapshotSequence = remembered.thread.snapshotSequence;
            const acceptColdSequenceZero =
              !hasSeenSnapshot && sequence === 0 && snapshotSequence === 0;
            hasSeenSnapshot = true;
            if (!acceptColdSequenceZero && snapshotSequence <= sequence) {
              return [Option.none(), sequence];
            }
            threadSnapshot = remembered.thread;
            return [
              Option.some({ kind: "snapshot" as const, snapshot: threadSnapshot }),
              snapshotSequence,
            ];
          });
        }
        case "session.event":
          if (frame.published.sessionId !== options.sessionId) {
            return Effect.succeed(Option.none());
          }
          if (frame.published.event.type === "thread.session-set") {
            rememberSessionSet(frame.published.event);
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
            requestCompletionMarker
              ? Option.some({ kind: "synchronized" as const })
              : Option.none(),
          );
        default:
          return Effect.succeed(Option.none());
      }
    };
  };

  const dispatch: UiSessionSourceShape["dispatch"] = (command) => {
    if (socketUrl === null) {
      return Effect.fail(unavailable("The session fabric Relay URL is invalid."));
    }
    return Effect.scoped(
      Effect.gen(function* () {
        const dispatchAttempt = (
          forceRefresh: boolean,
        ): Effect.Effect<
          { readonly sequence: number },
          EnvironmentRpcUnavailableError | OrchestrationDispatchCommandError,
          Socket.WebSocketConstructor | Scope.Scope
        > =>
          Effect.gen(function* () {
            const receipt = yield* Deferred.make<SessionFabricCommandReceipt>();
            const closed = yield* Deferred.make<number>();
            const binding = yield* controllerBinding();
            const grant = yield* options.authorization.controller(binding, { forceRefresh }).pipe(
              Effect.mapError((error) =>
                error.reason === "permission"
                  ? new OrchestrationDispatchCommandError({
                      message: "This shared session is available as read-only.",
                    })
                  : unavailable(error.detail),
              ),
            );
            let closeCode = 1006;
            let opened = false;
            const socket = yield* Socket.makeWebSocket(socketUrl.toString(), {
              closeCodeIsError: (code) => {
                closeCode = code;
                if (code === 4401) options.authorization.invalidate("controller", binding);
                return true;
              },
              openTimeout: "10 seconds",
              protocols: [...sessionFabricWebSocketProtocols(grant)],
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
                    return frame.receipt.status === "accepted" ||
                      frame.receipt.status === "rejected"
                      ? Deferred.succeed(receipt, frame.receipt).pipe(Effect.asVoid)
                      : Effect.void;
                  }),
                  Effect.catch(() => Effect.void),
                ),
              {
                onOpen: Effect.gen(function* () {
                  opened = true;
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
            yield* Effect.forkScoped(
              run.pipe(
                Effect.catch((cause) =>
                  Effect.sync(() => {
                    closeCode = relayCloseCode(cause, closeCode);
                  }).pipe(Effect.andThen(Effect.fail(cause))),
                ),
                Effect.ensuring(
                  Effect.suspend(() => Deferred.succeed(closed, closeCode)).pipe(Effect.asVoid),
                ),
              ),
            );
            const completed = yield* Effect.raceFirst(
              Deferred.await(receipt),
              Deferred.await(closed).pipe(Effect.flatMap((code) => Effect.fail(code))),
            ).pipe(
              Effect.timeout(options.dispatchTimeout ?? "30 seconds"),
              Effect.catch((cause) =>
                (cause === 4401 || (cause === 1006 && !opened)) && !forceRefresh
                  ? dispatchAttempt(true).pipe(
                      Effect.map((result) => ({
                        status: "accepted" as const,
                        resultSequence: result.sequence,
                        sessionId: options.sessionId,
                        commandId: command.commandId,
                        detail: null,
                        updatedAt: now(),
                      })),
                    )
                  : cause === 4403
                    ? Effect.fail(
                        new OrchestrationDispatchCommandError({
                          message: "This shared session is available as read-only.",
                        }),
                      )
                    : Effect.fail(unavailable("The session runner did not accept the command.")),
              ),
            );
            if (completed.status === "accepted") {
              return { sequence: completed.resultSequence };
            }
            return yield* new OrchestrationDispatchCommandError({
              message: completed.detail ?? "The session runner rejected this command.",
            });
          });

        return yield* dispatchAttempt(false);
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
        makeProject: makeProjectShellFrame,
      }),
    subscribeThread: (makeInput) =>
      Stream.unwrap(
        makeInput(CAPABILITIES).pipe(
          Effect.map((threadInput) =>
            subscribe({
              makeInput: Effect.succeed(threadInput),
              makeProject: () => makeProjectThreadFrame(threadInput.threadId),
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
