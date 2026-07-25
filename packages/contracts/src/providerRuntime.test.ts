import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderRuntimeEvent, ProviderRuntimeEventEnvelope } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const decodeRuntimeEventEnvelope = Schema.decodeUnknownSync(ProviderRuntimeEventEnvelope);

describe("ProviderRuntimeEvent", () => {
  it("decodes the canonical OMP ingestion identity and cursor envelope", () => {
    const parsed = decodeRuntimeEventEnvelope({
      protocolVersion: 1,
      eventId: "omp:session-1:7",
      environmentId: "environment-1",
      threadId: "thread-1",
      sourceSequence: 7,
      resumeCursor: {
        kind: "omp",
        schemaVersion: 3,
        sessionId: "session-1",
        eventSequence: 7,
        acpSequence: 5,
      },
      providerInstanceId: "omp",
      runtimeSessionId: "session-1",
      event: {
        type: "turn.completed",
        eventId: "omp:session-1:7",
        provider: "omp",
        providerInstanceId: "omp",
        createdAt: "2026-07-24T00:00:00.000Z",
        threadId: "thread-1",
        turnId: "turn-1",
        payload: { state: "completed" },
      },
    });

    expect(parsed.eventId).toBe(parsed.event.eventId);
    expect(parsed.environmentId).toBe("environment-1");
    expect(parsed.threadId).toBe(parsed.event.threadId);
    expect(parsed.sourceSequence).toBe(7);
    expect(parsed.resumeCursor).toEqual({
      kind: "omp",
      schemaVersion: 3,
      sessionId: "session-1",
      eventSequence: 7,
      acpSequence: 5,
    });
    expect(parsed.runtimeSessionId).toBe("session-1");
  });

  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeRuntimeEvent({
      type: "session.started",
      eventId: "event-ollama-session",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "started",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
  });

  it("decodes runtime-authoritative model and effort selections", () => {
    const turnStarted = decodeRuntimeEvent({
      type: "turn.started",
      eventId: "omp:session-1:8",
      provider: "omp",
      providerInstanceId: "omp",
      createdAt: "2026-07-24T00:00:01.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: { model: "openai/gpt-5.6", effort: "high" },
    });
    const rerouted = decodeRuntimeEvent({
      type: "model.rerouted",
      eventId: "omp:session-1:9",
      provider: "omp",
      providerInstanceId: "omp",
      createdAt: "2026-07-24T00:00:02.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        fromModel: "openai/gpt-5.6",
        toModel: "anthropic/claude-sonnet-5",
        reason: "omp.config_option_update",
        effort: "high",
      },
    });

    expect(turnStarted.payload).toEqual({ model: "openai/gpt-5.6", effort: "high" });
    expect(rerouted.payload).toMatchObject({
      toModel: "anthropic/claude-sonnet-5",
      effort: "high",
    });
  });

  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
  });

  it("decodes optional subagent model and effort metadata", () => {
    const parsed = decodeRuntimeEvent({
      type: "task.started",
      eventId: "event-subagent-1",
      provider: "omp",
      createdAt: "2026-07-24T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        taskId: "subagent-1",
        taskType: "subagent",
        description: "Review the implementation",
        model: "gpt-5.6-terra",
        effort: "high",
      },
    });

    expect(parsed.type).toBe("task.started");
    if (parsed.type !== "task.started") {
      throw new Error("expected task.started");
    }
    expect(parsed.payload.model).toBe("gpt-5.6-terra");
    expect(parsed.payload.effort).toBe("high");
  });
});
