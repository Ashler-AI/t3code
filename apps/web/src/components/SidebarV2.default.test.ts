import { describe, expect, it } from "vite-plus/test";

import appSidebarLayoutSource from "./AppSidebarLayout.tsx?raw";
import betaSettingsPanelSource from "./settings/BetaSettingsPanel.tsx?raw";
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
});
