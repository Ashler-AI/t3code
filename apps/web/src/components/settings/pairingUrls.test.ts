import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  resolveCurrentOriginPairingUrl,
  resolveDesktopPairingUrl,
  resolveHostedPairingUrl,
} from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );

    vi.stubGlobal("window", {});
    expect(resolveCurrentOriginPairingUrl("http://192.168.1.44:3773/settings", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("preserves an environment endpoint path for direct pairing", () => {
    expect(
      resolveDesktopPairingUrl(
        "https://scaffold.example.test/sessions/session-123/agent",
        "PAIRCODE",
      ),
    ).toBe("https://scaffold.example.test/sessions/session-123/agent/pair#token=PAIRCODE");
  });

  it("keeps current-origin pairing under the runtime mount", () => {
    vi.stubGlobal("window", {
      __T3CODE_BASE_PATH__: "/sessions/session-123/agent",
    });

    expect(
      resolveCurrentOriginPairingUrl(
        "https://scaffold.example.test/sessions/session-123/agent/settings/connections",
        "PAIRCODE",
      ),
    ).toBe("https://scaffold.example.test/sessions/session-123/agent/pair#token=PAIRCODE");
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.t3.codes/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });
});
