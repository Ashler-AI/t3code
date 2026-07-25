import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderInstanceRegistry from "../../../provider/Services/ProviderInstanceRegistry.ts";

export const SESSION_MESSAGE_MAX_CHARS = 16_000;

export const SessionReferenceFailureReason = Schema.Literals([
  "self_reference",
  "target_missing",
  "target_deleted",
  "target_archived",
  "target_project_missing",
  "target_project_deleted",
  "target_not_omp",
  "capability_denied",
  "message_empty",
  "message_too_long",
  "authority_unavailable",
  "dispatch_failed",
]);
export type SessionReferenceFailureReason = typeof SessionReferenceFailureReason.Type;

export class SessionReferenceToolError extends Schema.TaggedErrorClass<SessionReferenceToolError>()(
  "SessionReferenceToolError",
  {
    operation: Schema.Literals(["resolve", "send"]),
    reason: SessionReferenceFailureReason,
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
  },
) {
  override get message(): string {
    return `Session reference ${this.operation} failed: ${this.reason}.`;
  }
}

export interface SessionReferenceResolution {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly rootPath: string;
  readonly branch: string | null;
}

export interface SessionMessageDispatchResult {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly sequence: number;
}

export interface SessionReferenceAuthorityShape {
  readonly resolve: (
    scope: McpInvocationContext.McpInvocationScope,
    targetThreadId: ThreadId,
  ) => Effect.Effect<SessionReferenceResolution, SessionReferenceToolError>;
  readonly send: (
    scope: McpInvocationContext.McpInvocationScope,
    targetThreadId: ThreadId,
    message: string,
  ) => Effect.Effect<SessionMessageDispatchResult, SessionReferenceToolError>;
}

export class SessionReferenceAuthority extends Context.Service<
  SessionReferenceAuthority,
  SessionReferenceAuthorityShape
>()("t3/mcp/toolkits/session-references/authority/SessionReferenceAuthority") {}

const makeError = (input: {
  readonly operation: "resolve" | "send";
  readonly reason: SessionReferenceFailureReason;
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
}) => new SessionReferenceToolError(input);

const resolveTarget = Effect.fn("SessionReferenceAuthority.resolveTarget")(function* (input: {
  readonly operation: "resolve" | "send";
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly targetThreadId: ThreadId;
  readonly readModel: OrchestrationReadModel;
  readonly providerInstances: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
}) {
  const error = (reason: SessionReferenceFailureReason) =>
    makeError({
      operation: input.operation,
      reason,
      sourceThreadId: input.scope.threadId,
      targetThreadId: input.targetThreadId,
    });

  if (input.targetThreadId === input.scope.threadId) {
    return yield* error("self_reference");
  }
  const thread = input.readModel.threads.find(({ id }) => id === input.targetThreadId);
  if (!thread) return yield* error("target_missing");
  if (thread.deletedAt !== null) return yield* error("target_deleted");
  if (thread.archivedAt !== null) return yield* error("target_archived");

  const project = input.readModel.projects.find(({ id }) => id === thread.projectId);
  if (!project) return yield* error("target_project_missing");
  if (project.deletedAt !== null) return yield* error("target_project_deleted");

  const providerInstance = yield* input.providerInstances.getInstance(
    thread.modelSelection.instanceId,
  );
  if (providerInstance?.driverKind !== "omp") return yield* error("target_not_omp");

  return {
    thread,
    project,
    resolution: {
      environmentId: input.scope.environmentId,
      threadId: thread.id,
      projectId: project.id,
      title: thread.title,
      rootPath: thread.worktreePath ?? project.workspaceRoot,
      branch: thread.branch,
    } satisfies SessionReferenceResolution,
  };
});

const make = Effect.gen(function* () {
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  const resolve: SessionReferenceAuthorityShape["resolve"] = Effect.fn(
    "SessionReferenceAuthority.resolve",
  )(function* (scope, targetThreadId) {
    const readModel = yield* projection.getCommandReadModel().pipe(
      Effect.mapError(() =>
        makeError({
          operation: "resolve",
          reason: "authority_unavailable",
          sourceThreadId: scope.threadId,
          targetThreadId,
        }),
      ),
    );
    const target = yield* resolveTarget({
      operation: "resolve",
      scope,
      targetThreadId,
      readModel,
      providerInstances,
    });
    return target.resolution;
  });

  const send: SessionReferenceAuthorityShape["send"] = Effect.fn("SessionReferenceAuthority.send")(
    function* (scope, targetThreadId, message) {
      const trimmedMessage = message.trim();
      const inputError = (reason: SessionReferenceFailureReason) =>
        makeError({
          operation: "send",
          reason,
          sourceThreadId: scope.threadId,
          targetThreadId,
        });
      if (trimmedMessage.length === 0) return yield* inputError("message_empty");
      if (message.length > SESSION_MESSAGE_MAX_CHARS) return yield* inputError("message_too_long");

      const readModel = yield* projection
        .getCommandReadModel()
        .pipe(Effect.mapError(() => inputError("authority_unavailable")));
      const target = yield* resolveTarget({
        operation: "send",
        scope,
        targetThreadId,
        readModel,
        providerInstances,
      });
      const [commandUuid, messageUuid, createdAt] = yield* Effect.all([
        crypto.randomUUIDv4.pipe(Effect.orDie),
        crypto.randomUUIDv4.pipe(Effect.orDie),
        DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      ]);
      const provenance = `[Message from agent session ${scope.threadId}]`;
      const dispatched = yield* orchestration
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`mcp:session-message:${commandUuid}`),
          threadId: targetThreadId,
          message: {
            messageId: MessageId.make(`mcp:session-message:${messageUuid}`),
            role: "user",
            text: `${provenance}\n\n${message}`,
            attachments: [],
          },
          runtimeMode: target.thread.runtimeMode,
          interactionMode: target.thread.interactionMode,
          createdAt,
        })
        .pipe(Effect.mapError(() => inputError("dispatch_failed")));

      return {
        environmentId: scope.environmentId,
        sourceThreadId: scope.threadId,
        targetThreadId,
        sequence: dispatched.sequence,
      };
    },
  );

  return SessionReferenceAuthority.of({ resolve, send });
});

export const layer = Layer.effect(SessionReferenceAuthority, make);
