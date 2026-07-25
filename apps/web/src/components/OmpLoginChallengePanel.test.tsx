import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { OmpLoginChallengePanel } from "./OmpLoginChallengePanel";

describe("OmpLoginChallengePanel", () => {
  it("renders a modeless OAuth input form that submits with Enter", () => {
    const markup = renderToStaticMarkup(
      <OmpLoginChallengePanel
        challenge={{
          flowId: "login_claude",
          provider: "anthropic",
          kind: "input",
          prompt: "Paste the callback value.",
        }}
        authorizationUrl="https://example.test/oauth"
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="false"');
    expect(markup).toContain("Finish adding Claude");
    expect(markup).toContain("Paste the callback value.");
    expect(markup).toContain("Sign-in page didn’t open?");
    expect(markup).toContain("Open sign-in");
    expect(markup).toContain('href="https://example.test/oauth"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('placeholder="Paste redirect URL or code"');
    expect(markup).toContain('type="submit"');
  });

  it("renders nothing without an active challenge", () => {
    expect(
      renderToStaticMarkup(
        <OmpLoginChallengePanel
          challenge={null}
          onSubmit={() => undefined}
          onCancel={() => undefined}
        />,
      ),
    ).toBe("");
  });

  it("does not render the browser fallback without a captured authorization URL", () => {
    const markup = renderToStaticMarkup(
      <OmpLoginChallengePanel
        challenge={{
          flowId: "login_claude",
          provider: "anthropic",
          kind: "input",
        }}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(markup).not.toContain("Open sign-in");
  });
});
