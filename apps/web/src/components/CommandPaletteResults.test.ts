import { describe, expect, it } from "vite-plus/test";

import commandPaletteResultsSource from "./CommandPaletteResults.tsx?raw";

describe("disabled command palette results", () => {
  it("keeps unavailable Scaffold deployments visible to assistive technology", () => {
    expect(commandPaletteResultsSource).toMatch(
      /function DisabledCommandPaletteResultRow[\s\S]*?aria-disabled="true"[\s\S]*?role="option"/,
    );
  });
});
