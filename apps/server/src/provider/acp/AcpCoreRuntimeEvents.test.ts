import { ProviderDriverKind, RuntimeRequestId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  extractAcpSubagentSnapshots,
  makeAcpSubagentTaskEvent,
  makeAcpTokenUsageUpdatedEvent,
  makeAcpThreadMetadataUpdatedEvent,
  makeAcpToolCallEvent,
} from "./AcpCoreRuntimeEvents.ts";

describe("AcpCoreRuntimeEvents", () => {
  it("maps ACP permission requests to canonical runtime events", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");
    const permissionRequest = {
      kind: "execute" as const,
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending" as const,
        command: "cat package.json",
        detail: "cat package.json",
        data: { toolCallId: "tool-1", kind: "execute" },
      },
    };

    expect(
      makeAcpRequestOpenedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.make("request-1"),
        permissionRequest,
        detail: "cat package.json",
        args: { command: ["cat", "package.json"] },
        source: "acp.jsonrpc",
        method: "session/request_permission",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "request.opened",
      payload: {
        requestType: "exec_command_approval",
        detail: "cat package.json",
      },
    });

    expect(
      makeAcpRequestResolvedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.make("request-1"),
        permissionRequest,
        decision: "accept",
      }),
    ).toMatchObject({
      type: "request.resolved",
      payload: {
        requestType: "exec_command_approval",
        decision: "accept",
      },
    });
  });

  it("maps ACP core plan, tool-call, and content updates", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");

    expect(
      makeAcpPlanUpdatedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        payload: {
          plan: [{ step: "Inspect state", status: "inProgress" }],
        },
        source: "acp.cursor.extension",
        method: "cursor/update_todos",
        rawPayload: { todos: [] },
      }),
    ).toMatchObject({
      type: "turn.plan.updated",
      raw: {
        method: "cursor/update_todos",
      },
    });

    expect(
      makeAcpToolCallEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          status: "completed",
          title: "Terminal",
          detail: "bun run test",
          data: { command: "bun run test" },
        },
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
      },
    });

    expect(
      makeAcpContentDeltaEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        streamKind: "reasoning_text",
        text: "hello",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "content.delta",
      itemId: "assistant:session-1:segment:0",
      payload: {
        streamKind: "reasoning_text",
        delta: "hello",
      },
    });

    expect(
      makeAcpAssistantItemEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        lifecycle: "item.started",
      }),
    ).toMatchObject({
      type: "item.started",
      itemId: "assistant:session-1:segment:0",
      payload: {
        itemType: "assistant_message",
        status: "inProgress",
      },
    });
  });

  it("maps ACP usage updates to canonical thread token usage events", () => {
    const event = makeAcpTokenUsageUpdatedEvent({
      stamp: { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" },
      provider: ProviderDriverKind.make("omp"),
      threadId: "thread-1" as never,
      turnId: TurnId.make("turn-1"),
      usage: {
        usedTokens: 31_251,
        maxTokens: 200_000,
      },
      rawPayload: {
        sessionId: "session-1",
        update: { sessionUpdate: "usage_update", used: 31_251, size: 200_000 },
      },
    });

    expect(event).toMatchObject({
      type: "thread.token-usage.updated",
      provider: "omp",
      payload: {
        usage: {
          usedTokens: 31_251,
          maxTokens: 200_000,
        },
      },
      raw: {
        source: "acp.jsonrpc",
        method: "session/update",
      },
    });
  });

  it("maps ACP session titles to canonical thread metadata", () => {
    const event = makeAcpThreadMetadataUpdatedEvent({
      stamp: { eventId: "event-2" as never, createdAt: "2026-07-24T19:00:00.000Z" },
      provider: ProviderDriverKind.make("omp"),
      threadId: "thread-1" as never,
      turnId: undefined,
      title: "Inspect ACP state",
      rawPayload: { sessionId: "session-1" },
    });

    expect(event).toMatchObject({
      type: "thread.metadata.updated",
      payload: { name: "Inspect ACP state" },
      raw: { source: "acp.jsonrpc", method: "session/update" },
    });
  });

  it("maps nested OMP task progress to canonical subagent events with model and effort", () => {
    const toolCall = {
      toolCallId: "task-tool-1",
      status: "inProgress" as const,
      data: {
        rawOutput: {
          details: {
            progress: [
              {
                id: "agent-parent.child",
                status: "running",
                description: "Inspect nested state",
                currentTool: "read",
                resolvedModel: "anthropic/claude-sonnet-5:high",
                recentOutput: ["Found the nested session"],
                usage: { input: 12, output: 4 },
              },
            ],
          },
        },
      },
    };
    const [snapshot] = extractAcpSubagentSnapshots(toolCall);
    expect(snapshot).toMatchObject({
      taskId: "agent-parent.child",
      status: "running",
      model: "anthropic/claude-sonnet-5",
      effort: "high",
      lastToolName: "read",
    });
    if (!snapshot) throw new Error("expected subagent snapshot");

    const common = {
      provider: ProviderDriverKind.make("omp"),
      threadId: "thread-1" as never,
      turnId: TurnId.make("turn-1"),
      snapshot,
      rawPayload: { sessionId: "session-1" },
    };
    expect(
      makeAcpSubagentTaskEvent({
        ...common,
        stamp: { eventId: "event-task-start" as never, createdAt: "2026-07-24T00:00:00Z" },
        lifecycle: "started",
      }),
    ).toMatchObject({
      type: "task.started",
      payload: {
        taskId: "agent-parent.child",
        taskType: "subagent",
        model: "anthropic/claude-sonnet-5",
        effort: "high",
      },
    });
    expect(
      makeAcpSubagentTaskEvent({
        ...common,
        stamp: { eventId: "event-task-progress" as never, createdAt: "2026-07-24T00:00:01Z" },
        lifecycle: "progress",
      }),
    ).toMatchObject({
      type: "task.progress",
      payload: {
        taskId: "agent-parent.child",
        description: "Inspect nested state",
        lastToolName: "read",
      },
    });
  });

  it("maps settled OMP subagents to canonical completion states", () => {
    const [snapshot] = extractAcpSubagentSnapshots({
      toolCallId: "task-tool-2",
      status: "completed",
      data: {
        rawOutput: {
          details: {
            results: [
              {
                id: "agent-2",
                exitCode: 1,
                output: "Provider exhausted",
              },
            ],
          },
        },
      },
    });
    if (!snapshot) throw new Error("expected completed subagent snapshot");
    expect(
      makeAcpSubagentTaskEvent({
        stamp: { eventId: "event-task-complete" as never, createdAt: "2026-07-24T00:00:02Z" },
        provider: ProviderDriverKind.make("omp"),
        threadId: "thread-1" as never,
        turnId: TurnId.make("turn-1"),
        snapshot,
        lifecycle: "completed",
        rawPayload: {},
      }),
    ).toMatchObject({
      type: "task.completed",
      payload: { taskId: "agent-2", status: "failed", summary: "Provider exhausted" },
    });
  });

  it("maps the live OMP hub jobs shape and carries late model metadata", () => {
    const [snapshot] = extractAcpSubagentSnapshots({
      toolCallId: "hub-tool-1",
      status: "completed",
      data: {
        rawOutput: {
          details: {
            jobs: [
              {
                id: "PackageNameScout",
                type: "task",
                status: "completed",
                label: "PackageNameScout",
                resolvedModel: "openai-codex/gpt-5.4-mini:low",
              },
            ],
          },
        },
      },
    });
    expect(snapshot).toMatchObject({
      taskId: "PackageNameScout",
      status: "completed",
      description: "PackageNameScout",
      model: "openai-codex/gpt-5.4-mini",
      effort: "low",
    });
    if (!snapshot) throw new Error("expected completed hub job snapshot");

    const common = {
      provider: ProviderDriverKind.make("omp"),
      threadId: "thread-1" as never,
      turnId: TurnId.make("turn-1"),
      snapshot,
      rawPayload: { sessionId: "session-1" },
    };
    expect(
      makeAcpSubagentTaskEvent({
        ...common,
        stamp: { eventId: "event-task-progress-model" as never, createdAt: "2026-07-24T00:00:03Z" },
        lifecycle: "progress",
      }),
    ).toMatchObject({
      type: "task.progress",
      payload: {
        taskId: "PackageNameScout",
        model: "openai-codex/gpt-5.4-mini",
        effort: "low",
      },
    });
    expect(
      makeAcpSubagentTaskEvent({
        ...common,
        stamp: { eventId: "event-task-complete-model" as never, createdAt: "2026-07-24T00:00:04Z" },
        lifecycle: "completed",
      }),
    ).toMatchObject({
      type: "task.completed",
      payload: {
        taskId: "PackageNameScout",
        model: "openai-codex/gpt-5.4-mini",
        effort: "low",
      },
    });
  });
});
