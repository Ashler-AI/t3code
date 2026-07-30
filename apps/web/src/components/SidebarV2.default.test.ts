import { describe, expect, it } from "vite-plus/test";

import appSidebarLayoutSource from "./AppSidebarLayout.tsx?raw";
import betaSettingsPanelSource from "./settings/BetaSettingsPanel.tsx?raw";
import sidebarV2Source from "./SidebarV2.tsx?raw";
import chatRouteSource from "../routes/_chat.tsx?raw";

describe("Sidebar v2 default", () => {
  it("uses v2 on workspace routes without consulting a persisted false beta setting", () => {
    expect(appSidebarLayoutSource).not.toContain("settings.sidebarV2Enabled");
    expect(appSidebarLayoutSource).toContain("const useSidebarV2 = !isOnSettings");
    expect(appSidebarLayoutSource).toContain(
      "{useSidebarV2 ? <ThreadSidebarV2 /> : <ThreadSidebar />}",
    );
    expect(appSidebarLayoutSource).toContain('data-sidebar-version="v2"');
  });

  it("uses v2 new-thread routing without consulting the legacy setting", () => {
    expect(chatRouteSource).not.toContain("settings.sidebarV2Enabled");
    expect(chatRouteSource).toContain("if (projectGroupCount > 1)");
    expect(chatRouteSource).toContain('openCommandPalette({ open: "new-thread-in" })');
  });

  it("does not expose an ignored Sidebar v2 beta toggle", () => {
    expect(betaSettingsPanelSource).not.toContain('title="Sidebar v2"');
    expect(betaSettingsPanelSource).not.toContain('aria-label="Enable the sidebar v2 beta"');
    expect(betaSettingsPanelSource).not.toContain("settings.sidebarV2Enabled");
  });

  it("uses the native settled lifecycle instead of a parallel done state", () => {
    expect(sidebarV2Source).toContain('aria-label="Settle thread"');
    expect(sidebarV2Source).toContain('? "Settled"');
    expect(sidebarV2Source).toContain(": `Settled (${settledThreads.length})`");
    expect(sidebarV2Source).not.toContain('aria-label="Mark thread done"');
  });

  it("shows running terminal status in thread rows and tooltips", () => {
    expect(sidebarV2Source).toContain("useThreadRunningTerminalIds");
    expect(sidebarV2Source).toContain("terminalStatusFromRunningIds(runningTerminalIds)");
    expect(sidebarV2Source).toContain("terminalProcessLabel(terminalProcessCount)");
    expect(sidebarV2Source).toContain("{terminalStatusIcon}");
  });

  it("keeps the invisible card status overlay from swallowing settle clicks", () => {
    expect(sidebarV2Source).toContain(
      '"pointer-events-none tabular-nums text-muted-foreground/55 transition-opacity group-hover/v2-row:opacity-0"',
    );
  });

  it("dispatches settle and un-settle controls without activating the row", () => {
    expect(sidebarV2Source).toContain("onClick={handleSettleClick}");
    expect(sidebarV2Source).toContain("onClick={handleUnsettleClick}");
    expect(sidebarV2Source).toContain(
      "event.preventDefault();\n      event.stopPropagation();\n      onSettle(threadRef);",
    );
    expect(sidebarV2Source).toContain(
      "event.preventDefault();\n      event.stopPropagation();\n      onUnsettle(threadRef);",
    );
  });

  it("reuses Scaffold row presentation objects across route-only sidebar renders", () => {
    expect(sidebarV2Source).toContain(
      "const scaffoldSessionPresentationByEnvironmentId = useMemo(",
    );
    expect(sidebarV2Source).toContain(
      "scaffoldSessionPresentationByEnvironmentId.get(thread.environmentId)",
    );
  });

  it("switches shared sessions through the SPA router and exposes Scaffold destinations", () => {
    expect(sidebarV2Source).toContain('to: "/$environmentId/$threadId"');
    expect(sidebarV2Source).toContain("environmentId: `session-fabric:${session.sessionId}`");
    expect(sidebarV2Source).not.toContain("window.location.assign(");
    expect(sidebarV2Source).toContain('["Session", scaffoldLinks.sessionUrl]');
    expect(sidebarV2Source).toContain('["Agent", scaffoldLinks.agentUrl]');
    expect(sidebarV2Source).toContain('["Web", scaffoldLinks.webUrl]');
    expect(sidebarV2Source).toContain('["Tilt", scaffoldLinks.tiltUrl]');
    expect(sidebarV2Source).toContain("Mirror");
    expect(sidebarV2Source).toContain("onClick={(event) => event.stopPropagation()}");
    expect(sidebarV2Source).toContain(
      "event.stopPropagation();\n                                  navigateToFabricSession(session);",
    );
  });

  it("keeps one stable shared-session row through shell hydration and dispatches its lifecycle control once", () => {
    expect(sidebarV2Source).toContain("key={`session-fabric:${session.sessionId}`}");
    expect(sidebarV2Source).toContain("sessionFabricThreadBySessionId.get(session.sessionId)");
    expect(sidebarV2Source).toContain("selectShadowedSessionFabricThreadKeys(");
    expect(sidebarV2Source).toContain(
      'fabricThreadIsSettled ? "Un-settle thread" : "Settle thread"',
    );
    expect(sidebarV2Source).toContain(
      "if (fabricThreadIsSettled) attemptUnsettle(fabricThreadRef)",
    );
    expect(sidebarV2Source).toContain("else attemptSettle(fabricThreadRef)");
    expect(sidebarV2Source).toContain("runSidebarThreadActionOnce(");
  });
});
