import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  normalizeRuntimeBasePath,
  readRuntimeBasePath,
  resolveRuntimePathname,
} from "./runtimeBasePath";

describe("runtimeBasePath", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the default root mount unchanged", () => {
    vi.stubGlobal("window", {});

    expect(readRuntimeBasePath()).toBe("");
    expect(resolveRuntimePathname("/api/auth/session")).toBe("/api/auth/session");
    expect(resolveRuntimePathname("/pair")).toBe("/pair");
    expect(resolveRuntimePathname("/")).toBe("/");
  });

  it("normalizes and applies an injected session mount", () => {
    vi.stubGlobal("window", {
      __T3CODE_BASE_PATH__: "/sessions/session-123/agent/",
    });

    expect(readRuntimeBasePath()).toBe("/sessions/session-123/agent");
    expect(resolveRuntimePathname("/api/auth/session")).toBe(
      "/sessions/session-123/agent/api/auth/session",
    );
    expect(resolveRuntimePathname("/pair")).toBe("/sessions/session-123/agent/pair");
    expect(resolveRuntimePathname("/")).toBe("/sessions/session-123/agent/");
  });

  it.each([
    [undefined, ""],
    ["", ""],
    ["/", ""],
    ["/sessions/session-123/agent", "/sessions/session-123/agent"],
    ["/sessions/session_123/agent/", "/sessions/session_123/agent"],
    ["/sessions/session.v2/~agent///", "/sessions/session.v2/~agent"],
  ])("normalizes the canonical mount %s", (basePath, expected) => {
    expect(normalizeRuntimeBasePath(basePath)).toBe(expected);
  });

  it.each([
    "sessions/session-123/agent",
    "//example.test/agent",
    "/sessions//agent",
    "/sessions/./agent",
    "/sessions/../agent",
    "/sessions\\session-123\\agent",
    "/sessions/session-123/agent?mode=embedded",
    "/sessions/session-123/agent#fragment",
    "/sessions/session-123/agent\u0000",
    "/sessions/session-123/agent\u0009",
    "/sessions/session-123/agent\u000a",
    "/sessions/session-123/agent\u007f",
    "/sessions/session 123/agent",
    "/sessions/sessiön-123/agent",
  ])("rejects an unsafe injected path: %s", (basePath) => {
    expect(() => normalizeRuntimeBasePath(basePath)).toThrow(
      "window.__T3CODE_BASE_PATH__ must be a root-relative URL path.",
    );
  });

  it.each([
    "/sessions/%2e/agent",
    "/sessions/%2E%2E/agent",
    "/sessions/.%2e/agent",
    "/sessions/%2e./agent",
    "/sessions/%252e%252e/agent",
    "/sessions%2fescape/agent",
    "/sessions%2Fescape/agent",
    "/sessions%5cescape/agent",
    "/sessions%5Cescape/agent",
    "/sessions%255cescape/agent",
    "/sessions/%61gent",
  ])("rejects a non-canonical encoded path: %s", (basePath) => {
    expect(() => normalizeRuntimeBasePath(basePath)).toThrow(
      "window.__T3CODE_BASE_PATH__ must be a root-relative URL path.",
    );
  });

  it.each(["/sessions/%/agent", "/sessions/%2/agent", "/sessions/%gg/agent"])(
    "rejects a malformed URL escape: %s",
    (basePath) => {
      expect(() => normalizeRuntimeBasePath(basePath)).toThrow(
        "window.__T3CODE_BASE_PATH__ must be a root-relative URL path.",
      );
    },
  );
});
