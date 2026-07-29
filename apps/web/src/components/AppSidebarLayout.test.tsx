import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScaffoldLifecycleError,
  ScaffoldObserveInput,
  ScaffoldSessionObservation,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { makeScaffoldLifecycleAction } from "@t3tools/client-runtime/scaffold";

import { DraftId } from "../composerDraftStore";
import {
  createMemoryPendingTurnOutboxStorage,
  enqueuePendingTurn,
  retargetPendingTurnsForDraft,
} from "../connection/pendingTurnOutbox";
import {
  createMemoryScaffoldLifecycleActionStore,
  drainScaffoldLifecycleActions,
} from "../connection/scaffoldLifecycleOutbox";
import {
  SCAFFOLD_LEGACY_CREATE_MISSING_AUTHORITY_MESSAGE,
  SCAFFOLD_SESSION_FAILED_MESSAGE,
  SCAFFOLD_SESSION_STOPPED_MESSAGE,
  type ScaffoldSessionUiEntry,
} from "../scaffoldSessionUiStore";
import {
  bindScaffoldDraftToRemote,
  classifyScaffoldCreateFailure,
  commitLegacyFailedScaffoldObservation,
  reconcileLegacyFailedScaffoldSessions,
  reconcileScaffoldLifecycleStartup,
  scaffoldRetargetProvidersAreReady,
  scaffoldCreateConnectionRequest,
  shouldExecuteScaffoldCreate,
} from "./AppSidebarLayout";
import { SCAFFOLD_UNSUPPORTED_DRAFT_MESSAGE } from "./BranchToolbar.logic";
import appSidebarLayoutSource from "./AppSidebarLayout.tsx?raw";

const readyOmpCatalog: ReadonlyArray<ServerProvider> = [
  {
    instanceId: ProviderInstanceId.make("omp"),
    driver: ProviderDriverKind.make("omp"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-27T00:00:00.000Z",
    models: [
      {
        slug: "openai/gpt-5.6-luna",
        name: "GPT-5.6-Luna",
        isCustom: false,
        isDefault: true,
        capabilities: {},
      },
    ],
    slashCommands: [],
    skills: [],
  },
];

const readyOmpCatalogWithFableDefault: ReadonlyArray<ServerProvider> = [
  {
    ...readyOmpCatalog[0]!,
    models: [
      {
        slug: "anthropic/claude-fable-5",
        name: "Claude Fable 5",
        isCustom: false,
        isDefault: true,
        capabilities: {},
      },
      {
        slug: "openai/gpt-5.6-sol",
        name: "GPT-5.6-Sol",
        isCustom: false,
        isDefault: false,
        capabilities: {},
      },
    ],
  },
];

function scaffoldEntry(
  phase: ScaffoldSessionUiEntry["phase"],
  overrides: Partial<ScaffoldSessionUiEntry> = {},
): ScaffoldSessionUiEntry {
  return {
    draftId: DraftId.make("draft-scaffold"),
    sourceEnvironmentId: EnvironmentId.make("environment-source"),
    sourceProjectId: ProjectId.make("project-source"),
    deployment: "production",
    actionId: "op-scaffold",
    phase,
    environmentId: null,
    sessionId: "ses-scaffold",
    lifecycleEpoch: 0,
    links: null,
    error: phase === "failed" ? "Scaffold session could not be created." : null,
    createdAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("Scaffold sidebar create failure classification", () => {
  it.each(["stopped", "failed"] as const)(
    "reconciles one legacy failed draft to authoritative %s state",
    async (status) => {
      const entry = scaffoldEntry("failed", {
        error: "Scaffold session cannot be prepared.",
        terminal: false,
      });
      const observations: ScaffoldObserveInput[] = [];
      const terminal: Array<{ draftId: string; status: string; lifecycleEpoch: number }> = [];

      await reconcileLegacyFailedScaffoldSessions({
        entriesByDraftId: { [entry.draftId]: entry },
        attemptedDraftIds: new Set(),
        observe: async (input) => {
          observations.push(input);
          return new ScaffoldSessionObservation({
            sessionId: input.sessionId,
            status,
            lifecycleEpoch: 8,
          });
        },
        terminal: (draftId, observation) => terminal.push({ draftId, ...observation }),
      });

      expect(observations).toMatchObject([{ deployment: "production", sessionId: "ses-scaffold" }]);
      expect(terminal).toEqual([
        { draftId: "draft-scaffold", sessionId: "ses-scaffold", status, lifecycleEpoch: 8 },
      ]);
    },
  );

  it.each(["ready", "paused"] as const)(
    "leaves a legacy failed draft unchanged when Scaffold reports %s",
    async (status) => {
      const entry = scaffoldEntry("failed", {
        error: "Scaffold session cannot be prepared.",
        terminal: false,
      });
      const terminal = vi.fn();

      await reconcileLegacyFailedScaffoldSessions({
        entriesByDraftId: { [entry.draftId]: entry },
        attemptedDraftIds: new Set(),
        observe: async (input) =>
          new ScaffoldSessionObservation({
            sessionId: input.sessionId,
            status,
            lifecycleEpoch: 8,
          }),
        terminal,
      });

      expect(terminal).not.toHaveBeenCalled();
    },
  );

  it("observes only the exact non-terminal legacy failed projection and ignores lookup failure", async () => {
    const eligible = scaffoldEntry("failed", {
      error: "Scaffold session cannot be prepared.",
      terminal: false,
    });
    const calls: ScaffoldObserveInput[] = [];
    const terminal = vi.fn();

    await reconcileLegacyFailedScaffoldSessions({
      entriesByDraftId: {
        eligible,
        otherError: scaffoldEntry("failed", { error: "Scaffold could not be reached." }),
        noSession: scaffoldEntry("failed", {
          error: "Scaffold session cannot be prepared.",
          sessionId: null,
        }),
        terminal: scaffoldEntry("failed", {
          error: SCAFFOLD_SESSION_STOPPED_MESSAGE,
          terminal: true,
        }),
        ready: scaffoldEntry("ready", { error: "Scaffold session cannot be prepared." }),
      },
      attemptedDraftIds: new Set(),
      observe: async (input) => {
        calls.push(input);
        throw new Error("network unavailable");
      },
      terminal,
    });

    expect(calls).toHaveLength(1);
    expect(terminal).not.toHaveBeenCalled();
  });

  it("reconciles the real stale legacy shape even when its old projection marked itself terminal", async () => {
    const entry = scaffoldEntry("failed", {
      error: "Scaffold session cannot be prepared.",
      sessionId: "ses-stopped-legacy",
      terminal: true,
    });
    const terminal = vi.fn();

    await reconcileLegacyFailedScaffoldSessions({
      entriesByDraftId: { [entry.draftId]: entry },
      attemptedDraftIds: new Set(),
      observe: async (input) =>
        new ScaffoldSessionObservation({
          sessionId: input.sessionId,
          status: "stopped",
          lifecycleEpoch: 11,
        }),
      terminal,
    });

    expect(terminal).toHaveBeenCalledExactlyOnceWith(entry.draftId, {
      sessionId: "ses-stopped-legacy",
      lifecycleEpoch: 11,
      status: "stopped",
    });
  });

  it("waits for persisted entries to hydrate and observes each legacy draft once per mount", async () => {
    const entry = scaffoldEntry("failed", {
      error: "Scaffold session cannot be prepared.",
      terminal: false,
    });
    const attemptedDraftIds = new Set<string>();
    const observe = vi.fn(
      async (input: ScaffoldObserveInput) =>
        new ScaffoldSessionObservation({
          sessionId: input.sessionId,
          status: "stopped",
          lifecycleEpoch: 9,
        }),
    );
    const terminal = vi.fn();

    await reconcileLegacyFailedScaffoldSessions({
      entriesByDraftId: {},
      attemptedDraftIds,
      observe,
      terminal,
    });
    await reconcileLegacyFailedScaffoldSessions({
      entriesByDraftId: { [entry.draftId]: entry },
      attemptedDraftIds,
      observe,
      terminal,
    });
    await reconcileLegacyFailedScaffoldSessions({
      entriesByDraftId: { [entry.draftId]: { ...entry } },
      attemptedDraftIds,
      observe,
      terminal,
    });

    expect(observe).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledExactlyOnceWith(entry.draftId, {
      sessionId: "ses-scaffold",
      lifecycleEpoch: 9,
      status: "stopped",
    });
  });

  it("commits a delayed terminal observation after an unrelated Scaffold projection rerender", () => {
    const entry = scaffoldEntry("failed", {
      error: "Scaffold session cannot be prepared.",
      terminal: false,
    });
    const terminal = vi.fn();

    expect(
      commitLegacyFailedScaffoldObservation({
        // The entries object changed while the read-only observation was in
        // flight, but the observed draft itself is still the same legacy
        // projection and must not lose its authoritative terminal result.
        entry: { ...entry },
        observation: {
          sessionId: "ses-scaffold",
          lifecycleEpoch: 10,
          status: "stopped",
        },
        terminal,
      }),
    ).toBe(true);
    expect(terminal).toHaveBeenCalledExactlyOnceWith(entry.draftId, {
      sessionId: "ses-scaffold",
      lifecycleEpoch: 10,
      status: "stopped",
    });
  });

  it("discards a delayed terminal observation after the observed draft changes", () => {
    const entry = scaffoldEntry("ready", {
      error: null,
      sessionId: "ses-new",
      terminal: false,
    });
    const terminal = vi.fn();

    expect(
      commitLegacyFailedScaffoldObservation({
        entry,
        observation: {
          sessionId: "ses-scaffold",
          lifecycleEpoch: 10,
          status: "stopped",
        },
        terminal,
      }),
    ).toBe(false);
    expect(terminal).not.toHaveBeenCalled();
  });

  it("commits a delayed terminal observation over the exact stale terminal legacy projection", () => {
    const entry = scaffoldEntry("failed", {
      error: "Scaffold session cannot be prepared.",
      terminal: true,
    });
    const terminal = vi.fn();

    expect(
      commitLegacyFailedScaffoldObservation({
        entry,
        observation: {
          sessionId: "ses-scaffold",
          lifecycleEpoch: 12,
          status: "stopped",
        },
        terminal,
      }),
    ).toBe(true);
    expect(terminal).toHaveBeenCalledExactlyOnceWith(entry.draftId, {
      sessionId: "ses-scaffold",
      lifecycleEpoch: 12,
      status: "stopped",
    });
  });

  it("records the authoritative cross-environment thread promotion after retargeting", () => {
    expect(appSidebarLayoutSource).toMatch(
      /retargetPendingTurnsForDraft\([\s\S]*?bindScaffoldDraftToRemote\([\s\S]*?markDraftThreadPromoting\([\s\S]*?scopeThreadRef\(remoteProject\.environmentId, draft\.threadId\)/,
    );
  });

  it("rebinds the composer model before exposing the remote project context", () => {
    const calls: Array<{ readonly name: string; readonly value: unknown }> = [];

    expect(
      bindScaffoldDraftToRemote({
        draftId: DraftId.make("draft-scaffold"),
        sourceSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "openai-codex/gpt-5.6-luna",
          options: [{ id: "reasoning_effort", value: "high" }],
        },
        targetProviders: readyOmpCatalog,
        projectRef: {
          environmentId: EnvironmentId.make("environment-remote"),
          projectId: ProjectId.make("project-remote"),
        },
        setModelSelection: (_draftId, selection, options) => {
          calls.push({ name: "model", value: { selection, options } });
        },
        setDraftThreadContext: (_draftId, context) => {
          calls.push({ name: "context", value: context });
        },
      }),
    ).toBe(true);
    expect(calls).toEqual([
      {
        name: "model",
        value: {
          selection: {
            instanceId: "omp",
            model: "openai/gpt-5.6-luna",
            options: [{ id: "reasoning_effort", value: "high" }],
          },
          options: { replaceOptions: true },
        },
      },
      {
        name: "context",
        value: {
          projectRef: {
            environmentId: "environment-remote",
            projectId: "project-remote",
          },
          envMode: "local",
          worktreePath: null,
        },
      },
    ]);
  });

  it("binds the accepted pending-turn model instead of a mutable draft selection", async () => {
    const draftId = DraftId.make("draft-scaffold");
    const threadId = ThreadId.make("thread-scaffold");
    const commandId = CommandId.make("command-scaffold");
    const messageId = MessageId.make("message-scaffold");
    const storage = createMemoryPendingTurnOutboxStorage();
    await enqueuePendingTurn(storage, {
      idempotencyKey: commandId,
      environmentId: EnvironmentId.make(`scaffold-pending:${draftId}`),
      threadId,
      messageId,
      draftId,
      createdAt: "2026-07-29T00:00:00.000Z",
      input: {
        commandId,
        threadId,
        message: {
          messageId,
          role: "user",
          text: "Keep the accepted model",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "openai-codex/gpt-5.6-sol",
          options: [{ id: "reasoning_effort", value: "high" }],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-07-29T00:00:00.000Z",
      },
    });

    const environmentId = EnvironmentId.make("environment-remote");
    const projectId = ProjectId.make("project-remote");
    const acceptedTurnSelection = await retargetPendingTurnsForDraft(
      storage,
      draftId,
      environmentId,
      projectId,
      readyOmpCatalogWithFableDefault,
    );
    const setModelSelection = vi.fn();

    expect(
      bindScaffoldDraftToRemote({
        draftId,
        acceptedTurnSelection,
        sourceSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "anthropic/claude-fable-5",
        },
        targetProviders: readyOmpCatalogWithFableDefault,
        projectRef: { environmentId, projectId },
        setModelSelection,
        setDraftThreadContext: vi.fn(),
      }),
    ).toBe(true);
    expect(setModelSelection).toHaveBeenCalledExactlyOnceWith(
      draftId,
      {
        instanceId: "omp",
        model: "openai/gpt-5.6-sol",
        options: [{ id: "reasoning_effort", value: "high" }],
      },
      { replaceOptions: true },
    );
  });

  it("defers draft retargeting until the destination OMP catalog is hydrated", () => {
    expect(scaffoldRetargetProvidersAreReady(null)).toBe(false);
    expect(scaffoldRetargetProvidersAreReady([])).toBe(false);
    expect(scaffoldRetargetProvidersAreReady(readyOmpCatalog)).toBe(true);
  });

  it("surfaces retryable connection details for explicit retry", () => {
    expect(
      classifyScaffoldCreateFailure(
        new ConnectionTransientError({
          reason: "timeout",
          detail: "Scaffold connected, but the agent environment did not become ready.",
        }),
      ),
    ).toEqual({
      result: { _tag: "retry", retryAfterMs: 1_000, errorCode: "timeout" },
      detail: "Scaffold connected, but the agent environment did not become ready.",
    });
  });

  it("keeps preparation-pending failures non-terminal and honors their retry delay", () => {
    expect(
      classifyScaffoldCreateFailure(
        new ScaffoldLifecycleError({
          reason: "unavailable",
          message: "Scaffold session is still preparing.",
          status: 202,
          code: "scaffold_preparation_pending",
          retryAfterMs: 2_500,
          observation: new ScaffoldSessionObservation({
            sessionId: "server-minted-session",
            status: "creating",
            lifecycleEpoch: 3,
          }),
        }),
      ),
    ).toEqual({
      result: {
        _tag: "wait",
        retryAfterMs: 2_500,
        errorCode: "scaffold_preparation_pending",
        observation: { sessionId: "server-minted-session", lifecycleEpoch: 3 },
      },
    });
  });

  it.each([
    ["terminal", "stopped", SCAFFOLD_SESSION_STOPPED_MESSAGE],
    ["not_found", "failed", SCAFFOLD_SESSION_FAILED_MESSAGE],
  ] as const)(
    "blocks %s lifecycle errors and preserves the authoritative %s observation",
    (reason, status, detail) => {
      expect(
        classifyScaffoldCreateFailure(
          new ScaffoldLifecycleError({
            reason,
            message: "Scaffold session cannot be prepared.",
            status: reason === "not_found" ? 404 : 409,
            code: `scaffold_session_${status}`,
            observation: new ScaffoldSessionObservation({
              sessionId: `ses_authoritative_${status}`,
              status,
              lifecycleEpoch: 7,
            }),
          }),
        ),
      ).toEqual({
        result: { _tag: "blocked", errorCode: `scaffold_session_${status}` },
        detail,
        terminalObservation: {
          sessionId: `ses_authoritative_${status}`,
          lifecycleEpoch: 7,
          status,
        },
      });
    },
  );

  it("executes only a draft explicitly placed in the creating phase", () => {
    expect(shouldExecuteScaffoldCreate(scaffoldEntry("creating"))).toBe(true);
    expect(shouldExecuteScaffoldCreate(scaffoldEntry("failed"))).toBe(false);
    expect(shouldExecuteScaffoldCreate(scaffoldEntry("ready"))).toBe(false);
    expect(shouldExecuteScaffoldCreate(undefined)).toBe(false);
  });

  it("uses the durable production target after a structured-clone reload", () => {
    const action = structuredClone(
      makeScaffoldLifecycleAction({
        actionId: "op-production",
        kind: "create",
        deployment: "production",
        draftId: "draft-scaffold",
        sourceEnvironmentId: EnvironmentId.make("environment-source"),
        sourceProjectId: ProjectId.make("project-source"),
        environmentId: EnvironmentId.make("scaffold-pending:draft-scaffold"),
        connectionId: "connection-production",
        sessionId: "session-production",
        expectedLifecycleEpoch: 0,
        createdAt: "2026-07-27T00:00:00.000Z",
      }),
    );

    expect(
      scaffoldCreateConnectionRequest(
        action,
        scaffoldEntry("creating", {
          actionId: "op-production",
          sessionId: "session-production",
        }),
      ),
    ).toMatchObject({
      _tag: "ready",
      input: {
        deployment: "production",
        operationId: "op-production",
        sessionId: "session-production",
        label: "Scaffold production",
      },
    });
  });

  it("fails closed when durable and projected Scaffold targets differ", () => {
    const action = makeScaffoldLifecycleAction({
      actionId: "op-staging",
      kind: "create",
      deployment: "staging",
      draftId: "draft-scaffold",
      sourceEnvironmentId: EnvironmentId.make("environment-source"),
      sourceProjectId: ProjectId.make("project-source"),
      environmentId: EnvironmentId.make("scaffold-pending:draft-scaffold"),
      connectionId: "connection-staging",
      sessionId: "session-staging",
      expectedLifecycleEpoch: 0,
      createdAt: "2026-07-27T00:00:00.000Z",
    });

    expect(
      scaffoldCreateConnectionRequest(
        action,
        scaffoldEntry("creating", {
          actionId: "op-staging",
          sessionId: "session-staging",
        }),
      ),
    ).toEqual({
      _tag: "blocked",
      errorCode: "scaffold_create_deployment_mismatch",
    });
  });

  it("does not infer a target for a persisted pre-target create action", () => {
    const current = makeScaffoldLifecycleAction({
      actionId: "op-legacy",
      kind: "create",
      deployment: "production",
      draftId: "draft-scaffold",
      sourceEnvironmentId: EnvironmentId.make("environment-source"),
      sourceProjectId: ProjectId.make("project-source"),
      environmentId: EnvironmentId.make("scaffold-pending:draft-scaffold"),
      connectionId: "connection-legacy",
      sessionId: "session-legacy",
      expectedLifecycleEpoch: 0,
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    if (current.kind !== "create") throw new Error("expected create action");
    const legacy = structuredClone(current);
    Reflect.deleteProperty(legacy, "deployment");

    expect(
      scaffoldCreateConnectionRequest(
        legacy,
        scaffoldEntry("creating", {
          actionId: "op-legacy",
          sessionId: "session-legacy",
        }),
      ),
    ).toEqual({
      _tag: "blocked",
      errorCode: "scaffold_create_missing_deployment",
    });
  });

  it("reconstructs an interrupted UI projection from the durable action before execution", async () => {
    const action = makeScaffoldLifecycleAction({
      actionId: "op-interrupted-ui",
      kind: "create",
      deployment: "production",
      draftId: "draft-interrupted-ui",
      sourceEnvironmentId: EnvironmentId.make("environment-source"),
      sourceProjectId: ProjectId.make("project-source"),
      environmentId: EnvironmentId.make("scaffold-pending:draft-interrupted-ui"),
      connectionId: "connection-interrupted-ui",
      sessionId: "session-interrupted-ui",
      expectedLifecycleEpoch: 0,
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    const store = createMemoryScaffoldLifecycleActionStore([action]);
    const recovered: ScaffoldSessionUiEntry[] = [];
    const failures: string[] = [];

    await reconcileScaffoldLifecycleStartup({
      store,
      entriesByDraftId: {},
      recover: (entry) => recovered.push(entry),
      fail: (_draftId, error) => failures.push(error),
    });

    expect(failures).toEqual([]);
    expect(recovered).toMatchObject([
      {
        draftId: "draft-interrupted-ui",
        deployment: "production",
        actionId: "op-interrupted-ui",
        sessionId: "session-interrupted-ui",
        phase: "creating",
      },
    ]);
    expect(scaffoldCreateConnectionRequest(action, recovered[0]!)).toMatchObject({
      _tag: "ready",
      input: { deployment: "production", operationId: "op-interrupted-ui" },
    });

    const executed: string[] = [];
    await drainScaffoldLifecycleActions({
      store,
      execute: async (pending) => {
        const request = scaffoldCreateConnectionRequest(pending, recovered[0]!);
        if (request._tag === "blocked") return request;
        executed.push(pending.actionId);
        return { _tag: "acknowledged" };
      },
    });
    expect(executed).toEqual(["op-interrupted-ui"]);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("repairs a stale creating projection after the durable action adopts a server session", async () => {
    const action = makeScaffoldLifecycleAction({
      actionId: "op-server-rebound",
      kind: "create",
      deployment: "production",
      draftId: "draft-scaffold",
      sourceEnvironmentId: EnvironmentId.make("environment-source"),
      sourceProjectId: ProjectId.make("project-source"),
      environmentId: EnvironmentId.make("scaffold-pending:draft-scaffold"),
      connectionId: "connection-server-rebound",
      sessionId: "server-minted-session",
      expectedLifecycleEpoch: 3,
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    const staleEntry = scaffoldEntry("creating", {
      actionId: action.actionId,
      sessionId: "provisional-session",
      lifecycleEpoch: 0,
    });
    const rebound: ScaffoldSessionUiEntry[] = [];
    const failures: string[] = [];

    await reconcileScaffoldLifecycleStartup({
      store: createMemoryScaffoldLifecycleActionStore([action]),
      entriesByDraftId: { [staleEntry.draftId]: staleEntry },
      recover: () => {
        throw new Error("must repair the existing projection");
      },
      rebind: (entry) => rebound.push(entry),
      fail: (_draftId, error) => failures.push(error),
    });

    expect(failures).toEqual([]);
    expect(rebound).toMatchObject([
      {
        actionId: action.actionId,
        phase: "creating",
        environmentId: null,
        sessionId: "server-minted-session",
        lifecycleEpoch: 3,
      },
    ]);
  });

  it("retires a create action after reload when Scaffold minted a different session id", async () => {
    const action = makeScaffoldLifecycleAction({
      actionId: "op-connected-before-remove",
      kind: "create",
      deployment: "production",
      draftId: "draft-scaffold",
      sourceEnvironmentId: EnvironmentId.make("environment-source"),
      sourceProjectId: ProjectId.make("project-source"),
      environmentId: EnvironmentId.make("scaffold-pending:draft-scaffold"),
      connectionId: "connection-connected-before-remove",
      sessionId: "provisional-session",
      expectedLifecycleEpoch: 0,
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    const store = createMemoryScaffoldLifecycleActionStore([action]);
    const connectedEntry = scaffoldEntry("ready", {
      actionId: action.actionId,
      environmentId: EnvironmentId.make("remote-environment"),
      sessionId: "server-minted-session",
      lifecycleEpoch: 1,
    });
    const failures: string[] = [];

    await reconcileScaffoldLifecycleStartup({
      store,
      entriesByDraftId: { [connectedEntry.draftId]: connectedEntry },
      recover: () => {
        throw new Error("must not recover an already connected projection");
      },
      fail: (_draftId, error) => failures.push(error),
    });

    expect(failures).toEqual([]);
    await expect(store.list()).resolves.toEqual([]);
    expect(connectedEntry).toMatchObject({
      phase: "ready",
      sessionId: "server-minted-session",
      error: null,
    });
  });

  it("fails a stale UI projection instead of executing a different durable source", async () => {
    const action = makeScaffoldLifecycleAction({
      actionId: "op-projection-mismatch",
      kind: "create",
      deployment: "production",
      draftId: "draft-scaffold",
      sourceEnvironmentId: EnvironmentId.make("different-source-environment"),
      sourceProjectId: ProjectId.make("project-source"),
      environmentId: EnvironmentId.make("scaffold-pending:draft-scaffold"),
      connectionId: "connection-projection-mismatch",
      sessionId: "ses-scaffold",
      expectedLifecycleEpoch: 0,
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    const entry = scaffoldEntry("creating", { actionId: action.actionId });
    const failures: Array<{ draftId: string; error: string }> = [];

    await reconcileScaffoldLifecycleStartup({
      store: createMemoryScaffoldLifecycleActionStore([action]),
      entriesByDraftId: { [entry.draftId]: entry },
      recover: () => {
        throw new Error("must not replace a mismatched projection");
      },
      fail: (draftId, error) => failures.push({ draftId, error }),
    });

    expect(failures).toEqual([
      {
        draftId: "draft-scaffold",
        error:
          "This Scaffold session request no longer matches its saved draft. Start a new session.",
      },
    ]);
  });

  it("fails an interrupted creating projection whose durable action is missing", async () => {
    const entry = scaffoldEntry("creating");
    const failures: Array<{ draftId: string; error: string }> = [];

    await reconcileScaffoldLifecycleStartup({
      store: createMemoryScaffoldLifecycleActionStore(),
      entriesByDraftId: { [entry.draftId]: entry },
      recover: () => {
        throw new Error("must not recover without an action");
      },
      fail: (draftId, error) => failures.push({ draftId, error }),
    });

    expect(failures).toEqual([
      {
        draftId: "draft-scaffold",
        error: "This Scaffold session request was not saved. Start a new session.",
      },
    ]);
  });

  it("fails a targetless legacy action without trusting its contradictory UI target", async () => {
    const current = makeScaffoldLifecycleAction({
      actionId: "op-targetless-legacy",
      kind: "create",
      deployment: "production",
      draftId: "draft-scaffold",
      sourceEnvironmentId: EnvironmentId.make("environment-source"),
      sourceProjectId: ProjectId.make("project-source"),
      environmentId: EnvironmentId.make("scaffold-pending:draft-scaffold"),
      connectionId: "connection-targetless-legacy",
      sessionId: "ses-scaffold",
      expectedLifecycleEpoch: 0,
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    const legacy = structuredClone(current);
    if (legacy.kind !== "create") throw new Error("expected create action");
    Reflect.deleteProperty(legacy, "deployment");
    Reflect.deleteProperty(legacy, "draftId");
    Reflect.deleteProperty(legacy, "sourceEnvironmentId");
    Reflect.deleteProperty(legacy, "sourceProjectId");
    const blockedLegacy = {
      ...legacy,
      blocked: true,
      lastErrorCode: "legacy_create_missing_authority",
    };
    const entry = scaffoldEntry("creating", {
      actionId: current.actionId,
      deployment: "staging",
    });
    const failures: string[] = [];

    await reconcileScaffoldLifecycleStartup({
      store: createMemoryScaffoldLifecycleActionStore([blockedLegacy]),
      entriesByDraftId: { [entry.draftId]: entry },
      recover: () => {
        throw new Error("must not reconstruct from contradictory UI authority");
      },
      fail: (_draftId, error) => failures.push(error),
    });

    expect(failures).toEqual([SCAFFOLD_LEGACY_CREATE_MISSING_AUTHORITY_MESSAGE]);
  });

  it("blocks typed authentication failures immediately and preserves safe detail", () => {
    expect(
      classifyScaffoldCreateFailure(
        new ConnectionBlockedError({
          reason: "authentication",
          detail: "Scaffold authentication is required.",
        }),
      ),
    ).toEqual({
      result: { _tag: "blocked", errorCode: "authentication" },
      detail: "Scaffold authentication is required.",
    });
  });

  it("replaces unsupported control-plane detail with terminal user copy", () => {
    expect(
      classifyScaffoldCreateFailure(
        new ConnectionBlockedError({
          reason: "unsupported",
          detail: "remote_code_sandbox_not_found",
        }),
      ),
    ).toEqual({
      result: { _tag: "blocked", errorCode: "unsupported" },
      detail: SCAFFOLD_UNSUPPORTED_DRAFT_MESSAGE,
    });
  });

  it("preserves a persistent saved-session attach failure", () => {
    expect(
      classifyScaffoldCreateFailure(
        new ConnectionBlockedError({
          reason: "remote-unavailable",
          detail:
            "Scaffold could not attach this saved session after refreshing its connection. Try reconnecting later or start a new session.",
        }),
      ),
    ).toEqual({
      result: { _tag: "blocked", errorCode: "remote-unavailable" },
      detail:
        "Scaffold could not attach this saved session after refreshing its connection. Try reconnecting later or start a new session.",
    });
  });

  it("retries typed transient failures", () => {
    expect(
      classifyScaffoldCreateFailure(
        new ConnectionTransientError({
          reason: "network",
          detail: "Scaffold could not be reached.",
        }),
      ),
    ).toEqual({
      result: { _tag: "retry", retryAfterMs: 1_000, errorCode: "network" },
      detail: "Scaffold could not be reached.",
    });
  });
});
