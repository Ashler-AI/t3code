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
});
