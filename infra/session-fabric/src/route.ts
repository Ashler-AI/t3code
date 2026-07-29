export type SessionFabricRoute =
  | { readonly type: "health" }
  | { readonly type: "directory" }
  | { readonly type: "search" }
  | { readonly type: "context" }
  | { readonly type: "session"; readonly sessionId: string }
  | { readonly type: "not-found" };

export function resolveSessionFabricRoute(method: string, url: URL): SessionFabricRoute {
  if (method === "GET" && url.pathname === "/health") return { type: "health" };
  if (method === "GET" && url.pathname === "/v1/session-fabric/sessions") {
    return { type: "directory" };
  }
  if (method === "POST" && url.pathname === "/v1/session-fabric/search") {
    return { type: "search" };
  }
  if (method === "POST" && url.pathname === "/v1/session-fabric/context") {
    return { type: "context" };
  }
  if (method === "GET") {
    const match = url.pathname.match(
      /^\/v1\/session-fabric\/sessions\/([^/]+)\/(?:authority|connect|snapshot|events|context)$/,
    );
    const encodedSessionId = match?.[1];
    if (encodedSessionId !== undefined) {
      try {
        return { type: "session", sessionId: decodeURIComponent(encodedSessionId) };
      } catch {
        return { type: "not-found" };
      }
    }
  }
  return { type: "not-found" };
}
