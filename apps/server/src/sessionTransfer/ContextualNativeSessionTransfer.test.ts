import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@t3tools/contracts";

import {
  assertFreshContextualDestination,
  CONTEXTUAL_HANDOFF_ARTIFACT_PATH,
  makeContextualNativeSessionTransferPackage,
} from "./ContextualNativeSessionTransfer.ts";

function sourceThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.make("thread-native"),
    projectId: ProjectId.make("project-native"),
    title: "Investigate flaky tests",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex-work"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/flaky-tests",
    worktreePath: "/workspace",
    latestTurn: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:01:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: "2026-07-27T00:01:00.000Z",
    deletedAt: null,
    messages: [
      {
        id: "message-user" as never,
        role: "user",
        text: "Find the failing test",
        attachments: [
          {
            type: "file",
            id: "file-1",
            name: "failure.txt",
            mimeType: "text/plain",
            sizeBytes: 42,
          },
        ],
        turnId: "turn-1" as never,
        streaming: false,
        createdAt: "2026-07-27T00:00:01.000Z",
        updatedAt: "2026-07-27T00:00:01.000Z",
      },
      {
        id: "message-system" as never,
        role: "system",
        text: "private-native-bootstrap-token",
        turnId: null,
        streaming: false,
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z",
      },
      {
        id: "message-assistant" as never,
        role: "assistant",
        text: "The failure is in retry.test.ts",
        turnId: "turn-1" as never,
        streaming: false,
        createdAt: "2026-07-27T00:00:02.000Z",
        updatedAt: "2026-07-27T00:00:02.000Z",
      },
    ],
    proposedPlans: [],
    activities: [
      {
        id: "activity-tool" as never,
        tone: "tool",
        kind: "tool.completed",
        summary: "Read retry.test.ts",
        payload: { rawOutput: "secret payload is deliberately omitted" },
        turnId: "turn-1" as never,
        sequence: 1,
        createdAt: "2026-07-27T00:00:02.000Z",
      },
    ],
    checkpoints: [],
    session: {
      threadId: ThreadId.make("thread-native"),
      status: "idle",
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex-work"),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-07-27T00:01:00.000Z",
    },
    ...overrides,
  };
}

const packageInput = () => ({
  sourceEnvironmentId: EnvironmentId.make("environment-native"),
  sourceProjectId: ProjectId.make("project-native"),
  sourceRootPath: "/workspace",
  provider: ProviderDriverKind.make("codex"),
  thread: sourceThread(),
  capturedAt: "2026-07-27T00:02:00.000Z",
  worktreeOverlay: [
    {
      kind: "file" as const,
      path: "src/retry.ts",
      bytes: new TextEncoder().encode("export {}"),
      mode: 0o644 as const,
    },
    { kind: "tombstone" as const, path: "src/old-retry.ts" },
  ],
});

describe("contextual native Scaffold handoff", () => {
  it("builds deterministic visible context and keeps the worktree overlay", () => {
    const first = makeContextualNativeSessionTransferPackage(packageInput());
    const second = makeContextualNativeSessionTransferPackage(packageInput());
    const artifact = new TextDecoder().decode(first.contextArtifactBytes);

    expect(first.descriptor.kind).toBe("contextual-native");
    expect(first.descriptor.continuation).toEqual({
      exact: false,
      destinationProvider: "omp",
      nativeSessionStateTransferred: false,
    });
    expect(first.descriptor.contextArtifact.sha256).toBe(second.descriptor.contextArtifact.sha256);
    expect(artifact).toContain("not an exact continuation");
    expect(artifact).toContain("Find the failing test");
    expect(artifact).toContain("Read retry.test.ts");
    expect(artifact).toContain('"effort":"high"');
    expect(artifact).not.toContain("private-native-bootstrap-token");
    expect(artifact).not.toContain("secret payload is deliberately omitted");
    expect(JSON.stringify(first.descriptor)).not.toMatch(
      /nativeSessionId|providerSessionId|resumeCursor|credential|token/i,
    );
    expect(first.worktreeOverlay.map((entry) => entry.path)).toEqual([
      "src/retry.ts",
      "src/old-retry.ts",
      CONTEXTUAL_HANDOFF_ARTIFACT_PATH,
    ]);
  });

  it("rejects active turns, unsupported providers, and credential overlay paths", () => {
    expect(() =>
      makeContextualNativeSessionTransferPackage({
        ...packageInput(),
        thread: sourceThread({
          latestTurn: {
            turnId: "turn-active" as never,
            state: "running",
            requestedAt: "2026-07-27T00:00:00.000Z",
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
        }),
      }),
    ).toThrow(/finish/);
    expect(() =>
      makeContextualNativeSessionTransferPackage({
        ...packageInput(),
        provider: ProviderDriverKind.make("opencode"),
      }),
    ).toThrow(/Codex or Claude/);
    expect(() =>
      makeContextualNativeSessionTransferPackage({
        ...packageInput(),
        worktreeOverlay: [{ kind: "file", path: ".env", bytes: new Uint8Array([1]), mode: 0o644 }],
      }),
    ).toThrow(/forbidden path/);
  });

  it("requires every destination identity to be fresh", () => {
    const source = {
      environmentId: EnvironmentId.make("environment-native"),
      projectId: ProjectId.make("project-native"),
      threadId: ThreadId.make("thread-native"),
      globalSessionId: "sf:environment-native:thread-native",
    };
    expect(() =>
      assertFreshContextualDestination({
        source,
        destination: {
          environmentId: EnvironmentId.make("environment-scaffold"),
          projectId: ProjectId.make("project-scaffold"),
          threadId: ThreadId.make("thread-scaffold"),
          globalSessionId: "sf:environment-scaffold:thread-scaffold",
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertFreshContextualDestination({
        source,
        destination: { ...source },
      }),
    ).toThrow(/fresh environment, project, thread, and global ids/);
  });
});
