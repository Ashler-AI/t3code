import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ScaffoldEnvironmentBinding,
  ScaffoldSessionLinks,
} from "@t3tools/contracts";
import { ScaffoldConnectionTarget } from "@t3tools/client-runtime/connection";

import { DraftId } from "./composerDraftStore";
import { makeScaffoldLifecycleAction } from "@t3tools/client-runtime/scaffold";
import {
  SCAFFOLD_DEPLOYMENT_MISMATCH_MESSAGE,
  SCAFFOLD_SESSION_FAILED_MESSAGE,
  SCAFFOLD_SESSION_STOPPED_MESSAGE,
  scaffoldSessionUiEntryFromCreateAction,
  scaffoldSessionUiEntryMatchesCreateAction,
  scaffoldSessionUiEntryMatchesPendingCreateAction,
  useScaffoldSessionUiStore,
} from "./scaffoldSessionUiStore";

describe("scaffoldSessionUiStore", () => {
  beforeEach(() => {
    useScaffoldSessionUiStore.setState({
      entriesByDraftId: {},
      volatileCreateActionsByDraftId: {},
    });
  });

  it("reconstructs the complete UI projection from a durable create action", () => {
    const action = makeScaffoldLifecycleAction({
      actionId: "op_recover",
      kind: "create",
      deployment: "production",
      draftId: "draft-recover",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      environmentId: EnvironmentId.make("scaffold-pending:draft-recover"),
      connectionId: "connection-recover",
      sessionId: "session-recover",
      expectedLifecycleEpoch: 0,
      createdAt: "2026-07-24T00:00:00.000Z",
    });

    const recovered = scaffoldSessionUiEntryFromCreateAction(structuredClone(action));
    expect(recovered).toMatchObject({
      draftId: "draft-recover",
      sourceEnvironmentId: "source-environment",
      sourceProjectId: "source-project",
      deployment: "production",
      actionId: "op_recover",
      phase: "creating",
      environmentId: null,
      sessionId: "session-recover",
      createdAt: "2026-07-24T00:00:00.000Z",
    });
    expect(recovered && scaffoldSessionUiEntryMatchesCreateAction(recovered, action)).toBe(true);
    expect(recovered && scaffoldSessionUiEntryMatchesPendingCreateAction(recovered, action)).toBe(
      true,
    );
  });

  it("matches a connected create by immutable identity after Scaffold mints a session id", () => {
    const action = makeScaffoldLifecycleAction({
      actionId: "op_server_session",
      kind: "create",
      deployment: "production",
      draftId: "draft-server-session",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      environmentId: EnvironmentId.make("scaffold-pending:draft-server-session"),
      connectionId: "connection-server-session",
      sessionId: "provisional-session",
      expectedLifecycleEpoch: 0,
      createdAt: "2026-07-24T00:00:00.000Z",
    });
    const connected = {
      ...scaffoldSessionUiEntryFromCreateAction(action)!,
      phase: "ready" as const,
      environmentId: EnvironmentId.make("remote-environment"),
      sessionId: "server-minted-session",
    };

    expect(scaffoldSessionUiEntryMatchesCreateAction(connected, action)).toBe(true);
    expect(scaffoldSessionUiEntryMatchesPendingCreateAction(connected, action)).toBe(false);
  });

  it("rebinds a creating draft to the server session without projecting it connected", () => {
    const draftId = DraftId.make("draft-server-rebind");
    const store = useScaffoldSessionUiStore.getState();
    store.begin({
      draftId,
      deployment: "production",
      actionId: "op_server_rebind",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      sessionId: "provisional-session",
      createdAt: "2026-07-24T00:00:00.000Z",
    });

    store.rebindCreating(draftId, "op_server_rebind", "server-minted-session", 3);

    expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toMatchObject({
      actionId: "op_server_rebind",
      phase: "creating",
      environmentId: null,
      sessionId: "server-minted-session",
      lifecycleEpoch: 3,
      links: null,
      error: null,
    });
  });

  it("adopts an exact registered target without projecting its transport connected", () => {
    const draftId = DraftId.make("draft-adopt-target");
    const store = useScaffoldSessionUiStore.getState();
    store.begin({
      draftId,
      deployment: "staging",
      actionId: "op_adopt_target",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      sessionId: "ses-adopt-target",
      createdAt: "2026-07-24T00:00:00.000Z",
    });

    store.adoptRegisteredTarget(
      draftId,
      new ScaffoldConnectionTarget({
        environmentId: EnvironmentId.make("remote-environment"),
        label: "Scaffold staging",
        deployment: "staging",
        sessionId: "ses-adopt-target",
        lifecycleEpoch: 7,
        links: new ScaffoldSessionLinks({
          session: "https://scaffold-staging.example/?q=ses-adopt-target",
          web: "https://scaffold-staging.example/sessions/ses-adopt-target/web",
          tilt: "https://scaffold-staging.example/sessions/ses-adopt-target/tilt",
        }),
      }),
    );

    expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toEqual({
      draftId,
      deployment: "staging",
      actionId: "op_adopt_target",
      sourceEnvironmentId: "source-environment",
      sourceProjectId: "source-project",
      phase: "creating",
      environmentId: "remote-environment",
      sessionId: "ses-adopt-target",
      lifecycleEpoch: 7,
      links: {
        session: "https://scaffold-staging.example/?q=ses-adopt-target",
        web: "https://scaffold-staging.example/sessions/ses-adopt-target/web",
        tilt: "https://scaffold-staging.example/sessions/ses-adopt-target/tilt",
      },
      error: null,
      terminal: false,
      createdAt: "2026-07-24T00:00:00.000Z",
    });
  });

  it("binds a created sandbox while its registered supervisor is still connecting", () => {
    const draftId = DraftId.make("draft-registered-target");
    const store = useScaffoldSessionUiStore.getState();
    store.begin({
      draftId,
      deployment: "staging",
      actionId: "op_registered_target",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      sessionId: "ses-registered-target",
      createdAt: "2026-07-24T00:00:00.000Z",
    });

    store.registered(
      draftId,
      new ScaffoldEnvironmentBinding({
        deployment: "staging",
        environmentId: EnvironmentId.make("remote-environment"),
        sessionId: "ses-registered-target",
        lifecycleEpoch: 5,
        status: "ready",
        links: new ScaffoldSessionLinks({
          session: "https://scaffold-staging.example/?q=ses-registered-target",
          web: "https://scaffold-staging.example/sessions/ses-registered-target/web",
          tilt: "https://scaffold-staging.example/sessions/ses-registered-target/tilt",
        }),
        lastKnownAt: "2026-07-24T00:01:00.000Z",
      }),
    );

    expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toMatchObject({
      phase: "creating",
      environmentId: "remote-environment",
      sessionId: "ses-registered-target",
      lifecycleEpoch: 5,
      error: null,
    });
  });

  it("projects registered supervisor state without replaying creation", () => {
    const draftId = DraftId.make("draft-supervisor-state");
    const store = useScaffoldSessionUiStore.getState();
    store.begin({
      draftId,
      deployment: "staging",
      actionId: "op_supervisor_state",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      sessionId: "ses-supervisor-state",
      createdAt: "2026-07-24T00:00:00.000Z",
    });
    const target = new ScaffoldConnectionTarget({
      environmentId: EnvironmentId.make("remote-environment"),
      label: "Scaffold staging",
      deployment: "staging",
      sessionId: "ses-supervisor-state",
      lifecycleEpoch: 8,
      links: new ScaffoldSessionLinks({
        session: "https://scaffold-staging.example/?q=ses-supervisor-state",
        web: "https://scaffold-staging.example/sessions/ses-supervisor-state/web",
        tilt: "https://scaffold-staging.example/sessions/ses-supervisor-state/tilt",
      }),
    });
    store.adoptRegisteredTarget(draftId, target);

    store.syncRegisteredTarget(draftId, target, {
      phase: "reconnecting",
      error: "Attach is still preparing.",
      traceId: null,
    });
    expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toMatchObject({
      phase: "creating",
      environmentId: "remote-environment",
      error: null,
    });

    store.syncRegisteredTarget(draftId, target, {
      phase: "connected",
      error: null,
      traceId: null,
    });
    expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toMatchObject({
      phase: "ready",
      environmentId: "remote-environment",
      error: null,
    });

    const stableConnectedProjection =
      useScaffoldSessionUiStore.getState().entriesByDraftId[draftId];
    store.syncRegisteredTarget(draftId, target, {
      phase: "connected",
      error: null,
      traceId: null,
    });
    expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toBe(
      stableConnectedProjection,
    );

    store.syncRegisteredTarget(draftId, target, {
      phase: "error",
      error: "Scaffold attach authorization expired.",
      traceId: null,
    });
    expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toMatchObject({
      phase: "failed",
      environmentId: "remote-environment",
      error: "Scaffold attach authorization expired.",
      links: {
        session: "https://scaffold-staging.example/?q=ses-supervisor-state",
        web: "https://scaffold-staging.example/sessions/ses-supervisor-state/web",
        tilt: "https://scaffold-staging.example/sessions/ses-supervisor-state/tilt",
      },
    });
  });

  it.each([
    ["ready phase", { phase: "ready" as const }],
    ["paused phase", { phase: "paused" as const }],
    ["failed phase", { phase: "failed" as const }],
    ["terminal projection", { terminal: true }],
  ])("does not overwrite a %s while adopting a registered target", (_label, override) => {
    const draftId = DraftId.make("draft-reject-adoption");
    const store = useScaffoldSessionUiStore.getState();
    store.begin({
      draftId,
      deployment: "staging",
      actionId: "op_reject_adoption",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      sessionId: "ses-reject-adoption",
      createdAt: "2026-07-24T00:00:00.000Z",
    });
    const before = {
      ...useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]!,
      ...override,
    };
    useScaffoldSessionUiStore.setState({ entriesByDraftId: { [draftId]: before } });

    store.adoptRegisteredTarget(
      draftId,
      new ScaffoldConnectionTarget({
        environmentId: EnvironmentId.make("remote-environment"),
        label: "Scaffold staging",
        deployment: "staging",
        sessionId: "ses-reject-adoption",
        lifecycleEpoch: 7,
      }),
    );

    expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toEqual(before);
  });

  it("recovers a failed draft from its exact registered Scaffold target", () => {
    const draftId = DraftId.make("draft-reconnect-target");
    const store = useScaffoldSessionUiStore.getState();
    store.begin({
      draftId,
      deployment: "staging",
      actionId: "op_reconnect_target",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      sessionId: "ses-reconnect-target",
      createdAt: "2026-07-24T00:00:00.000Z",
    });
    store.fail(draftId, "Connection failed.");

    store.reconnectRegisteredTarget(
      draftId,
      new ScaffoldConnectionTarget({
        environmentId: EnvironmentId.make("remote-environment"),
        label: "Scaffold staging",
        deployment: "staging",
        sessionId: "ses-reconnect-target",
        lifecycleEpoch: 9,
        links: new ScaffoldSessionLinks({
          session: "https://scaffold-staging.example/?q=ses-reconnect-target",
          web: "https://scaffold-staging.example/sessions/ses-reconnect-target/web",
          tilt: "https://scaffold-staging.example/sessions/ses-reconnect-target/tilt",
        }),
      }),
    );

    expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toMatchObject({
      phase: "resuming",
      environmentId: "remote-environment",
      sessionId: "ses-reconnect-target",
      lifecycleEpoch: 9,
      links: {
        session: "https://scaffold-staging.example/?q=ses-reconnect-target",
        web: "https://scaffold-staging.example/sessions/ses-reconnect-target/web",
        tilt: "https://scaffold-staging.example/sessions/ses-reconnect-target/tilt",
      },
      error: null,
      terminal: false,
    });
  });

  it("does not publish repeated identical failures", () => {
    const draftId = DraftId.make("draft-idempotent-failure");
    const store = useScaffoldSessionUiStore.getState();
    store.begin({
      draftId,
      deployment: "staging",
      actionId: "op_idempotent_failure",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      sessionId: "ses-idempotent-failure",
      createdAt: "2026-07-24T00:00:00.000Z",
    });
    store.fail(draftId, "Connection failed.");
    const failedState = useScaffoldSessionUiStore.getState();

    store.fail(draftId, "Connection failed.");

    expect(useScaffoldSessionUiStore.getState()).toBe(failedState);
  });

  it.each([
    ["different deployment", {}, { deployment: "production" as const }],
    ["different session", {}, { sessionId: "ses-other" }],
    [
      "different bound environment",
      { environmentId: EnvironmentId.make("environment-bound") },
      { environmentId: EnvironmentId.make("environment-other") },
    ],
  ])(
    "does not reconnect a failed draft through a %s",
    (_label, currentOverride, targetOverride) => {
      const draftId = DraftId.make("draft-reject-reconnect");
      const store = useScaffoldSessionUiStore.getState();
      store.begin({
        draftId,
        deployment: "staging",
        actionId: "op_reject_reconnect",
        sourceEnvironmentId: EnvironmentId.make("source-environment"),
        sourceProjectId: ProjectId.make("source-project"),
        sessionId: "ses-reconnect-target",
        createdAt: "2026-07-24T00:00:00.000Z",
      });
      store.fail(draftId, "Connection failed.");
      useScaffoldSessionUiStore.setState((state) => ({
        entriesByDraftId: {
          ...state.entriesByDraftId,
          [draftId]: {
            ...state.entriesByDraftId[draftId]!,
            ...currentOverride,
          },
        },
      }));
      const before = useScaffoldSessionUiStore.getState().entriesByDraftId[draftId];

      store.reconnectRegisteredTarget(
        draftId,
        new ScaffoldConnectionTarget({
          environmentId: EnvironmentId.make("remote-environment"),
          label: "Scaffold staging",
          deployment: "staging",
          sessionId: "ses-reconnect-target",
          lifecycleEpoch: 9,
          ...targetOverride,
        }),
      );

      expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toEqual(before);
    },
  );

  it("does not reconnect a terminal failed draft", () => {
    const draftId = DraftId.make("draft-terminal-reconnect");
    const store = useScaffoldSessionUiStore.getState();
    store.begin({
      draftId,
      deployment: "staging",
      actionId: "op_terminal_reconnect",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      sessionId: "ses-reconnect-target",
      createdAt: "2026-07-24T00:00:00.000Z",
    });
    store.terminal(draftId, {
      sessionId: "ses-reconnect-target",
      lifecycleEpoch: 9,
      status: "failed",
    });
    const before = useScaffoldSessionUiStore.getState().entriesByDraftId[draftId];

    store.reconnectRegisteredTarget(
      draftId,
      new ScaffoldConnectionTarget({
        environmentId: EnvironmentId.make("remote-environment"),
        label: "Scaffold staging",
        deployment: "staging",
        sessionId: "ses-reconnect-target",
        lifecycleEpoch: 9,
      }),
    );

    expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toEqual(before);
  });

  it("persists only the safe lifecycle projection without transcript or send state", () => {
    const draftId = DraftId.make("draft-scaffold");
    const store = useScaffoldSessionUiStore.getState();
    store.begin({
      draftId,
      deployment: "staging",
      actionId: "op_1",
      sourceEnvironmentId: EnvironmentId.make("local"),
      sourceProjectId: ProjectId.make("project"),
      sessionId: "ses_1",
      createdAt: "2026-07-24T00:00:00.000Z",
    });
    store.connected(
      draftId,
      new ScaffoldEnvironmentBinding({
        deployment: "staging",
        environmentId: EnvironmentId.make("remote"),
        sessionId: "ses_1",
        lifecycleEpoch: 2,
        status: "ready",
        links: new ScaffoldSessionLinks({
          session: "https://scaffold.example/?q=ses_1",
          web: "https://scaffold.example/sessions/ses_1/web",
          tilt: "https://scaffold.example/sessions/ses_1/tilt",
        }),
        lastKnownAt: "2026-07-24T00:01:00.000Z",
      }),
    );

    expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toMatchObject({
      phase: "ready",
      environmentId: "remote",
      sessionId: "ses_1",
      lifecycleEpoch: 2,
    });
    expect(
      JSON.stringify(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]),
    ).not.toContain("credential");
    expect(
      JSON.stringify(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]),
    ).not.toContain("queuedSend");
  });

  it("retains a credential-free failed create action only in volatile retry state", () => {
    const draftId = DraftId.make("draft-volatile-retry");
    const action = makeScaffoldLifecycleAction({
      actionId: "op_volatile",
      kind: "create",
      deployment: "production",
      draftId,
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      environmentId: EnvironmentId.make(`scaffold-pending:${draftId}`),
      connectionId: "connection-volatile",
      sessionId: "session-volatile",
      expectedLifecycleEpoch: 0,
      createdAt: "2026-07-24T00:00:00.000Z",
      create: { name: "Ashler" },
    });
    const store = useScaffoldSessionUiStore.getState();
    store.rememberVolatileCreateAction(action);
    store.begin({
      draftId,
      deployment: "production",
      actionId: action.actionId,
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      sessionId: action.sessionId,
      createdAt: action.createdAt,
    });
    store.fail(draftId, "IndexedDB unavailable");

    expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toMatchObject({
      deployment: "production",
      phase: "failed",
      error: "IndexedDB unavailable",
    });
    expect(useScaffoldSessionUiStore.getState().volatileCreateActionsByDraftId[draftId]).toEqual(
      action,
    );
    expect(JSON.stringify(action)).not.toMatch(/credential|token/i);

    store.forgetVolatileCreateAction(draftId);
    expect(
      useScaffoldSessionUiStore.getState().volatileCreateActionsByDraftId[draftId],
    ).toBeUndefined();
  });

  it("fails closed when Scaffold returns a binding for a different deployment", () => {
    const draftId = DraftId.make("draft-target-mismatch");
    const store = useScaffoldSessionUiStore.getState();
    store.begin({
      draftId,
      deployment: "production",
      actionId: "op_mismatch",
      sourceEnvironmentId: EnvironmentId.make("local"),
      sourceProjectId: ProjectId.make("project"),
      sessionId: "ses_mismatch",
      createdAt: "2026-07-24T00:00:00.000Z",
    });

    store.connected(
      draftId,
      new ScaffoldEnvironmentBinding({
        deployment: "staging",
        environmentId: EnvironmentId.make("wrong-remote"),
        sessionId: "ses_mismatch",
        lifecycleEpoch: 2,
        status: "ready",
        links: new ScaffoldSessionLinks({
          session: "https://scaffold-staging.example/?q=ses_mismatch",
          web: "https://scaffold-staging.example/sessions/ses_mismatch/web",
          tilt: "https://scaffold-staging.example/sessions/ses_mismatch/tilt",
        }),
        lastKnownAt: "2026-07-24T00:01:00.000Z",
      }),
    );

    expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toMatchObject({
      deployment: "production",
      phase: "failed",
      environmentId: null,
      lifecycleEpoch: 0,
      links: null,
      error: SCAFFOLD_DEPLOYMENT_MISMATCH_MESSAGE,
    });
  });

  it("does not let a late ready observation resurrect a concurrently paused session", () => {
    const draftId = DraftId.make("draft-pause-wins");
    const store = useScaffoldSessionUiStore.getState();
    store.begin({
      draftId,
      deployment: "staging",
      actionId: "op_pause_wins",
      sourceEnvironmentId: EnvironmentId.make("local"),
      sourceProjectId: ProjectId.make("project"),
      sessionId: "ses_pause_wins",
      createdAt: "2026-07-24T00:00:00.000Z",
    });
    const connection = (status: "ready" | "paused", lifecycleEpoch: number) =>
      new ScaffoldEnvironmentBinding({
        deployment: "staging",
        environmentId: EnvironmentId.make("remote"),
        sessionId: "ses_pause_wins",
        lifecycleEpoch,
        status,
        links: new ScaffoldSessionLinks({
          session: "https://scaffold.example/?q=ses_pause_wins",
          web: "https://scaffold.example/sessions/ses_pause_wins/web",
          tilt: "https://scaffold.example/sessions/ses_pause_wins/tilt",
        }),
        lastKnownAt: "2026-07-24T00:01:00.000Z",
      });

    store.connected(draftId, connection("ready", 2));
    store.setPhase(draftId, "resuming");
    store.connected(draftId, connection("paused", 3));
    store.connected(draftId, connection("ready", 4));

    expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toMatchObject({
      phase: "paused",
      lifecycleEpoch: 3,
    });
  });

  it("accepts a ready observation after an explicit resume begins", () => {
    const draftId = DraftId.make("draft-explicit-resume");
    const store = useScaffoldSessionUiStore.getState();
    store.begin({
      draftId,
      deployment: "staging",
      actionId: "op_explicit_resume",
      sourceEnvironmentId: EnvironmentId.make("local"),
      sourceProjectId: ProjectId.make("project"),
      sessionId: "ses_explicit_resume",
      createdAt: "2026-07-24T00:00:00.000Z",
    });
    const connection = (status: "ready" | "paused", lifecycleEpoch: number) =>
      new ScaffoldEnvironmentBinding({
        deployment: "staging",
        environmentId: EnvironmentId.make("remote"),
        sessionId: "ses_explicit_resume",
        lifecycleEpoch,
        status,
        links: new ScaffoldSessionLinks({
          session: "https://scaffold.example/?q=ses_explicit_resume",
          web: "https://scaffold.example/sessions/ses_explicit_resume/web",
          tilt: "https://scaffold.example/sessions/ses_explicit_resume/tilt",
        }),
        lastKnownAt: "2026-07-24T00:01:00.000Z",
      });

    store.connected(draftId, connection("paused", 3));
    store.setPhase(draftId, "resuming");
    store.connected(draftId, connection("ready", 4));

    expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toMatchObject({
      phase: "ready",
      lifecycleEpoch: 4,
    });
  });

  it.each([
    ["stopped", SCAFFOLD_SESSION_STOPPED_MESSAGE],
    ["failed", SCAFFOLD_SESSION_FAILED_MESSAGE],
  ] as const)(
    "projects a %s binding as terminal and ignores later ready observations",
    (status, error) => {
      const draftId = DraftId.make(`draft-terminal-${status}`);
      const store = useScaffoldSessionUiStore.getState();
      store.begin({
        draftId,
        deployment: "production",
        actionId: `op_terminal_${status}`,
        sourceEnvironmentId: EnvironmentId.make("local"),
        sourceProjectId: ProjectId.make("project"),
        sessionId: `ses_terminal_${status}`,
        createdAt: "2026-07-24T00:00:00.000Z",
      });
      const binding = (nextStatus: "ready" | "stopped" | "failed", lifecycleEpoch: number) =>
        new ScaffoldEnvironmentBinding({
          deployment: "production",
          environmentId: EnvironmentId.make("remote"),
          sessionId: `ses_terminal_${status}`,
          lifecycleEpoch,
          status: nextStatus,
          links: new ScaffoldSessionLinks({
            session: `https://scaffold.example/?q=ses_terminal_${status}`,
            web: `https://scaffold.example/sessions/ses_terminal_${status}/web`,
            tilt: `https://scaffold.example/sessions/ses_terminal_${status}/tilt`,
          }),
          lastKnownAt: "2026-07-24T00:01:00.000Z",
        });

      store.connected(draftId, binding(status, 4));
      store.connected(draftId, binding("ready", 5));
      store.setPhase(draftId, "resuming");

      expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toMatchObject({
        phase: "failed",
        terminal: true,
        lifecycleEpoch: 4,
        error,
      });
    },
  );

  it.each([
    ["stopped", SCAFFOLD_SESSION_STOPPED_MESSAGE],
    ["failed", SCAFFOLD_SESSION_FAILED_MESSAGE],
  ] as const)(
    "projects a terminal %s lifecycle observation without a connection binding",
    (status, error) => {
      const draftId = DraftId.make(`draft-terminal-observation-${status}`);
      const store = useScaffoldSessionUiStore.getState();
      store.begin({
        draftId,
        deployment: "staging",
        actionId: `op_terminal_observation_${status}`,
        sourceEnvironmentId: EnvironmentId.make("local"),
        sourceProjectId: ProjectId.make("project"),
        sessionId: "ses_provisional",
        createdAt: "2026-07-24T00:00:00.000Z",
      });

      store.terminal(draftId, {
        sessionId: `ses_authoritative_${status}`,
        lifecycleEpoch: 7,
        status,
      });
      store.fail(draftId, "Scaffold session could not be created.");
      store.setPhase(draftId, "creating");

      expect(useScaffoldSessionUiStore.getState().entriesByDraftId[draftId]).toMatchObject({
        phase: "failed",
        environmentId: null,
        sessionId: `ses_authoritative_${status}`,
        lifecycleEpoch: 7,
        error,
        terminal: true,
      });
    },
  );
});
