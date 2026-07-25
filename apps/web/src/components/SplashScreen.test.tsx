import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import { SplashScreen } from "./SplashScreen";

describe("SplashScreen", () => {
  it("renders the manifest-backed Ashler identity without upstream branding", () => {
    const markup = renderToStaticMarkup(<SplashScreen />);

    expect(markup).toContain('aria-label="Ashler Code splash screen"');
    expect(markup).toContain('src="/ashler-code-mark.svg"');
    expect(markup).toContain("Ashler Code");
    expect(markup).not.toContain("T3 Code");
  });
});
