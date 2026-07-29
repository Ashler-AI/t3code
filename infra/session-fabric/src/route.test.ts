import { describe, expect, it } from "@effect/vitest";

import { resolveSessionFabricRoute } from "./route.ts";

describe("session fabric worker routes", () => {
  it("routes a session stream by global id", () => {
    expect(
      resolveSessionFabricRoute(
        "GET",
        new URL("https://fabric.example/v1/session-fabric/sessions/global%3Asession/connect"),
      ),
    ).toEqual({ type: "session", sessionId: "global:session" });
  });

  it("routes session authority reads to the session Durable Object", () => {
    expect(
      resolveSessionFabricRoute(
        "GET",
        new URL("https://fabric.example/v1/session-fabric/sessions/global%3Asession/authority"),
      ),
    ).toEqual({ type: "session", sessionId: "global:session" });
  });

  it("keeps directory and semantic search routes separate from a session stream", () => {
    expect(
      resolveSessionFabricRoute(
        "GET",
        new URL("https://fabric.example/v1/session-fabric/sessions"),
      ),
    ).toEqual({ type: "directory" });
    expect(
      resolveSessionFabricRoute("POST", new URL("https://fabric.example/v1/session-fabric/search")),
    ).toEqual({ type: "search" });
  });
});
