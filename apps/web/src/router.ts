import { createRouter, RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory, basepath = "/") {
  return createRouter({
    routeTree,
    history,
    basepath,
    context: {},
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
