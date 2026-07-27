import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ScaffoldEnvironmentBinding,
  ScaffoldSessionLinks,
} from "@t3tools/contracts";

import { DraftId } from "./composerDraftStore";
import { useScaffoldSessionUiStore } from "./scaffoldSessionUiStore";

describe("scaffoldSessionUiStore", () => {
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
});
