import {
  CommandId,
  MessageId,
  SessionFabricClientId,
  SessionFabricSessionId,
  ThreadId,
  type EnvironmentId,
  type SessionFabricContextBundle,
  type SessionFabricSearchResponse,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SessionFabricGateway from "./gateway.ts";

export const SESSION_FABRIC_MESSAGE_MAX_CHARS = 16_000;

export const SessionFabricReferenceFailureReason = Schema.Literals([
  "capability_denied",
  "self_reference",
  "message_empty",
  "message_too_long",
  "relay_unavailable",
  "dispatch_rejected",
]);
export type SessionFabricReferenceFailureReason = typeof SessionFabricReferenceFailureReason.Type;

export class SessionFabricReferenceToolError extends Schema.TaggedErrorClass<SessionFabricReferenceToolError>()(
  "SessionFabricReferenceToolError",
  {
    operation: Schema.Literals(["search", "context", "send"]),
    reason: SessionFabricReferenceFailureReason,
    sourceThreadId: ThreadId,
    sessionId: Schema.NullOr(SessionFabricSessionId),
    detail: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `Session fabric ${this.operation} failed: ${this.reason}.`;
  }
}

export interface SessionFabricMessageDispatchResult {
  readonly sessionId: SessionFabricSessionId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetThreadId: ThreadId;
  readonly resultSequence: number;
}

export interface SessionFabricReferenceAuthorityShape {
  readonly search: (
    scope: McpInvocationContext.McpInvocationScope,
    query: string,
    limit: number,
  ) => Effect.Effect<SessionFabricSearchResponse, SessionFabricReferenceToolError>;
  readonly context: (
    scope: McpInvocationContext.McpInvocationScope,
    sessionId: SessionFabricSessionId,
    includeCodeDiff: boolean,
    includeContinuation: boolean,
  ) => Effect.Effect<SessionFabricContextBundle, SessionFabricReferenceToolError>;
  readonly send: (
    scope: McpInvocationContext.McpInvocationScope,
    sessionId: SessionFabricSessionId,
    message: string,
  ) => Effect.Effect<SessionFabricMessageDispatchResult, SessionFabricReferenceToolError>;
}

export class SessionFabricReferenceAuthority extends Context.Service<
  SessionFabricReferenceAuthority,
  SessionFabricReferenceAuthorityShape
>()("t3/mcp/toolkits/session-fabric-references/authority/SessionFabricReferenceAuthority") {}

const makeError = (input: {
  readonly operation: "search" | "context" | "send";
  readonly reason: SessionFabricReferenceFailureReason;
  readonly sourceThreadId: ThreadId;
  readonly sessionId: SessionFabricSessionId | null;
  readonly detail?: string | null;
}) =>
  new SessionFabricReferenceToolError({
    ...input,
    detail: input.detail ?? null,
  });

export const make = Effect.gen(function* () {
  const gateway = yield* SessionFabricGateway.SessionFabricGateway;
  const crypto = yield* Crypto.Crypto;

  const gatewayError = (
    scope: McpInvocationContext.McpInvocationScope,
    operation: "search" | "context" | "send",
    sessionId: SessionFabricSessionId | null,
    cause: SessionFabricGateway.SessionFabricGatewayError,
  ) =>
    makeError({
      operation,
      reason: "relay_unavailable",
      sourceThreadId: scope.threadId,
      sessionId,
      detail: cause.detail,
    });

  const context: SessionFabricReferenceAuthorityShape["context"] = Effect.fn(
    "SessionFabricReferenceAuthority.context",
  )(function* (scope, sessionId, includeCodeDiff, includeContinuation) {
    const bundle = yield* gateway
      .context({ sessionId, includeCodeDiff, includeContinuation })
      .pipe(Effect.mapError((cause) => gatewayError(scope, "context", sessionId, cause)));
    if (
      bundle.session.sessionId !== sessionId ||
      bundle.snapshot.session.sessionId !== sessionId ||
      bundle.snapshot.session.location.environmentId !== bundle.session.location.environmentId ||
      bundle.snapshot.session.location.projectId !== bundle.session.location.projectId ||
      bundle.snapshot.session.location.threadId !== bundle.session.location.threadId ||
      bundle.snapshot.thread.thread.id !== bundle.session.location.threadId ||
      bundle.snapshot.thread.thread.projectId !== bundle.session.location.projectId
    ) {
      return yield* makeError({
        operation: "context",
        reason: "relay_unavailable",
        sourceThreadId: scope.threadId,
        sessionId,
        detail: "Session fabric returned context for a different session.",
      });
    }
    return bundle;
  });

  const search: SessionFabricReferenceAuthorityShape["search"] = Effect.fn(
    "SessionFabricReferenceAuthority.search",
  )(function* (scope, query, limit) {
    return yield* gateway
      .search({ query, limit })
      .pipe(Effect.mapError((cause) => gatewayError(scope, "search", null, cause)));
  });

  const send: SessionFabricReferenceAuthorityShape["send"] = Effect.fn(
    "SessionFabricReferenceAuthority.send",
  )(function* (scope, sessionId, message) {
    const trimmedMessage = message.trim();
    if (trimmedMessage.length === 0) {
      return yield* makeError({
        operation: "send",
        reason: "message_empty",
        sourceThreadId: scope.threadId,
        sessionId,
      });
    }
    if (message.length > SESSION_FABRIC_MESSAGE_MAX_CHARS) {
      return yield* makeError({
        operation: "send",
        reason: "message_too_long",
        sourceThreadId: scope.threadId,
        sessionId,
      });
    }

    const target = yield* context(scope, sessionId, false, false);
    if (
      target.session.location.environmentId === scope.environmentId &&
      target.session.location.threadId === scope.threadId
    ) {
      return yield* makeError({
        operation: "send",
        reason: "self_reference",
        sourceThreadId: scope.threadId,
        sessionId,
      });
    }
    const [commandUuid, messageUuid, createdAt] = yield* Effect.all([
      crypto.randomUUIDv4.pipe(Effect.orDie),
      crypto.randomUUIDv4.pipe(Effect.orDie),
      DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    ]);
    const clientId = SessionFabricClientId.make(
      `mcp:${scope.environmentId}:${scope.threadId}:${scope.providerSessionId}`,
    );
    const targetThread = target.snapshot.thread.thread;
    const command = {
      sessionId,
      commandId: CommandId.make(`mcp:session-fabric-message:${commandUuid}`),
      clientId,
      command: {
        type: "thread.turn.start" as const,
        commandId: CommandId.make(`mcp:session-fabric-message:${commandUuid}`),
        threadId: targetThread.id,
        message: {
          messageId: MessageId.make(`mcp:session-fabric-message:${messageUuid}`),
          role: "user" as const,
          text: `[Message from agent session ${scope.threadId} through session fabric]\n\n${message}`,
          attachments: [],
        },
        runtimeMode: targetThread.runtimeMode,
        interactionMode: targetThread.interactionMode,
        createdAt,
      },
      submittedAt: createdAt,
    };
    const receipt = yield* gateway
      .submit({ sessionId, clientId, command })
      .pipe(Effect.mapError((cause) => gatewayError(scope, "send", sessionId, cause)));
    if (receipt.sessionId !== sessionId) {
      return yield* makeError({
        operation: "send",
        reason: "dispatch_rejected",
        sourceThreadId: scope.threadId,
        sessionId,
        detail: "Session fabric returned a command receipt for a different session.",
      });
    }
    if (receipt.status !== "accepted") {
      return yield* makeError({
        operation: "send",
        reason: "dispatch_rejected",
        sourceThreadId: scope.threadId,
        sessionId,
        detail: receipt.detail,
      });
    }
    return {
      sessionId,
      targetEnvironmentId: target.session.location.environmentId,
      targetThreadId: targetThread.id,
      resultSequence: receipt.resultSequence,
    };
  });

  return SessionFabricReferenceAuthority.of({ search, context, send });
});

export const layer = Layer.effect(SessionFabricReferenceAuthority, make).pipe(
  Layer.provide(SessionFabricGateway.layer),
);
