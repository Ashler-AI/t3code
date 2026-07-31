import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import type { NonEmptyReadonlyArray } from "effect/Array";
import * as PlatformError from "effect/PlatformError";
import * as Pull from "effect/Pull";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Stdio from "effect/Stdio";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import * as AcpSchema from "./_generated/schema.gen.ts";
import { CLIENT_METHODS } from "./_generated/meta.gen.ts";
import * as AcpError from "./errors.ts";
const isAcpError = Schema.is(AcpError.AcpError);
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

export interface AcpProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

export type AcpIncomingNotification =
  | {
      readonly _tag: "SessionUpdate";
      readonly method: typeof CLIENT_METHODS.session_update;
      readonly params: AcpSchema.SessionNotification;
    }
  | {
      readonly _tag: "ElicitationComplete";
      readonly method: typeof CLIENT_METHODS.session_elicitation_complete;
      readonly params: AcpSchema.ElicitationCompleteNotification;
    }
  | {
      readonly _tag: "ExtNotification";
      readonly method: string;
      readonly params: unknown;
    };

export interface AcpPatchedProtocolOptions {
  readonly stdio: Stdio.Stdio;
  readonly terminationError?: Effect.Effect<AcpError.AcpError>;
  readonly serverRequestMethods: ReadonlySet<string>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: AcpProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onNotification?: (
    notification: AcpIncomingNotification,
  ) => Effect.Effect<void, AcpError.AcpError, never>;
  readonly onExtRequest?: (
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown, AcpError.AcpError, never>;
  readonly onTermination?: (error: AcpError.AcpError) => Effect.Effect<void, never, never>;
}

export interface AcpPatchedProtocol {
  readonly clientProtocol: RpcClient.Protocol["Service"];
  readonly serverProtocol: RpcServer.Protocol["Service"];
  readonly incoming: Stream.Stream<AcpIncomingNotification>;
  readonly request: (method: string, payload: unknown) => Effect.Effect<unknown, AcpError.AcpError>;
  readonly notify: (method: string, payload: unknown) => Effect.Effect<void, AcpError.AcpError>;
  /** Registers a waiter that completes when the next matching request enters the outgoing queue. */
  readonly registerRequestEnqueue: (method: string) => Effect.Effect<AcpRequestEnqueueRegistration>;
  /** Waits until every previously enqueued outgoing message has been written to stdout. */
  readonly flush: Effect.Effect<void, AcpError.AcpError>;
}

export interface AcpRequestEnqueueRegistration {
  readonly awaitEnqueued: Effect.Effect<void, AcpError.AcpError>;
  readonly release: Effect.Effect<void>;
}

interface AcpPendingRequest {
  readonly deferred: Deferred.Deferred<unknown, AcpError.AcpError>;
  readonly method: string;
}

type AcpOutgoingMessage =
  | {
      readonly _tag: "Data";
      readonly data: string | Uint8Array;
    }
  | {
      readonly _tag: "Flush";
      readonly acknowledge: Deferred.Deferred<void, AcpError.AcpError>;
    };

const decodeSessionUpdate = Schema.decodeUnknownEffect(AcpSchema.SessionNotification);
const decodeElicitationComplete = Schema.decodeUnknownEffect(
  AcpSchema.ElicitationCompleteNotification,
);
const parserFactory = RpcSerialization.ndJsonRpc();

export const makeAcpPatchedProtocol = Effect.fn("makeAcpPatchedProtocol")(function* (
  options: AcpPatchedProtocolOptions,
): Effect.fn.Return<AcpPatchedProtocol, never, Scope.Scope> {
  const parser = parserFactory.makeUnsafe();
  const serverQueue = yield* Queue.unbounded<RpcMessage.FromClientEncoded>();
  const clientQueue = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
  const notificationQueue = yield* Queue.unbounded<AcpIncomingNotification>();
  const disconnects = yield* Queue.unbounded<number>();
  const outgoing = yield* Queue.unbounded<AcpOutgoingMessage, Cause.Done<void>>();
  const nextRequestId = yield* Ref.make(1);
  const terminationHandled = yield* Ref.make(false);
  const extPending = yield* Ref.make(new Map<string, AcpPendingRequest>());
  const outgoingFailure = yield* Ref.make<AcpError.AcpError | undefined>(undefined);
  const pendingFlushes = yield* Ref.make(new Set<Deferred.Deferred<void, AcpError.AcpError>>());
  const requestEnqueueWaiters = yield* Ref.make(
    new Map<string, ReadonlyArray<Deferred.Deferred<void, AcpError.AcpError>>>(),
  );

  const removeRequestEnqueueWaiter = (
    method: string,
    deferred: Deferred.Deferred<void, AcpError.AcpError>,
  ) =>
    Ref.update(requestEnqueueWaiters, (current) => {
      const waiters = current.get(method);
      if (!waiters?.includes(deferred)) {
        return current;
      }
      const remaining = waiters.filter((waiter) => waiter !== deferred);
      const next = new Map(current);
      if (remaining.length === 0) {
        next.delete(method);
      } else {
        next.set(method, remaining);
      }
      return next;
    });

  const resolveNextRequestEnqueueWaiter = (
    method: string,
    resolve: (deferred: Deferred.Deferred<void, AcpError.AcpError>) => Effect.Effect<boolean>,
  ) =>
    Ref.modify(requestEnqueueWaiters, (current) => {
      const waiters = current.get(method);
      const deferred = waiters?.[0];
      if (!deferred) {
        return [Effect.void, current] as const;
      }
      const next = new Map(current);
      if (waiters.length === 1) {
        next.delete(method);
      } else {
        next.set(method, waiters.slice(1));
      }
      return [resolve(deferred).pipe(Effect.asVoid), next] as const;
    }).pipe(Effect.flatten);

  const signalRequestEnqueued = (method: string) =>
    resolveNextRequestEnqueueWaiter(method, (deferred) => Deferred.succeed(deferred, undefined));

  const failNextRequestEnqueueWaiter = (method: string, error: AcpError.AcpError) =>
    resolveNextRequestEnqueueWaiter(method, (deferred) => Deferred.fail(deferred, error));

  const failAllRequestEnqueueWaiters = (error: AcpError.AcpError) =>
    Ref.getAndSet(requestEnqueueWaiters, new Map()).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach([...pending.values()].flat(), (deferred) => Deferred.fail(deferred, error), {
          discard: true,
        }),
      ),
    );

  const logProtocol = (event: AcpProtocolLogEvent) => {
    if (event.direction === "incoming" && !options.logIncoming) {
      return Effect.void;
    }
    if (event.direction === "outgoing" && !options.logOutgoing) {
      return Effect.void;
    }
    return (
      options.logger?.(event) ??
      Effect.logDebug("ACP protocol event").pipe(Effect.annotateLogs({ event }))
    );
  };

  const offerOutgoing = Effect.fn("offerOutgoing")(function* (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ) {
    const method = message._tag === "Request" ? message.tag : undefined;
    return yield* Effect.gen(function* () {
      yield* logProtocol({
        direction: "outgoing",
        stage: "decoded",
        payload: message,
      });

      const encodedRequestId =
        message._tag === "Request"
          ? message.id
          : "requestId" in message
            ? message.requestId
            : undefined;
      const requestId = encodedRequestId === "" ? undefined : encodedRequestId;
      const encoded = yield* Effect.try({
        try: () => parser.encode(message),
        catch: (cause) =>
          AcpError.AcpProtocolParseError.fromEncodingError(method, requestId, cause),
      });

      if (encoded) {
        yield* logProtocol({
          direction: "outgoing",
          stage: "raw",
          payload: typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded),
        });

        const enqueued = yield* Queue.offer(outgoing, { _tag: "Data", data: encoded });
        if (!enqueued) {
          return yield* new AcpError.AcpTransportError({
            detail: "ACP outgoing transport is no longer accepting messages.",
            cause: undefined,
          });
        }
        if (method !== undefined) {
          yield* signalRequestEnqueued(method);
        }
      }
    }).pipe(
      Effect.tapError((error) =>
        method === undefined ? Effect.void : failNextRequestEnqueueWaiter(method, error),
      ),
    );
  });

  const offerOutgoingNotification = Effect.fn("offerOutgoingNotification")(function* (
    method: string,
    payload: unknown,
  ) {
    const notification = {
      jsonrpc: "2.0" as const,
      method,
      params: payload,
    };
    yield* logProtocol({
      direction: "outgoing",
      stage: "decoded",
      payload: notification,
    });

    const encoded = yield* Effect.try({
      try: () => `${encodeUnknownJsonString(notification)}\n`,
      catch: (cause) => AcpError.AcpProtocolParseError.fromEncodingError(method, undefined, cause),
    });
    yield* logProtocol({
      direction: "outgoing",
      stage: "raw",
      payload: encoded,
    });

    const enqueued = yield* Queue.offer(outgoing, { _tag: "Data", data: encoded });
    if (!enqueued) {
      return yield* new AcpError.AcpTransportError({
        detail: "ACP outgoing transport is no longer accepting messages.",
        cause: undefined,
      });
    }
  });

  const resolveExtPending = (
    requestId: AcpError.AcpRequestId,
    onFound: (pendingRequest: AcpPendingRequest) => Effect.Effect<void>,
  ) =>
    Ref.modify(extPending, (pending) => {
      const pendingKey = String(requestId);
      const pendingRequest = pending.get(pendingKey);
      if (!pendingRequest) {
        return [Effect.void, pending] as const;
      }
      const next = new Map(pending);
      next.delete(pendingKey);
      return [onFound(pendingRequest), next] as const;
    }).pipe(Effect.flatten);

  const removeExtPending = (requestId: AcpError.AcpRequestId) =>
    Ref.update(extPending, (pending) => {
      const pendingKey = String(requestId);
      if (!pending.has(pendingKey)) {
        return pending;
      }
      const next = new Map(pending);
      next.delete(pendingKey);
      return next;
    });

  const completeExtPendingFailure = (requestId: AcpError.AcpRequestId, error: AcpError.AcpError) =>
    resolveExtPending(requestId, ({ deferred }) => Deferred.fail(deferred, error));

  const completeExtPendingSuccess = (requestId: AcpError.AcpRequestId, value: unknown) =>
    resolveExtPending(requestId, ({ deferred }) => Deferred.succeed(deferred, value));

  const failAllExtPending = (error: AcpError.AcpError) =>
    Ref.getAndSet(extPending, new Map()).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach([...pending.values()], ({ deferred }) => Deferred.fail(deferred, error), {
          discard: true,
        }),
      ),
    );

  const failAllPendingFlushes = (error: AcpError.AcpError) =>
    Ref.getAndSet(pendingFlushes, new Set()).pipe(
      Effect.flatMap((flushes) =>
        Effect.forEach(flushes, (deferred) => Deferred.fail(deferred, error), {
          discard: true,
        }),
      ),
    );

  const dispatchNotification = (notification: AcpIncomingNotification) =>
    Queue.offer(notificationQueue, notification).pipe(
      Effect.andThen(
        options.onNotification
          ? options.onNotification(notification).pipe(Effect.catch(() => Effect.void))
          : Effect.void,
      ),
      Effect.asVoid,
    );

  const emitClientProtocolError = (error: AcpError.AcpError) =>
    Queue.offer(clientQueue, {
      _tag: "ClientProtocolError",
      error: new RpcClientError.RpcClientError({
        reason: new RpcClientError.RpcClientDefect({
          message: "ACP protocol terminated.",
          cause: error,
        }),
      }),
    }).pipe(Effect.asVoid);

  const handleTermination = (classify: () => Effect.Effect<AcpError.AcpError | undefined>) =>
    Ref.modify(terminationHandled, (handled) => {
      if (handled) {
        return [Effect.void, true] as const;
      }
      return [
        Effect.gen(function* () {
          yield* Queue.offer(disconnects, 0);
          const error = yield* classify();
          if (!error) {
            return;
          }
          yield* Ref.set(outgoingFailure, error);
          yield* failAllExtPending(error);
          yield* failAllPendingFlushes(error);
          yield* failAllRequestEnqueueWaiters(error);
          yield* emitClientProtocolError(error);
          if (options.onTermination) {
            yield* options.onTermination(error);
          }
        }),
        true,
      ] as const;
    }).pipe(Effect.flatten);

  const respondWithSuccess = (requestId: AcpError.AcpRequestId, value: unknown) =>
    offerOutgoing({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Success",
        value,
      },
    });

  const respondWithError = (requestId: AcpError.AcpRequestId, error: AcpError.AcpRequestError) =>
    offerOutgoing({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: error.toProtocolError(),
          },
        ],
      },
    });

  const handleExtRequest = (message: RpcMessage.RequestEncoded) => {
    if (!options.onExtRequest) {
      return respondWithError(message.id, AcpError.AcpRequestError.methodNotFound(message.tag));
    }
    return options.onExtRequest(message.tag, message.payload).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          respondWithError(
            message.id,
            AcpError.AcpRequestError.fromExtensionHandlerError(error, message.tag),
          ),
        onSuccess: (value) => respondWithSuccess(message.id, value),
      }),
    );
  };

  const handleRequestEncoded = (message: RpcMessage.RequestEncoded) => {
    if (message.id === "") {
      if (message.tag === CLIENT_METHODS.session_update) {
        return decodeSessionUpdate(message.payload).pipe(
          Effect.map(
            (params) =>
              ({
                _tag: "SessionUpdate",
                method: CLIENT_METHODS.session_update,
                params,
              }) satisfies AcpIncomingNotification,
          ),
          Effect.mapError((cause) =>
            AcpError.AcpProtocolParseError.fromSchemaError(
              "decode-notification-payload",
              CLIENT_METHODS.session_update,
              cause,
            ),
          ),
          Effect.flatMap(dispatchNotification),
        );
      }
      if (message.tag === CLIENT_METHODS.session_elicitation_complete) {
        return decodeElicitationComplete(message.payload).pipe(
          Effect.map(
            (params) =>
              ({
                _tag: "ElicitationComplete",
                method: CLIENT_METHODS.session_elicitation_complete,
                params,
              }) satisfies AcpIncomingNotification,
          ),
          Effect.mapError((cause) =>
            AcpError.AcpProtocolParseError.fromSchemaError(
              "decode-notification-payload",
              CLIENT_METHODS.session_elicitation_complete,
              cause,
            ),
          ),
          Effect.flatMap(dispatchNotification),
        );
      }
      return dispatchNotification({
        _tag: "ExtNotification",
        method: message.tag,
        params: message.payload,
      });
    }

    if (!options.serverRequestMethods.has(message.tag)) {
      return handleExtRequest(message).pipe(
        Effect.catchTags({
          AcpProtocolParseError: (error) =>
            Effect.logWarning(error).pipe(
              Effect.annotateLogs({
                method: message.tag,
                requestId: message.id,
                operation: error.operation,
              }),
              Effect.andThen(
                respondWithError(
                  message.id,
                  AcpError.AcpRequestError.fromExtensionResponseEncodingError(
                    message.tag,
                    message.id,
                    error,
                  ),
                ),
              ),
            ),
        }),
        Effect.asVoid,
      );
    }

    return Queue.offer(serverQueue, message).pipe(Effect.asVoid);
  };

  const handleExitEncoded = (message: RpcMessage.ResponseExitEncoded) =>
    Ref.get(extPending).pipe(
      Effect.flatMap((pending) => {
        const pendingRequest = pending.get(String(message.requestId));
        if (!pendingRequest) {
          return Queue.offer(clientQueue, message).pipe(Effect.asVoid);
        }
        if (message.exit._tag === "Success") {
          return completeExtPendingSuccess(message.requestId, message.exit.value);
        }
        const failure = message.exit.cause.find((entry) => entry._tag === "Fail");
        if (failure && isProtocolError(failure.error)) {
          return completeExtPendingFailure(
            message.requestId,
            AcpError.AcpRequestError.fromProtocolError(failure.error, {
              method: pendingRequest.method,
              requestId: message.requestId,
              cause: message.exit.cause,
            }),
          );
        }
        return completeExtPendingFailure(
          message.requestId,
          AcpError.AcpRequestError.fromExtensionResponseFailure(
            pendingRequest.method,
            message.requestId,
            message.exit.cause,
          ),
        );
      }),
    );

  const routeDecodedMessage = (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ): Effect.Effect<void, AcpError.AcpError> => {
    message = normalizeStandardJsonRpcError(message);
    switch (message._tag) {
      case "Request":
        return handleRequestEncoded(message);
      case "Exit":
        return handleExitEncoded(message);
      case "Chunk":
        return Ref.get(extPending).pipe(
          Effect.flatMap((pending) => {
            const pendingRequest = pending.get(String(message.requestId));
            return pendingRequest
              ? completeExtPendingFailure(
                  message.requestId,
                  AcpError.AcpRequestError.unsupportedStreamingResponse(
                    pendingRequest.method,
                    message.requestId,
                  ),
                )
              : Queue.offer(clientQueue, message).pipe(Effect.asVoid);
          }),
        );
      case "Defect":
      case "ClientProtocolError":
      case "Pong":
        return Queue.offer(clientQueue, message).pipe(Effect.asVoid);
      case "Ack":
      case "Interrupt":
      case "Ping":
      case "Eof":
        return Queue.offer(serverQueue, message).pipe(Effect.asVoid);
    }
  };

  yield* options.stdio.stdin.pipe(
    Stream.runForEach((data) =>
      logProtocol({
        direction: "incoming",
        stage: "raw",
        payload: typeof data === "string" ? data : new TextDecoder().decode(data),
      }).pipe(
        Effect.flatMap(() =>
          Effect.try({
            try: () =>
              parser.decode(data) as ReadonlyArray<
                RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded
              >,
            catch: (cause) =>
              new AcpError.AcpProtocolParseError({
                operation: "decode-wire-message",
                cause,
              }),
          }),
        ),
        Effect.tap((messages) =>
          logProtocol({
            direction: "incoming",
            stage: "decoded",
            payload: messages,
          }),
        ),
        Effect.tapErrorTag("AcpProtocolParseError", (error) =>
          logProtocol({
            direction: "incoming",
            stage: "decode_failed",
            payload: {
              operation: error.operation,
              ...(error.method === undefined ? {} : { method: error.method }),
              ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
              ...(error.issueCount === undefined ? {} : { issueCount: error.issueCount }),
              ...(error.issueKinds === undefined ? {} : { issueKinds: error.issueKinds }),
              ...(error.maximumPathDepth === undefined
                ? {}
                : { maximumPathDepth: error.maximumPathDepth }),
            },
          }),
        ),
        Effect.flatMap((messages) =>
          Effect.forEach(messages, routeDecodedMessage, {
            discard: true,
          }),
        ),
      ),
    ),
    Effect.matchEffect({
      onFailure: (error) => {
        const normalized: AcpError.AcpError = isAcpError(error)
          ? error
          : new AcpError.AcpTransportError({
              operation: "read-input-stream",
              cause: error,
            });
        return handleTermination(() => Effect.succeed(normalized));
      },
      onSuccess: () =>
        handleTermination(
          () =>
            options.terminationError ?? Effect.succeed(new AcpError.AcpInputStreamEndedError({})),
        ),
    }),
    Effect.forkScoped,
  );

  const outgoingWriter = Sink.fromTransform<
    AcpOutgoingMessage,
    void,
    PlatformError.PlatformError,
    never
  >((upstream, scope) => {
    const pullData: Pull.Pull<
      NonEmptyReadonlyArray<string | Uint8Array>,
      never,
      void
    > = Effect.suspend(() =>
      Effect.flatMap(upstream, ([message]) => {
        if (message._tag === "Flush") {
          // The stdout sink requests its next element only after it has consumed the
          // previous one. A one-element stream chunk therefore makes this a real
          // write barrier without ending the long-lived child-process stdin sink.
          return Deferred.succeed(message.acknowledge, undefined).pipe(
            Effect.asVoid,
            Effect.andThen(pullData),
          );
        }
        return Effect.succeed([message.data] as NonEmptyReadonlyArray<string | Uint8Array>);
      }),
    );
    return options.stdio.stdout().transform(pullData, scope);
  });

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.rechunk(1),
    Stream.run(outgoingWriter),
    Effect.catchCause((cause) =>
      handleTermination(() =>
        Effect.succeed(
          new AcpError.AcpTransportError({
            detail: "Failed to write an ACP protocol message.",
            cause: new Error("ACP protocol stdout writer failed.", {
              cause: Cause.squash(cause),
            }),
          }),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  const clientProtocol = RpcClient.Protocol.of({
    run: (_clientId, f) =>
      Stream.fromQueue(clientQueue).pipe(
        Stream.runForEach((message) => f(message)),
        Effect.forever,
      ),
    send: (_clientId, request) =>
      offerOutgoing(request).pipe(
        Effect.mapError(
          (error) =>
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "Failed to send ACP protocol message.",
                cause: error,
              }),
            }),
        ),
      ),
    supportsAck: true,
    supportsTransferables: false,
  });

  const serverProtocol = RpcServer.Protocol.of({
    run: (f) =>
      Stream.fromQueue(serverQueue).pipe(
        Stream.runForEach((message) => f(0, message)),
        Effect.forever,
      ),
    disconnects,
    send: (_clientId, response) => offerOutgoing(response).pipe(Effect.orDie),
    end: (_clientId) => Queue.end(outgoing),
    clientIds: Effect.succeed(new Set([0])),
    initialMessage: Effect.succeedNone,
    supportsAck: true,
    supportsTransferables: false,
    supportsSpanPropagation: true,
  });

  const sendNotification = Effect.fn("sendNotification")(function* (
    method: string,
    payload: unknown,
  ) {
    yield* offerOutgoingNotification(method, payload);
  });

  const flush = Effect.gen(function* () {
    const acknowledge = yield* Deferred.make<void, AcpError.AcpError>();
    yield* Ref.update(pendingFlushes, (current) => new Set(current).add(acknowledge));
    return yield* Effect.gen(function* () {
      const failure = yield* Ref.get(outgoingFailure);
      if (failure) {
        return yield* failure;
      }
      const enqueued = yield* Queue.offer(outgoing, { _tag: "Flush", acknowledge });
      if (!enqueued) {
        return yield* new AcpError.AcpTransportError({
          detail: "ACP outgoing transport closed before it could be flushed.",
          cause: undefined,
        });
      }
      return yield* Deferred.await(acknowledge);
    }).pipe(
      Effect.ensuring(
        Ref.update(pendingFlushes, (current) => {
          const next = new Set(current);
          next.delete(acknowledge);
          return next;
        }),
      ),
    );
  });

  const sendRequest = Effect.fn("sendRequest")(function* (method: string, payload: unknown) {
    const requestId = yield* Ref.modify(
      nextRequestId,
      (current) => [current, current + 1] as const,
    );
    const deferred = yield* Deferred.make<unknown, AcpError.AcpError>();
    yield* Ref.update(extPending, (pending) =>
      new Map(pending).set(String(requestId), { deferred, method }),
    );
    yield* offerOutgoing({
      _tag: "Request",
      id: requestId,
      tag: method,
      payload,
      headers: [],
    }).pipe(Effect.tapError(() => removeExtPending(requestId)));
    return yield* Deferred.await(deferred).pipe(
      Effect.onInterrupt(() => removeExtPending(requestId)),
    );
  });

  const registerRequestEnqueue = Effect.fn("registerRequestEnqueue")(function* (method: string) {
    const deferred = yield* Deferred.make<void, AcpError.AcpError>();
    yield* Ref.update(requestEnqueueWaiters, (current) => {
      const next = new Map(current);
      next.set(method, [...(current.get(method) ?? []), deferred]);
      return next;
    });
    const failure = yield* Ref.get(outgoingFailure);
    if (failure) {
      yield* removeRequestEnqueueWaiter(method, deferred);
      yield* Deferred.fail(deferred, failure);
    }
    return {
      awaitEnqueued: Deferred.await(deferred),
      release: removeRequestEnqueueWaiter(method, deferred),
    } satisfies AcpRequestEnqueueRegistration;
  });

  return {
    clientProtocol,
    serverProtocol,
    get incoming() {
      return Stream.fromQueue(notificationQueue);
    },
    request: sendRequest,
    notify: sendNotification,
    registerRequestEnqueue,
    flush,
  } satisfies AcpPatchedProtocol;
});

function isProtocolError(
  value: unknown,
): value is { code: number; message: string; data?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "number" &&
    "message" in value &&
    typeof value.message === "string"
  );
}

/**
 * Effect's JSON-RPC serializer reserves `error._tag = "Cause"` for typed
 * failures. ACP agents use standard JSON-RPC errors instead, so the serializer
 * initially represents those as defects. Recover the declared ACP error channel
 * before RpcClient decodes the defect and drops `code` / `data`.
 */
function normalizeStandardJsonRpcError(
  message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
): RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded {
  if (message._tag !== "Exit" || message.exit._tag !== "Failure") return message;

  let changed = false;
  const cause = message.exit.cause.map((reason) => {
    if (reason._tag !== "Die" || !isProtocolError(reason.defect)) return reason;
    changed = true;
    return {
      _tag: "Fail" as const,
      error: reason.defect,
    };
  });

  return changed
    ? {
        ...message,
        exit: {
          _tag: "Failure",
          cause,
        },
      }
    : message;
}
