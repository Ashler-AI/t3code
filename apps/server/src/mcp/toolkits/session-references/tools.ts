import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SessionReferenceAuthority from "./authority.ts";

export const SessionReferenceResolveInput = Schema.Struct({
  threadId: ThreadId,
});

export const SessionReferenceResolveResult = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  rootPath: Schema.String,
  branch: Schema.NullOr(Schema.String),
});

export const SessionMessageSendInput = Schema.Struct({
  threadId: ThreadId,
  message: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(SessionReferenceAuthority.SESSION_MESSAGE_MAX_CHARS),
  ),
});

export const SessionMessageSendResult = Schema.Struct({
  environmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  SessionReferenceAuthority.SessionReferenceAuthority,
];

export const SessionReferenceResolveTool = Tool.make("session_reference_resolve", {
  description:
    "Resolve another active OMP session in this T3 environment. Returns its authoritative project/worktree root and metadata. The path is read from T3's projection; token path hints are never accepted.",
  parameters: SessionReferenceResolveInput,
  success: SessionReferenceResolveResult,
  failure: SessionReferenceAuthority.SessionReferenceToolError,
  dependencies,
})
  .annotate(Tool.Title, "Resolve agent session")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const SessionMessageSendTool = Tool.make("session_message_send", {
  description:
    "Send a bounded message to another active OMP session in this T3 environment. T3 records the source session in the projected user message text before starting the target turn.",
  parameters: SessionMessageSendInput,
  success: SessionMessageSendResult,
  failure: SessionReferenceAuthority.SessionReferenceToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message agent session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const SessionReferenceToolkit = Toolkit.make(
  SessionReferenceResolveTool,
  SessionMessageSendTool,
);
