import { createMemoryHistory, createRootRoute, createRoute } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./routeTree.gen", () => {
  const rootRoute = createRootRoute();
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/general",
  });
  const pairRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/pair",
  });

  return { routeTree: rootRoute.addChildren([settingsRoute, pairRoute]) };
});

import { getRouter } from "./router";

describe("getRouter", () => {
  it("keeps default navigation rooted at the origin", async () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = getRouter(history);

    await router.load();
    await router.navigate({ to: "/pair" });

    expect(history.location.pathname).toBe("/pair");
  });

  it("keeps browser navigation under the runtime base path", async () => {
    const history = createMemoryHistory({
      initialEntries: ["/sessions/session-123/agent/"],
    });
    const router = getRouter(history, "/sessions/session-123/agent");

    await router.load();
    await router.navigate({ to: "/settings/general" });

    expect(router.state.location.pathname).toBe("/settings/general");
    expect(history.location.pathname).toBe("/sessions/session-123/agent/settings/general");
    expect(router.buildLocation({ to: "/pair" }).href).toBe("/sessions/session-123/agent/pair");
  });
});
