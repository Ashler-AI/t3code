import {
  PrimaryConnectionTarget,
  ScaffoldConnectionTarget,
  SessionFabricConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SessionFabricClientId,
  SessionFabricSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createScaffoldSessionTitleSyncRunner,
  scaffoldSessionTitleSyncTargetAvailability,
  selectScaffoldSessionTitleSyncCandidates,
  type ScaffoldTitleSyncProject,
  type ScaffoldTitleSyncThread,
} from "./scaffoldSessionTitleSync";

const environmentId = EnvironmentId.make("environment-scaffold");
const projectId = ProjectId.make("project-scaffold");

const target = new ScaffoldConnectionTarget({
  environmentId,
  label: "Scaffold staging",
  deployment: "staging",
  sessionId: "ses-scaffold",
  lifecycleEpoch: 1,
});

const project: ScaffoldTitleSyncProject = {
  environmentId,
  id: projectId,
  title: "ashler-platform",
  workspaceRoot: "/workspace/ashler-platform",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
};

function thread(input: {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
}): ScaffoldTitleSyncThread {
  return {
    environmentId,
    id: ThreadId.make(input.id),
    projectId,
    title: input.title,
    modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "openai/gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("Scaffold session title synchronization", () => {
  it("uses the earliest non-placeholder thread title and skips project fallback titles", () => {
    expect(
      selectScaffoldSessionTitleSyncCandidates({
        targets: [target],
        projects: [project],
        threads: [
          thread({ id: "thread-new", title: "New thread", createdAt: "2026-07-30T00:00:00Z" }),
          thread({
            id: "thread-project",
            title: "ashler-platform",
            createdAt: "2026-07-30T00:00:01Z",
          }),
          thread({
            id: "thread-titled",
            title: "Fix Scaffold resume failures",
            createdAt: "2026-07-30T00:00:02Z",
          }),
        ],
      }),
    ).toEqual([
      {
        deployment: "staging",
        environmentId,
        sessionId: "ses-scaffold",
        threadId: ThreadId.make("thread-titled"),
        expectedCurrentName: "ashler-platform",
        name: "Fix Scaffold resume failures",
        operationId: "scaffold-title-sync:ses-scaffold:thread-titled",
      },
    ]);
  });

  it("does not emit a rename before an eligible title exists", () => {
    expect(
      selectScaffoldSessionTitleSyncCandidates({
        targets: [target],
        projects: [project],
        threads: [
          thread({ id: "thread-new", title: "New thread", createdAt: "2026-07-30T00:00:00Z" }),
          thread({
            id: "thread-project",
            title: "ashler-platform",
            createdAt: "2026-07-30T00:00:01Z",
          }),
        ],
      }),
    ).toEqual([]);
  });

  it("coalesces concurrent synchronization and does not repeat completed work", async () => {
    let resolveRename!: () => void;
    const rename = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRename = resolve;
        }),
    );
    const runner = createScaffoldSessionTitleSyncRunner(rename);
    const [candidate] = selectScaffoldSessionTitleSyncCandidates({
      targets: [target],
      projects: [project],
      threads: [
        thread({
          id: "thread-titled",
          title: "Fix Scaffold resume failures",
          createdAt: "2026-07-30T00:00:02Z",
        }),
      ],
    });
    if (!candidate) throw new Error("expected title candidate");

    const first = runner.run(candidate);
    const second = runner.run(candidate);
    expect(rename).toHaveBeenCalledOnce();
    expect(second).toBe(first);
    resolveRename();
    await first;
    await runner.run(candidate);
    expect(rename).toHaveBeenCalledOnce();
  });

  it("backs off repeated renders after a failure and retries after the cooldown", async () => {
    let now = 1_000;
    const rename = vi
      .fn<(candidate: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce();
    const runner = createScaffoldSessionTitleSyncRunner(rename, {
      now: () => now,
      retryDelayMs: 30_000,
    });
    const [candidate] = selectScaffoldSessionTitleSyncCandidates({
      targets: [target],
      projects: [project],
      threads: [
        thread({
          id: "thread-titled",
          title: "Fix Scaffold resume failures",
          createdAt: "2026-07-30T00:00:02Z",
        }),
      ],
    });
    if (!candidate) throw new Error("expected title candidate");

    await expect(runner.run(candidate)).rejects.toThrow("offline");
    await expect(runner.run(candidate)).resolves.toBeUndefined();
    expect(rename).toHaveBeenCalledOnce();

    now += 30_000;
    await expect(runner.run(candidate)).resolves.toBeUndefined();
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it("requires both the primary RPC owner and the Scaffold target to be connected", () => {
    const primaryEnvironmentId = EnvironmentId.make("environment-primary");
    const primaryTarget = new PrimaryConnectionTarget({
      environmentId: primaryEnvironmentId,
      label: "This Mac",
      httpBaseUrl: "http://127.0.0.1:13773",
      wsBaseUrl: "ws://127.0.0.1:13773/ws",
    });
    const environment = (
      targetInput: PrimaryConnectionTarget | ScaffoldConnectionTarget,
      phase: "connected" | "offline" | "reconnecting",
    ) => ({
      environmentId: targetInput.environmentId,
      connection: { phase },
      entry: { target: targetInput },
    });

    expect(
      scaffoldSessionTitleSyncTargetAvailability({
        primaryEnvironmentId,
        environments: [environment(primaryTarget, "offline"), environment(target, "connected")],
      }),
    ).toEqual([{ target, usable: false }]);

    expect(
      scaffoldSessionTitleSyncTargetAvailability({
        primaryEnvironmentId,
        environments: [
          environment(primaryTarget, "connected"),
          environment(target, "reconnecting"),
        ],
      }),
    ).toEqual([{ target, usable: false }]);

    expect(
      scaffoldSessionTitleSyncTargetAvailability({
        primaryEnvironmentId,
        environments: [environment(primaryTarget, "connected"), environment(target, "connected")],
      }),
    ).toEqual([{ target, usable: true }]);
  });

  it("does not treat a virtual session-fabric environment as Scaffold rename RPC authority", () => {
    const primaryEnvironmentId = EnvironmentId.make("session-fabric:shared-session");
    const fabricTarget = new SessionFabricConnectionTarget({
      environmentId: primaryEnvironmentId,
      label: "Shared session",
      relayBaseUrl: "https://relay.example.com",
      sessionId: SessionFabricSessionId.make("shared-session"),
      clientId: SessionFabricClientId.make("client-id"),
    });

    expect(
      scaffoldSessionTitleSyncTargetAvailability({
        primaryEnvironmentId,
        environments: [
          {
            environmentId: primaryEnvironmentId,
            connection: { phase: "connected" },
            entry: { target: fabricTarget },
          },
          {
            environmentId,
            connection: { phase: "connected" },
            entry: { target },
          },
        ],
      }),
    ).toEqual([{ target, usable: false }]);
  });

  it("keeps retrying transient failures with bounded backoff until naming succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const rename = vi
      .fn<(candidate: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("RPC unavailable"))
      .mockRejectedValueOnce(new Error("lifecycle unavailable"))
      .mockRejectedValueOnce(new Error("still unavailable"))
      .mockResolvedValueOnce();
    const runner = createScaffoldSessionTitleSyncRunner(rename, {
      retryDelayMs: 10,
      maxAttemptsPerConnection: 2,
      maxRetryDelayMs: 20,
    });
    const [candidate] = selectScaffoldSessionTitleSyncCandidates({
      targets: [target],
      projects: [project],
      threads: [
        thread({
          id: "thread-titled",
          title: "Fix Scaffold resume failures",
          createdAt: "2026-07-30T00:00:02Z",
        }),
      ],
    });
    if (!candidate) throw new Error("expected title candidate");

    try {
      runner.reconcileAvailability([{ target, usable: true }]);
      await expect(runner.run(candidate)).rejects.toThrow("RPC unavailable");
      expect(rename).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(9);
      expect(rename).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(rename).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(19);
      expect(rename).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(rename).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(19);
      expect(rename).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(rename).toHaveBeenCalledTimes(4);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(runner.run(candidate)).resolves.toBeUndefined();
      expect(rename).toHaveBeenCalledTimes(4);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("stops retrying terminal lifecycle failures", async () => {
    vi.useFakeTimers();
    const terminal = Object.assign(new Error("sandbox stopped"), { reason: "terminal" });
    const rename = vi.fn<(candidate: unknown) => Promise<void>>().mockRejectedValue(terminal);
    const runner = createScaffoldSessionTitleSyncRunner(rename, { retryDelayMs: 10 });
    const [candidate] = selectScaffoldSessionTitleSyncCandidates({
      targets: [target],
      projects: [project],
      threads: [
        thread({
          id: "thread-titled",
          title: "Fix Scaffold resume failures",
          createdAt: "2026-07-30T00:00:02Z",
        }),
      ],
    });
    if (!candidate) throw new Error("expected title candidate");

    try {
      runner.reconcileAvailability([{ target, usable: true }]);
      await expect(runner.run(candidate)).rejects.toThrow("sandbox stopped");
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(runner.run(candidate)).resolves.toBeUndefined();
      expect(rename).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("cancels backoff while disconnected and retries immediately after reconnect", async () => {
    vi.useFakeTimers();
    const rename = vi
      .fn<(candidate: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("RPC unavailable"))
      .mockResolvedValueOnce();
    const runner = createScaffoldSessionTitleSyncRunner(rename, { retryDelayMs: 10_000 });
    const [candidate] = selectScaffoldSessionTitleSyncCandidates({
      targets: [target],
      projects: [project],
      threads: [
        thread({
          id: "thread-titled",
          title: "Fix Scaffold resume failures",
          createdAt: "2026-07-30T00:00:02Z",
        }),
      ],
    });
    if (!candidate) throw new Error("expected title candidate");

    try {
      runner.reconcileAvailability([{ target, usable: true }]);
      await expect(runner.run(candidate)).rejects.toThrow("RPC unavailable");
      runner.reconcileAvailability([{ target, usable: false }]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rename).toHaveBeenCalledOnce();

      runner.reconcileAvailability([{ target, usable: true }]);
      await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rename).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
