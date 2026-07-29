import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ScaffoldLifecycleError,
  SessionFabricSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  decodeSessionFabricCapabilityProxyBody,
  isLoopbackHostname,
  resolveDevRedirectUrl,
  scaffoldLifecycleRequestEffect,
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

describe("Scaffold lifecycle HTTP failures", () => {
  it.effect("preserves typed lifecycle failures across the Promise boundary", () => {
    const expected = new ScaffoldLifecycleError({
      reason: "invalid_response",
      message: "Scaffold returned an invalid T3 bootstrap response.",
      status: 502,
      code: "scaffold_invalid_transport",
    });

    return Effect.gen(function* () {
      const observed = yield* Effect.flip(
        scaffoldLifecycleRequestEffect(
          () => Promise.reject(expected),
          () =>
            new ScaffoldLifecycleError({
              reason: "unavailable",
              message: "unexpected",
              status: 503,
              code: "scaffold_unexpected_error",
            }),
        ),
      );

      expect(observed).toBe(expected);
    });
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

  it("accepts the canonical Scaffold and local controller bindings", () => {
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
    expect(
      decodeSessionFabricCapabilityProxyBody({
        role: "controller",
        fabricSessionId,
        environmentKind: "local",
        environmentId: EnvironmentId.make("env_1"),
        threadId: ThreadId.make("thread_1"),
      }),
    ).toEqual({
      role: "controller",
      fabricSessionId,
      environmentKind: "local",
      environmentId: "env_1",
      threadId: "thread_1",
    });
  });

  it("rejects mixed, aliased, and excess controller bindings", () => {
    const fabricSessionId = SessionFabricSessionId.make("global-session-1");
    expect(() =>
      decodeSessionFabricCapabilityProxyBody({
        role: "controller",
        fabricSessionId,
        scaffoldSessionId: "ses_1",
        lifecycleEpoch: 7,
      }),
    ).toThrow();
    expect(() =>
      decodeSessionFabricCapabilityProxyBody({
        role: "controller",
        fabricSessionId,
        environmentKind: "local",
        environmentId: "env_1",
        threadId: "thread_1",
        scaffoldSessionId: "ses_1",
        scaffoldLifecycleEpoch: 7,
      }),
    ).toThrow();
    expect(() =>
      decodeSessionFabricCapabilityProxyBody({
        role: "controller",
        fabricSessionId,
        environmentKind: "local",
        environmentId: "env_1",
        threadId: "thread_1",
        unexpected: true,
      }),
    ).toThrow();
  });
});
