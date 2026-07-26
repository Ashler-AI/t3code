import {
  EnvironmentId,
  SessionFabricContextBundle,
  SessionFabricContextRequest,
  SessionFabricSearchRequest,
  SessionFabricSearchResponse,
  SessionFabricSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SessionFabricReferenceAuthority from "./authority.ts";

export const SessionFabricSearchInput = SessionFabricSearchRequest;
export const SessionFabricContextInput = SessionFabricContextRequest;
export const SessionFabricMessageSendInput = Schema.Struct({
  sessionId: SessionFabricSessionId,
  message: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(SessionFabricReferenceAuthority.SESSION_FABRIC_MESSAGE_MAX_CHARS),
  ),
});
export const SessionFabricMessageSendResult = Schema.Struct({
  sessionId: SessionFabricSessionId,
  targetEnvironmentId: EnvironmentId,
  targetThreadId: ThreadId,
  resultSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  SessionFabricReferenceAuthority.SessionFabricReferenceAuthority,
];

export const SessionFabricSearchTool = Tool.make("session_fabric_search", {
  description:
    "Semantically search public T3 sessions across local machines and Scaffold sandboxes. Results are identified by global fabric sessionId, not by a local T3 thread id.",
  parameters: SessionFabricSearchInput,
  success: SessionFabricSearchResponse,
  failure: SessionFabricReferenceAuthority.SessionFabricReferenceToolError,
  dependencies,
})
  .annotate(Tool.Title, "Search shared agent sessions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const SessionFabricContextTool = Tool.make("session_fabric_context", {
  description:
    "Load the authoritative transcript snapshot and optional code diff/opaque continuation for a global fabric sessionId. This does not resolve a local worktree path.",
  parameters: SessionFabricContextInput,
  success: SessionFabricContextBundle,
  failure: SessionFabricReferenceAuthority.SessionFabricReferenceToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read shared session context")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const SessionFabricMessageSendTool = Tool.make("session_fabric_message_send", {
  description:
    "Send a bounded message that executes as a new user turn on the remote local or Scaffold runner that owns a global fabric sessionId. The command remains queued by the fabric until that runner accepts it and may cause the remote agent to run tools or modify its environment.",
  parameters: SessionFabricMessageSendInput,
  success: SessionFabricMessageSendResult,
  failure: SessionFabricReferenceAuthority.SessionFabricReferenceToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message shared agent session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

export const SessionFabricReferenceToolkit = Toolkit.make(
  SessionFabricSearchTool,
  SessionFabricContextTool,
  SessionFabricMessageSendTool,
);
