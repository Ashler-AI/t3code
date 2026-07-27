import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  SessionFabricSessionId,
} from "@t3tools/contracts";
import { describe } from "vite-plus/test";

import {
  decodeSessionFabricCapabilityProxyBody,
  isLoopbackHostname,
  resolveDevRedirectUrl,
  scaffoldRuntimeTokenMatches,
  sessionFabricCapabilityProxyScope,
} from "./http.ts";

describe("Scaffold supervisor authentication", () => {
  it("accepts only the exact non-empty process-local runtime token", () => {
    expect(scaffoldRuntimeTokenMatches("local-secret", "local-secret")).toBe(true);
    expect(scaffoldRuntimeTokenMatches("local-secreu", "local-secret")).toBe(false);
    expect(scaffoldRuntimeTokenMatches("local-secret-extra", "local-secret")).toBe(false);
    expect(scaffoldRuntimeTokenMatches(undefined, "local-secret")).toBe(false);
    expect(scaffoldRuntimeTokenMatches("", "")).toBe(false);
  });
});

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("session fabric capability proxy", () => {
  it("allows any authenticated environment reader to acquire viewer authority", () => {
    expect(sessionFabricCapabilityProxyScope("viewer")).toBe(AuthOrchestrationReadScope);
  });

  it("requires environment operate authority before acquiring controller authority", () => {
    expect(sessionFabricCapabilityProxyScope("controller")).toBe(AuthOrchestrationOperateScope);
  });

  it("accepts only the canonical Scaffold lifecycle binding in controller bodies", () => {
    const fabricSessionId = SessionFabricSessionId.make("global-session-1");
    expect(
      decodeSessionFabricCapabilityProxyBody({
        role: "controller",
        fabricSessionId,
        scaffoldSessionId: "ses_1",
        scaffoldLifecycleEpoch: 7,
      }),
    ).toEqual({
      role: "controller",
      fabricSessionId,
      scaffoldSessionId: "ses_1",
      scaffoldLifecycleEpoch: 7,
    });
    expect(() =>
      decodeSessionFabricCapabilityProxyBody({
        role: "controller",
        fabricSessionId,
        scaffoldSessionId: "ses_1",
        lifecycleEpoch: 7,
      }),
    ).toThrow();
  });
});
