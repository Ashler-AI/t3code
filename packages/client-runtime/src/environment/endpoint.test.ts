import { describe, expect, it } from "vite-plus/test";

import {
  classifyHostedHttpsCompatibility,
  createAdvertisedEndpoint,
  deriveWsBaseUrl,
  environmentEndpointUrl,
  environmentWebSocketUrl,
  normalizeHttpBaseUrl,
} from "./endpoint.ts";

const coreProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
} as const;

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });

  it("appends HTTP endpoint paths beneath a non-root environment mount", () => {
    expect(
      environmentEndpointUrl(
        "https://platform.example.test/sessions/session-123/agent/",
        "/.well-known/t3/environment",
      ),
    ).toBe("https://platform.example.test/sessions/session-123/agent/.well-known/t3/environment");
  });

  it("adds the default websocket route only to an origin-level base URL", () => {
    expect(environmentWebSocketUrl("wss://remote.example.test/").toString()).toBe(
      "wss://remote.example.test/ws",
    );
  });

  it.each([
    "wss://agent.example.com/ws/",
    "wss://remote.example.test/custom-socket",
    "wss://platform.example.test/sessions/session-123/agent/ws",
  ])("preserves an explicit websocket route URL: %s", (wsBaseUrl) => {
    expect(environmentWebSocketUrl(wsBaseUrl).toString()).toBe(wsBaseUrl);
  });

  it("marks HTTP endpoints as blocked from hosted HTTPS apps", () => {
    expect(classifyHostedHttpsCompatibility("http://192.168.1.44:3773")).toBe(
      "mixed-content-blocked",
    );
    expect(classifyHostedHttpsCompatibility("https://desktop.example.com", "compatible")).toBe(
      "compatible",
    );
  });

  it("creates provider-neutral endpoint records", () => {
    expect(
      createAdvertisedEndpoint({
        id: "lan:http://192.168.1.44:3773",
        label: "LAN",
        provider: coreProvider,
        httpBaseUrl: "http://192.168.1.44:3773",
        reachability: "lan",
        source: "desktop-core",
        isDefault: true,
      }),
    ).toEqual({
      id: "lan:http://192.168.1.44:3773",
      label: "LAN",
      provider: coreProvider,
      httpBaseUrl: "http://192.168.1.44:3773/",
      wsBaseUrl: "ws://192.168.1.44:3773/",
      reachability: "lan",
      compatibility: {
        hostedHttpsApp: "mixed-content-blocked",
        desktopApp: "compatible",
      },
      source: "desktop-core",
      status: "available",
      isDefault: true,
    });
  });
});
