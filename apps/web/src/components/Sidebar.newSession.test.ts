import { describe, expect, it } from "vite-plus/test";

import commandPaletteSource from "./CommandPalette.tsx?raw";
import sidebarSource from "./Sidebar.tsx?raw";
import sidebarV2Source from "./SidebarV2.tsx?raw";

const componentSources = {
  "CommandPalette.tsx": commandPaletteSource,
  "Sidebar.tsx": sidebarSource,
  "SidebarV2.tsx": sidebarV2Source,
} as const;
const sidebarCases = [
  ["Sidebar.tsx", "openNewSessionCommandPalette", "openNewSession"],
  ["SidebarV2.tsx", "handleNewSessionClick", "handleNewSessionClick"],
] as const;

describe("persistent sidebar New session control", () => {
  it.each(sidebarCases)(
    "routes the %s control to the new-session chooser intent",
    (file, handler, onClick) => {
      const source = componentSources[file];

      expect(source).toContain(`const ${handler} = useCallback`);
      expect(source).toMatch(
        new RegExp(
          `const ${handler} = useCallback[\\s\\S]*?openCommandPalette\\(\\{ open: "new-session" \\}\\)`,
        ),
      );
      const controlLabelIndex = source.indexOf('aria-label="New session"');
      const controlSource = source.slice(controlLabelIndex - 500, controlLabelIndex + 500);
      expect(controlLabelIndex).toBeGreaterThan(-1);
      expect(controlSource).toContain(`onClick={${onClick}}`);
      expect(controlSource).not.toContain("disabled={");
    },
  );

  it("keeps the chooser available without a command-palette keyboard shortcut", () => {
    const source = componentSources["CommandPalette.tsx"];

    expect(source).toContain('if (detail.open === "new-session")');
    expect(source).toContain('title: "Local"');
    expect(source).toContain('title: "Scaffold staging"');
    expect(source).toContain('title: "Scaffold production"');
    expect(source).not.toMatch(
      /value: "action:new-session",[\s\S]{0,400}disabled: projects\.length === 0/,
    );
    expect(source).toMatch(
      /value: "action:new-session:local",[\s\S]{0,400}disabled: scaffoldSourceProject === null/,
    );
  });

  it("always starts a fresh local draft from the New Session chooser", () => {
    const source = componentSources["CommandPalette.tsx"];

    expect(source).toMatch(
      /kind: "action",[\s\S]*?value: "action:new-session:local",[\s\S]*?run: async \(\) => \{[\s\S]*?handleNewThread\([\s\S]*?scopeProjectRef\(scaffoldSourceProject\.environmentId, scaffoldSourceProject\.id\)[\s\S]*?forceNew: true/,
    );
    expect(source).not.toContain("const newLocalSessionProjectItems");
    expect(source).toMatch(
      /const projectThreadItems = useMemo\([\s\S]*?handleNewThread\(scopeProjectRef\(project\.environmentId, project\.id\)\);/,
    );
  });
});
