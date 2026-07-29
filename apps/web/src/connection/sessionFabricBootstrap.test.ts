import { describe, expect, it } from "@effect/vitest";

import {
  configuredSessionFabricRelayUrl,
  isConfiguredSessionFabricRoute,
  sessionFabricRegistrationFromRoute,
  sessionFabricRoutePath,
} from "./sessionFabricBootstrap";

describe("session fabric route bootstrap", () => {
  it("creates an ephemeral central-session registration from a fresh thread URL", () => {
    const registration = sessionFabricRegistrationFromRoute({
      pathname: "/session-fabric%3Aglobal-session-1/thread-1",
      relayBaseUrl: "https://relay.example/fabric/",
      clientId: "browser-window-2",
    });

    expect(registration?.target.environmentId).toBe("session-fabric:global-session-1");
    expect(registration?.target.sessionId).toBe("global-session-1");
    expect(registration?.target.clientId).toBe("browser-window-2");
    expect(registration?.target.relayBaseUrl).toBe("https://relay.example/fabric/");
  });

  it("creates the same registration beneath a validated Scaffold runtime mount", () => {
    const registration = sessionFabricRegistrationFromRoute({
      pathname: "/sessions/ses_scaffold/agent/session-fabric%3Aglobal-session-1/thread-1",
      runtimeBasePath: "/sessions/ses_scaffold/agent",
      relayBaseUrl: "https://relay.example/fabric/",
      clientId: "browser-window-scaffold",
    });

    expect(registration?.target.environmentId).toBe("session-fabric:global-session-1");
    expect(registration?.target.sessionId).toBe("global-session-1");
  });

  it("builds the selected session route beneath the Scaffold runtime mount", () => {
    expect(
      sessionFabricRoutePath({
        sessionId: "sf:local-environment:thread-1",
        threadId: "thread-1",
        runtimeBasePath: "/sessions/ses_scaffold/agent",
      }),
    ).toBe(
      "/sessions/ses_scaffold/agent/session-fabric%3Asf%3Alocal-environment%3Athread-1/thread-1",
    );
  });

  it("fails closed when the browser path is outside the supplied runtime mount", () => {
    expect(
      sessionFabricRegistrationFromRoute({
        pathname: "/session-fabric%3Aglobal-session-1/thread-1",
        runtimeBasePath: "/sessions/ses_scaffold/agent",
        relayBaseUrl: "https://relay.example/fabric/",
        clientId: "browser-window-scaffold",
      }),
    ).toBeNull();
  });

  it("does not turn an ordinary local route into a fabric connection", () => {
    expect(
      sessionFabricRegistrationFromRoute({
        pathname: "/local-environment/thread-1",
        relayBaseUrl: "https://relay.example/",
        clientId: "browser-window-1",
      }),
    ).toBeNull();
  });

  it("recognizes a configured fabric route without consulting local browser auth", () => {
    expect(
      isConfiguredSessionFabricRoute({
        pathname: "/session-fabric%3Aglobal-session-1/thread-1",
        relayBaseUrl: "https://relay.example/",
      }),
    ).toBe(true);
    expect(
      isConfiguredSessionFabricRoute({
        pathname: "/session-fabric%3Aglobal-session-1/thread-1",
        relayBaseUrl: null,
      }),
    ).toBe(false);
  });

  it("accepts only configured HTTP Relay endpoints", () => {
    expect(configuredSessionFabricRelayUrl(" https://relay.example/base ")).toBe(
      "https://relay.example/base",
    );
    expect(configuredSessionFabricRelayUrl("file:///tmp/fabric")).toBeNull();
    expect(configuredSessionFabricRelayUrl(undefined)).toBeNull();
  });
});
