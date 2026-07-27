import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  type OrchestrationSessionStatus,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  canCopySessionToScaffold,
  COPY_SESSION_SCAFFOLD_DEPLOYMENTS,
  isSessionTransferLocalConnectionTarget,
  runSessionTransferCommand,
  SESSION_TRANSFER_ERROR_TITLE,
  sessionTransferCompletionTitle,
  sessionTransferCommandTitle,
  sessionTransferKindForThread,
  sessionTransferProgressTitle,
  type StartSessionCopy,
} from "./sessionTransferUi";

const source = {
  environmentId: EnvironmentId.make("primary"),
  projectId: ProjectId.make("project-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("session transfer eligibility", () => {
  const eligible = {
    isLocalEnvironment: true,
    startAvailable: true,
    thread: {
      session: {
        providerName: "omp",
        status: "idle",
        activeTurnId: null,
      },
    },
  } as const satisfies Parameters<typeof canCopySessionToScaffold>[0];

  it("allows settled local OMP and native Codex/Claude sessions with a start callback", () => {
    expect(canCopySessionToScaffold(eligible)).toBe(true);
    expect(canCopySessionToScaffold({ ...eligible, isLocalEnvironment: false })).toBe(false);
    expect(canCopySessionToScaffold({ ...eligible, startAvailable: false })).toBe(false);
    expect(canCopySessionToScaffold({ ...eligible, thread: null })).toBe(false);
    expect(
      canCopySessionToScaffold({
        ...eligible,
        thread: { session: { ...eligible.thread.session, providerName: "codex" } },
      }),
    ).toBe(true);
    expect(
      canCopySessionToScaffold({
        ...eligible,
        thread: { session: { ...eligible.thread.session, providerName: "claudeAgent" } },
      }),
    ).toBe(true);
    expect(
      canCopySessionToScaffold({
        ...eligible,
        thread: { session: { ...eligible.thread.session, providerName: "opencode" } },
      }),
    ).toBe(false);
    expect(
      canCopySessionToScaffold({
        ...eligible,
        thread: { session: { ...eligible.thread.session, activeTurnId: "turn-1" } },
      }),
    ).toBe(false);
  });

  it("labels native transfer as contextual rather than exact continuation", () => {
    const contextualThread = {
      session: { providerName: "codex" },
    };
    expect(sessionTransferKindForThread(contextualThread)).toBe("contextual-native");
    expect(sessionTransferCommandTitle("contextual-native")).toBe(
      "Continue in Scaffold (context only)",
    );
    expect(sessionTransferProgressTitle("staging", "contextual-native")).toBe(
      "Handing off context to Scaffold staging",
    );
    expect(sessionTransferCompletionTitle("staging", "contextual-native")).toBe(
      "Context handed off to Scaffold staging",
    );
  });

  it("classifies every orchestration session status", () => {
    const expectedByStatus = {
      idle: true,
      starting: false,
      running: false,
      ready: true,
      interrupted: true,
      stopped: true,
      error: true,
    } satisfies Record<OrchestrationSessionStatus, boolean>;

    for (const [status, expected] of Object.entries(expectedByStatus)) {
      expect(
        canCopySessionToScaffold({
          ...eligible,
          thread: {
            session: {
              ...eligible.thread.session,
              status: status as OrchestrationSessionStatus,
            },
          },
        }),
        status,
      ).toBe(expected);
      expect(
        canCopySessionToScaffold({
          ...eligible,
          thread: {
            session: {
              ...eligible.thread.session,
              status: status as OrchestrationSessionStatus,
              activeTurnId: "turn-1",
            },
          },
        }),
        `${status} with an active turn`,
      ).toBe(false);
    }
  });

  it("classifies generated-id primary and desktop-local Bearer targets as local", () => {
    expect(
      isSessionTransferLocalConnectionTarget(
        new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("descriptor-generated-uuid"),
          label: "This device",
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
        }),
      ),
    ).toBe(true);
    expect(
      isSessionTransferLocalConnectionTarget(
        new BearerConnectionTarget({
          environmentId: EnvironmentId.make("environment-wsl"),
          label: "WSL Ubuntu",
          connectionId: "local:wsl:Ubuntu",
        }),
      ),
    ).toBe(true);
    expect(
      isSessionTransferLocalConnectionTarget(
        new RelayConnectionTarget({
          environmentId: EnvironmentId.make("environment-remote"),
          label: "Remote",
        }),
      ),
    ).toBe(false);
  });
});

describe("session transfer command", () => {
  it("offers only staging in the Copy to Scaffold submenu", () => {
    expect(COPY_SESSION_SCAFFOLD_DEPLOYMENTS).toEqual(["staging"]);
    expect(COPY_SESSION_SCAFFOLD_DEPLOYMENTS).not.toContain("production");
  });

  it("closes immediately, reports progress, and opens the returned destination", async () => {
    const events: string[] = [];
    let resolveTransfer!: (value: { environmentId: EnvironmentId; threadId: ThreadId }) => void;
    const transfer = new Promise<{ environmentId: EnvironmentId; threadId: ThreadId }>(
      (resolve) => {
        resolveTransfer = resolve;
      },
    );
    const start = vi.fn(() => transfer);
    const destination = {
      environmentId: EnvironmentId.make("scaffold-staging"),
      threadId: ThreadId.make("thread-imported"),
    };

    const running = runSessionTransferCommand({
      deployment: "staging",
      source,
      start,
      closePalette: () => events.push("closed"),
      onProgress: (title) => events.push(title),
      onCompleted: (title, result) =>
        events.push(`${title}:${result.environmentId}:${result.threadId}`),
      onFailed: () => events.push("failed"),
    });

    expect(events).toEqual(["closed", "Copying session to Scaffold staging"]);
    expect(start).toHaveBeenCalledWith({ deployment: "staging", source });
    resolveTransfer(destination);
    await running;
    expect(events).toEqual([
      "closed",
      "Copying session to Scaffold staging",
      "Session copied to Scaffold staging:scaffold-staging:thread-imported",
    ]);
  });

  it("reports the concise failure title", async () => {
    const failed = vi.fn();
    const error = new Error("server unavailable");

    await runSessionTransferCommand({
      deployment: "production",
      source,
      start: async () => Promise.reject(error),
      closePalette: vi.fn(),
      onProgress: vi.fn(),
      onCompleted: vi.fn(),
      onFailed: failed,
    });

    expect(failed).toHaveBeenCalledWith("Could not copy session", error);
    expect(SESSION_TRANSFER_ERROR_TITLE).toBe("Could not copy session");
    expect(sessionTransferProgressTitle("production")).toBe(
      "Copying session to Scaffold production",
    );
    expect(sessionTransferCompletionTitle("production")).toBe(
      "Session copied to Scaffold production",
    );
  });

  it("starts a fresh server-resolved attempt after failure without retaining a physical id", async () => {
    const destination = {
      environmentId: EnvironmentId.make("scaffold-staging-next-attempt"),
      threadId: ThreadId.make("thread-next-attempt"),
    };
    const start = vi
      .fn<StartSessionCopy>()
      .mockRejectedValueOnce(new Error("The destination revoked the prior attempt."))
      .mockResolvedValueOnce(destination);
    const failed = vi.fn();
    const completed = vi.fn();
    const commandInput = {
      deployment: "staging" as const,
      source,
      start,
      closePalette: vi.fn(),
      onProgress: vi.fn(),
      onCompleted: completed,
      onFailed: failed,
    };

    await runSessionTransferCommand(commandInput);
    await runSessionTransferCommand(commandInput);

    expect(start).toHaveBeenNthCalledWith(1, { deployment: "staging", source });
    expect(start).toHaveBeenNthCalledWith(2, { deployment: "staging", source });
    expect(start.mock.calls.flatMap(([request]) => Object.keys(request))).not.toContain(
      "operationId",
    );
    expect(failed).toHaveBeenCalledWith(
      SESSION_TRANSFER_ERROR_TITLE,
      expect.objectContaining({ message: "The destination revoked the prior attempt." }),
    );
    expect(completed).toHaveBeenCalledWith(sessionTransferCompletionTitle("staging"), destination);
  });
});
