import {
  type RuntimeEventRawSource,
  RuntimeItemId,
  RuntimeTaskId,
  type CanonicalRequestType,
  type EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type RuntimeContentStreamKind,
  type RuntimeRequestId,
  type ThreadTokenUsageSnapshot,
  type ThreadId,
  type ToolLifecycleItemType,
  type TurnId,
} from "@t3tools/contracts";

import type { AcpPermissionRequest, AcpPlanUpdate, AcpToolCallState } from "./AcpRuntimeModel.ts";

type AcpAdapterRawSource = Extract<
  RuntimeEventRawSource,
  "acp.jsonrpc" | `acp.${string}.extension`
>;

interface AcpEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

type AcpCanonicalRequestType = Extract<
  CanonicalRequestType,
  "exec_command_approval" | "file_read_approval" | "file_change_approval" | "unknown"
>;

function canonicalRequestTypeFromAcpKind(kind: string | "unknown"): AcpCanonicalRequestType {
  switch (kind) {
    case "execute":
      return "exec_command_approval";
    case "read":
      return "file_read_approval";
    case "edit":
    case "delete":
    case "move":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function canonicalItemTypeFromAcpToolKind(kind: string | undefined): ToolLifecycleItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

function runtimeItemStatusFromAcpToolStatus(
  status: AcpToolCallState["status"],
): "inProgress" | "completed" | "failed" | undefined {
  switch (status) {
    case "pending":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

export function makeAcpRequestOpenedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly permissionRequest: AcpPermissionRequest;
  readonly detail: string;
  readonly args: unknown;
  readonly source: AcpAdapterRawSource;
  readonly method: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "request.opened",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: {
      requestType: canonicalRequestTypeFromAcpKind(input.permissionRequest.kind),
      detail: input.detail,
      args: input.args,
    },
    raw: {
      source: input.source,
      method: input.method,
      payload: input.rawPayload,
    },
  };
}

export function makeAcpRequestResolvedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly permissionRequest: AcpPermissionRequest;
  readonly decision: ProviderApprovalDecision;
}): ProviderRuntimeEvent {
  return {
    type: "request.resolved",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: {
      requestType: canonicalRequestTypeFromAcpKind(input.permissionRequest.kind),
      decision: input.decision,
    },
  };
}

export function makeAcpPlanUpdatedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly payload: AcpPlanUpdate;
  readonly source: AcpAdapterRawSource;
  readonly method: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "turn.plan.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    payload: input.payload,
    raw: {
      source: input.source,
      method: input.method,
      payload: input.rawPayload,
    },
  };
}

export function makeAcpToolCallEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly toolCall: AcpToolCallState;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  const runtimeStatus = runtimeItemStatusFromAcpToolStatus(input.toolCall.status);
  return {
    type:
      input.toolCall.status === "completed" || input.toolCall.status === "failed"
        ? "item.completed"
        : "item.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemId.make(input.toolCall.toolCallId),
    payload: {
      itemType: canonicalItemTypeFromAcpToolKind(input.toolCall.kind),
      ...(runtimeStatus ? { status: runtimeStatus } : {}),
      ...(input.toolCall.title ? { title: input.toolCall.title } : {}),
      ...(input.toolCall.detail ? { detail: input.toolCall.detail } : {}),
      ...(Object.keys(input.toolCall.data).length > 0 ? { data: input.toolCall.data } : {}),
    },
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  };
}

interface AcpSubagentSnapshot {
  readonly taskId: string;
  readonly description?: string;
  readonly status: "pending" | "running" | "completed" | "failed" | "aborted";
  readonly summary?: string;
  readonly usage?: unknown;
  readonly lastToolName?: string;
  readonly model?: string;
  readonly effort?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function subagentModelMetadata(value: unknown): {
  readonly model?: string;
  readonly effort?: string;
} {
  const resolvedModel = trimmedString(value);
  if (!resolvedModel) return {};
  const separator = resolvedModel.lastIndexOf(":");
  if (separator <= resolvedModel.indexOf("/")) {
    return { model: resolvedModel };
  }
  const model = resolvedModel.slice(0, separator).trim();
  const effort = resolvedModel.slice(separator + 1).trim();
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

function subagentSnapshotsFromUnknown(value: unknown): ReadonlyArray<AcpSubagentSnapshot> {
  if (!isRecord(value)) return [];
  const details = isRecord(value.details) ? value.details : value;
  const progress = Array.isArray(details.progress) ? details.progress : [];
  const results = Array.isArray(details.results) ? details.results : [];
  const jobs = Array.isArray(details.jobs) ? details.jobs : [];
  const snapshots = [...progress, ...results, ...jobs].flatMap(
    (entry): Array<AcpSubagentSnapshot> => {
      if (!isRecord(entry)) return [];
      const taskId = trimmedString(entry.id);
      if (!taskId) return [];
      const rawStatus = trimmedString(entry.status);
      const status =
        rawStatus === "pending" ||
        rawStatus === "running" ||
        rawStatus === "completed" ||
        rawStatus === "failed" ||
        rawStatus === "aborted"
          ? rawStatus
          : typeof entry.exitCode === "number"
            ? entry.exitCode === 0
              ? "completed"
              : "failed"
            : undefined;
      if (!status) return [];
      const metadata = subagentModelMetadata(entry.resolvedModel);
      const explicitEffort = trimmedString(entry.effort) ?? trimmedString(entry.thinkingLevel);
      const description =
        trimmedString(entry.description) ??
        trimmedString(entry.assignment) ??
        trimmedString(entry.task) ??
        trimmedString(entry.label);
      const recentOutput = Array.isArray(entry.recentOutput)
        ? entry.recentOutput
            .filter((part): part is string => typeof part === "string")
            .join("\n")
            .trim()
        : undefined;
      const summary = trimmedString(entry.output) ?? recentOutput;
      const lastToolName = trimmedString(entry.currentTool);
      return [
        {
          taskId,
          status,
          ...(description ? { description } : {}),
          ...(summary ? { summary } : {}),
          ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
          ...(lastToolName ? { lastToolName } : {}),
          ...metadata,
          ...(explicitEffort ? { effort: explicitEffort } : {}),
        },
      ];
    },
  );
  return Array.from(new Map(snapshots.map((snapshot) => [snapshot.taskId, snapshot])).values());
}

/** Extract OMP task/subagent snapshots carried in standard ACP tool-call raw output. */
export function extractAcpSubagentSnapshots(
  toolCall: AcpToolCallState,
): ReadonlyArray<AcpSubagentSnapshot> {
  return subagentSnapshotsFromUnknown(toolCall.data.rawOutput);
}

export function makeAcpSubagentTaskEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly snapshot: AcpSubagentSnapshot;
  readonly lifecycle: "started" | "progress" | "completed";
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  const common = {
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    raw: {
      source: "acp.jsonrpc" as const,
      method: "session/update",
      payload: input.rawPayload,
    },
  };
  const taskId = RuntimeTaskId.make(input.snapshot.taskId);
  if (input.lifecycle === "started") {
    return {
      type: "task.started",
      ...common,
      payload: {
        taskId,
        taskType: "subagent",
        ...(input.snapshot.description ? { description: input.snapshot.description } : {}),
        ...(input.snapshot.model ? { model: input.snapshot.model } : {}),
        ...(input.snapshot.effort ? { effort: input.snapshot.effort } : {}),
      },
    };
  }
  if (input.lifecycle === "progress") {
    return {
      type: "task.progress",
      ...common,
      payload: {
        taskId,
        description: input.snapshot.description ?? "Subagent working",
        ...(input.snapshot.summary ? { summary: input.snapshot.summary } : {}),
        ...(input.snapshot.usage !== undefined ? { usage: input.snapshot.usage } : {}),
        ...(input.snapshot.lastToolName ? { lastToolName: input.snapshot.lastToolName } : {}),
        ...(input.snapshot.model ? { model: input.snapshot.model } : {}),
        ...(input.snapshot.effort ? { effort: input.snapshot.effort } : {}),
      },
    };
  }
  return {
    type: "task.completed",
    ...common,
    payload: {
      taskId,
      status:
        input.snapshot.status === "completed"
          ? "completed"
          : input.snapshot.status === "aborted"
            ? "stopped"
            : "failed",
      ...(input.snapshot.summary ? { summary: input.snapshot.summary } : {}),
      ...(input.snapshot.usage !== undefined ? { usage: input.snapshot.usage } : {}),
      ...(input.snapshot.model ? { model: input.snapshot.model } : {}),
      ...(input.snapshot.effort ? { effort: input.snapshot.effort } : {}),
    },
  };
}

export function makeAcpAssistantItemEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly itemId: string;
  readonly itemType?: "assistant_message" | "reasoning";
  readonly lifecycle: "item.started" | "item.completed";
}): ProviderRuntimeEvent {
  return {
    type: input.lifecycle,
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemId.make(input.itemId),
    payload: {
      itemType: input.itemType ?? "assistant_message",
      status: input.lifecycle === "item.completed" ? "completed" : "inProgress",
    },
  };
}

export function makeAcpThreadMetadataUpdatedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly title: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "thread.metadata.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    payload: { name: input.title },
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  };
}

export function makeAcpContentDeltaEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly itemId?: string;
  readonly streamKind?: Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text">;
  readonly text: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    payload: {
      streamKind: input.streamKind ?? "assistant_text",
      delta: input.text,
    },
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  };
}

export function makeAcpTokenUsageUpdatedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly usage: ThreadTokenUsageSnapshot;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "thread.token-usage.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    payload: {
      usage: input.usage,
    },
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  };
}
