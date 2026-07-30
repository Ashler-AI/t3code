import { isLoopbackSessionFabricRequestUrl } from "@t3tools/shared/sessionFabricCapability";

const resolveLoopbackHttpOrigin = (origin: string): string | null => {
  const normalizedOrigin = origin.replace(/\/+$/gu, "");
  try {
    const url = new URL(normalizedOrigin);
    if (url.protocol !== "http:" || url.origin !== normalizedOrigin) return null;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
      ? normalizedOrigin
      : null;
  } catch {
    return null;
  }
};

export const resolveSessionFabricCorsOrigin = (input: {
  readonly requestUrl: string;
  readonly origin: string | undefined;
  readonly authDisabled: boolean;
  readonly allowedOrigins: ReadonlySet<string>;
}): string | null => {
  if (input.origin === undefined) return null;
  const loopbackOrigin = resolveLoopbackHttpOrigin(input.origin);
  if (input.authDisabled) {
    if (!isLoopbackSessionFabricRequestUrl(new URL(input.requestUrl, "http://127.0.0.1").href)) {
      return null;
    }
    return loopbackOrigin;
  }
  if (loopbackOrigin !== null) return loopbackOrigin;
  const origin = input.origin.replace(/\/+$/gu, "");
  return input.allowedOrigins.has(origin) ? origin : null;
};

export const sessionFabricCorsHeaders = (
  origin: string,
  kind: "request" | "preflight",
): Readonly<Record<string, string>> =>
  kind === "preflight"
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "authorization,content-type",
        "access-control-max-age": "86400",
        vary: "origin",
      }
    : {
        "access-control-allow-origin": origin,
        "access-control-expose-headers": "content-type",
        vary: "origin",
      };

export const sessionFabricCorsPreflight = (
  origin: string | null,
):
  | { readonly status: 403 }
  | { readonly status: 204; readonly headers: Readonly<Record<string, string>> } =>
  origin === null
    ? { status: 403 }
    : { status: 204, headers: sessionFabricCorsHeaders(origin, "preflight") };
