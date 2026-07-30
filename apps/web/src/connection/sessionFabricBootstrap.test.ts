import { describe, expect, it } from "@effect/vitest";

import {
  configuredSessionFabricRelayUrl,
  isConfiguredSessionFabricRoute,
  notifySessionFabricRouteChanged,
  sessionFabricRegistrationFromRoute,
  sessionFabricRoutePath,
  shouldAwaitSessionFabricRouteRegistration,
  subscribeSessionFabricRouteChanges,
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

  it("fails closed when the browser path belongs to a different Scaffold mount", () => {
    expect(
      sessionFabricRegistrationFromRoute({
        pathname: "/sessions/ses_other/agent/session-fabric%3Aglobal-session-1/thread-1",
        runtimeBasePath: "/sessions/ses_scaffold/agent",
        relayBaseUrl: "https://relay.example/fabric/",
        clientId: "browser-window-scaffold",
      }),
    ).toBeNull();
  });

  it("notifies route-derived connection subscribers after SPA navigation", () => {
    const eventTarget = new EventTarget();
    let changes = 0;
    const unsubscribe = subscribeSessionFabricRouteChanges({
      eventTarget,
      onChange: () => {
        changes += 1;
      },
    });

    notifySessionFabricRouteChanged(eventTarget);
    expect(changes).toBe(1);
    unsubscribe();
    notifySessionFabricRouteChanged(eventTarget);
    expect(changes).toBe(1);
  });

  it("waits for reactive registration only on a valid unregistered fabric route", () => {
    const route = {
      pathname: "/sessions/ses_scaffold/agent/session-fabric%3Aglobal-session-1/thread-1",
      runtimeBasePath: "/sessions/ses_scaffold/agent",
      relayBaseUrl: "https://relay.example/fabric/",
    } as const;

    expect(
      shouldAwaitSessionFabricRouteRegistration({
        ...route,
        routeEnvironmentRegistered: false,
      }),
    ).toBe(true);
    expect(
      shouldAwaitSessionFabricRouteRegistration({
        ...route,
        routeEnvironmentRegistered: true,
      }),
    ).toBe(false);
    expect(
      shouldAwaitSessionFabricRouteRegistration({
        ...route,
        runtimeBasePath: "/sessions/ses_other/agent",
        routeEnvironmentRegistered: false,
      }),
    ).toBe(false);
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

  it("accepts clean HTTPS origins and explicit loopback HTTP development origins", () => {
    expect(configuredSessionFabricRelayUrl(" https://relay.example/// ")).toBe(
      "https://relay.example",
    );
    expect(configuredSessionFabricRelayUrl("http://localhost:8788///")).toBe(
      "http://localhost:8788",
    );
    expect(configuredSessionFabricRelayUrl("http://127.0.0.1:8788/")).toBe("http://127.0.0.1:8788");
    expect(configuredSessionFabricRelayUrl("http://[::1]:8788/")).toBe("http://[::1]:8788");
    expect(configuredSessionFabricRelayUrl(undefined)).toBeNull();
  });

  it.each([
    "file:///tmp/fabric",
    "http://relay.example",
    "http://localhost:8788/path",
    "http://localhost:8788?query=value",
    "http://localhost:8788#fragment",
    "http://user:password@localhost:8788",
    "http://127.1:8788",
    "http://0177.0.0.1:8788",
    "https://relay.example/path",
    "https://relay.example?query=value",
    "https://relay.example#fragment",
    "https://user:password@relay.example",
  ])("rejects unsafe session fabric relay URL %s", (value) => {
    expect(configuredSessionFabricRelayUrl(value)).toBeNull();
  });
});
