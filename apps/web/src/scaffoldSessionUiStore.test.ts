import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ScaffoldEnvironmentBinding,
  ScaffoldSessionLinks,
} from "@t3tools/contracts";

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
