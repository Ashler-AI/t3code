import { describe, expect, it } from "@effect/vitest";

import {
  configuredSessionFabricRelayUrl,
  isConfiguredSessionFabricRoute,
  sessionFabricRegistrationFromRoute,
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
