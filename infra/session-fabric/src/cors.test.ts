import { describe, expect, it } from "@effect/vitest";

import {
  resolveSessionFabricCorsOrigin,
  sessionFabricCorsHeaders,
  sessionFabricCorsPreflight,
} from "./cors.ts";

describe("session fabric API CORS", () => {
  const publicRequestUrl = "https://fabric.example/v1/session-fabric/sessions";

  it.each(["http://localhost:6081", "http://127.0.0.1:6081", "http://[::1]:6081"])(
    "allows authenticated loopback HTTP origin %s without port enumeration",
    (origin) => {
      const resolvedOrigin = resolveSessionFabricCorsOrigin({
        requestUrl: publicRequestUrl,
        origin,
        authDisabled: false,
        allowedOrigins: new Set(["https://scaffold.example"]),
      });

      expect(resolvedOrigin).toBe(origin);
      expect(sessionFabricCorsPreflight(resolvedOrigin)).toEqual({
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "authorization,content-type",
          "access-control-max-age": "86400",
          vary: "origin",
        },
      });
      expect(sessionFabricCorsHeaders(origin, "request")).toEqual({
        "access-control-allow-origin": origin,
        "access-control-expose-headers": "content-type",
        vary: "origin",
      });
    },
  );

  it.each([
    "https://localhost:6081",
    "https://127.0.0.1:6081",
    "https://[::1]:6081",
    "http://localhost.example:6081",
    "http://127.0.0.2:6081",
    "http://[::2]:6081",
  ])("rejects non-HTTP or non-loopback origin %s", (origin) => {
    const resolvedOrigin = resolveSessionFabricCorsOrigin({
      requestUrl: publicRequestUrl,
      origin,
      authDisabled: false,
      allowedOrigins: new Set(["https://scaffold.example"]),
    });

    expect(resolvedOrigin).toBeNull();
    expect(sessionFabricCorsPreflight(resolvedOrigin)).toEqual({ status: 403 });
  });

  it("continues to allow exact configured non-loopback origins", () => {
    expect(
      resolveSessionFabricCorsOrigin({
        requestUrl: publicRequestUrl,
        origin: "https://scaffold.example/",
        authDisabled: false,
        allowedOrigins: new Set(["https://scaffold.example"]),
      }),
    ).toBe("https://scaffold.example");
  });

  it("allows loopback origins for an auth-disabled local workerd request", () => {
    expect(
      resolveSessionFabricCorsOrigin({
        requestUrl: "/v1/session-fabric/sessions",
        origin: "http://localhost:5173/",
        authDisabled: true,
        allowedOrigins: new Set(),
      }),
    ).toBe("http://localhost:5173");
  });

  it("rejects loopback origins for an auth-disabled public request", () => {
    expect(
      resolveSessionFabricCorsOrigin({
        requestUrl: publicRequestUrl,
        origin: "http://localhost:5173",
        authDisabled: true,
        allowedOrigins: new Set(),
      }),
    ).toBeNull();
  });
});
