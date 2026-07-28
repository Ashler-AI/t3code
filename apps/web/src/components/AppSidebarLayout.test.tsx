import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { makeScaffoldLifecycleAction } from "@t3tools/client-runtime/scaffold";

import { DraftId } from "../composerDraftStore";
import {
  createMemoryScaffoldLifecycleActionStore,
  drainScaffoldLifecycleActions,
} from "../connection/scaffoldLifecycleOutbox";
import {
  SCAFFOLD_LEGACY_CREATE_MISSING_AUTHORITY_MESSAGE,
  type ScaffoldSessionUiEntry,
} from "../scaffoldSessionUiStore";
import {
  classifyScaffoldCreateFailure,
  reconcileScaffoldLifecycleStartup,
  scaffoldRetargetProvidersAreReady,
  scaffoldCreateConnectionRequest,
  shouldExecuteScaffoldCreate,
} from "./AppSidebarLayout";

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
        slug: "openai/gpt-5.6-sol",
        name: "GPT-5.6-Sol",
        isCustom: false,
        isDefault: true,
        capabilities: {},
      },
    ],
    slashCommands: [],
    skills: [],
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
