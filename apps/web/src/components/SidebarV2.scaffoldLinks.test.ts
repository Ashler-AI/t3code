import { ScaffoldConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  ProjectId,
  ScaffoldDeployment,
  ScaffoldSessionLinks,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftId } from "../composerDraftStore";
import type { ScaffoldSessionUiEntry } from "../scaffoldSessionUiStore";
import {
  resolveScaffoldAgentUrl,
  resolveScaffoldSessionRowPresentation,
  stopScaffoldRowDestinationPropagation,
} from "./SidebarV2";
import sidebarV2Source from "./SidebarV2.tsx?raw";

const uiLinks = ScaffoldSessionLinks.make({
  session: "https://ui.scaffold.example/?q=scaffold-session",
  web: "https://scaffold.example/sessions/ui/web",
  tilt: "https://scaffold.example/sessions/ui/tilt",
});
const targetLinks = ScaffoldSessionLinks.make({
  session: "https://target.scaffold.example/sessions/scaffold-session",
  web: "https://scaffold.example/sessions/target/web",
  tilt: "https://scaffold.example/sessions/target/tilt",
});

function uiEntry(links: ScaffoldSessionUiEntry["links"]): ScaffoldSessionUiEntry {
  return {
    draftId: DraftId.make("draft-scaffold-links"),
    sourceEnvironmentId: EnvironmentId.make("source-environment"),
    sourceProjectId: ProjectId.make("source-project"),
    deployment: ScaffoldDeployment.make("staging"),
    actionId: "create-action",
    phase: "ready",
    environmentId: EnvironmentId.make("scaffold-environment"),
    sessionId: "scaffold-session",
    lifecycleEpoch: 1,
    links,
    error: null,
    createdAt: "2026-07-30T00:00:00.000Z",
  };
}

function target(links = targetLinks): ScaffoldConnectionTarget {
  return new ScaffoldConnectionTarget({
    environmentId: EnvironmentId.make("scaffold-environment"),
    label: "Scaffold staging",
    deployment: ScaffoldDeployment.make("staging"),
    sessionId: "scaffold-session",
    lifecycleEpoch: 1,
    links,
  });
}

describe("Scaffold sidebar row links", () => {
  it("falls back to authoritative registered-target links after UI state is lost", () => {
    expect(resolveScaffoldSessionRowPresentation(null, target())).toEqual({
      deployment: "staging",
      links: targetLinks,
      sessionId: "scaffold-session",
    });
    expect(resolveScaffoldSessionRowPresentation(uiEntry(null), target())).toEqual({
      deployment: "staging",
      links: targetLinks,
      sessionId: "scaffold-session",
    });
  });

  it("preserves the UI-store links when both sources are available", () => {
    expect(resolveScaffoldSessionRowPresentation(uiEntry(uiLinks), target())).toEqual({
      deployment: "staging",
      links: uiLinks,
      sessionId: "scaffold-session",
    });
  });

  it("does not invent Scaffold metadata for a local environment", () => {
    expect(resolveScaffoldSessionRowPresentation(null, null)).toBeNull();
  });

  it("keeps row navigation intact and exposes every explicit Scaffold destination", () => {
    expect(sidebarV2Source).toContain("onThreadClick(event, threadRef)");
    expect(sidebarV2Source).toContain('aria-label="Open Scaffold agent"');
    expect(sidebarV2Source).toContain('label: "Open Scaffold session"');
    expect(sidebarV2Source).toContain('label: "Open Scaffold web"');
    expect(sidebarV2Source).toContain('label: "Open Scaffold Tilt"');
  });

  it("derives the exact same-origin Agent attach route from supported session links", () => {
    expect(resolveScaffoldAgentUrl(uiEntry(uiLinks))).toBe(
      "https://ui.scaffold.example/sessions/scaffold-session/agent",
    );
    expect(resolveScaffoldAgentUrl(uiEntry(targetLinks))).toBe(
      "https://target.scaffold.example/sessions/scaffold-session/agent",
    );
  });

  it("omits the Agent action when the authoritative link does not match the row session", () => {
    const mismatched = ScaffoldSessionLinks.make({
      session: "https://scaffold.example/?q=another-session",
      web: targetLinks.web,
      tilt: targetLinks.tilt,
    });
    const duplicateIdentity = ScaffoldSessionLinks.make({
      session: "https://scaffold.example/?q=scaffold-session&q=scaffold-session",
      web: targetLinks.web,
      tilt: targetLinks.tilt,
    });

    expect(resolveScaffoldAgentUrl(uiEntry(mismatched))).toBeNull();
    expect(resolveScaffoldAgentUrl(uiEntry(duplicateIdentity))).toBeNull();
    expect(resolveScaffoldAgentUrl(uiEntry(null))).toBeNull();
  });

  it("isolates destination actions from the row without activating it", () => {
    const stopPropagation = vi.fn();

    stopScaffoldRowDestinationPropagation({ stopPropagation });

    expect(stopPropagation).toHaveBeenCalledOnce();
  });
});
