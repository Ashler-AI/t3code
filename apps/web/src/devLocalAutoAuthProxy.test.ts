import { describe, expect, it, vi } from "vite-plus/test";

import {
  createLocalDevAutoAuthMiddleware,
  LOCAL_DEV_AUTO_AUTH_HEADER,
  LOCAL_DEV_AUTO_AUTH_PATH,
  resolveLocalDevAutoAuthConfig,
} from "./devLocalAutoAuthProxy";

const combinedEnv = {
  T3CODE_LOCAL_DEV_AUTO_AUTH: "1",
  T3CODE_LOCAL_DEV_BOOTSTRAP_TOKEN: "internal-secret",
  T3CODE_MODE: "web",
  T3CODE_HOST: "127.0.0.1",
  VITE_HTTP_URL: "http://localhost:13773",
  VITE_DEV_SERVER_URL: "http://localhost:5733",
  PORT: "5733",
} as const;

type Middleware = ReturnType<typeof createLocalDevAutoAuthMiddleware>;

function createTestMiddleware(fetch: typeof globalThis.fetch): Middleware {
  const config = resolveLocalDevAutoAuthConfig(combinedEnv);
  if (!config) throw new Error("Expected combined dev config.");
  return createLocalDevAutoAuthMiddleware({ config, fetch });
}

function invokeMiddleware(input: {
  readonly bootstrapHeader?: string | null;
  readonly origin?: string;
  readonly host?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly middleware?: Middleware;
  readonly method?: string;
  readonly remoteAddress?: string;
  readonly secFetchSite?: string | null;
  readonly url?: string;
}) {
  return new Promise<{
    readonly statusCode: number;
    readonly headers: Readonly<Record<string, string | ReadonlyArray<string>>>;
    readonly nextCalled: boolean;
  }>((resolve) => {
    const headers: Record<string, string | ReadonlyArray<string>> = {};
    let nextCalled = false;
    const requestHeaders: Record<string, string> = {
      host: input.host ?? "localhost:5733",
      origin: input.origin ?? "http://localhost:5733",
    };
    if (input.secFetchSite !== null) {
      requestHeaders["sec-fetch-site"] = input.secFetchSite ?? "same-origin";
    }
    if (input.bootstrapHeader !== null) {
      requestHeaders[LOCAL_DEV_AUTO_AUTH_HEADER] = input.bootstrapHeader ?? "1";
    }
    const request = {
      method: input.method ?? "POST",
      url: input.url ?? LOCAL_DEV_AUTO_AUTH_PATH,
      headers: requestHeaders,
      socket: { remoteAddress: input.remoteAddress ?? "127.0.0.1" },
    };
    const response = {
      statusCode: 200,
      setHeader(name: string, value: string | number | ReadonlyArray<string>) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.map(String) : String(value);
        return this;
      },
      end() {
        resolve({ statusCode: this.statusCode, headers, nextCalled });
        return this;
      },
    };
    const middleware = input.middleware ?? createTestMiddleware(input.fetch ?? globalThis.fetch);
    middleware(request, response, () => {
      nextCalled = true;
      resolve({ statusCode: response.statusCode, headers, nextCalled });
    });
  });
}

describe("resolveLocalDevAutoAuthConfig", () => {
  it("enables only the combined loopback runner boundary", () => {
    expect(resolveLocalDevAutoAuthConfig(combinedEnv)).toMatchObject({
      backendUrl: new URL("http://localhost:13773/api/auth/browser-session"),
      bootstrapToken: "internal-secret",
      sessionCookieName: "t3_session_13773",
      webPort: "5733",
    });

    for (const env of [
      { ...combinedEnv, T3CODE_LOCAL_DEV_AUTO_AUTH: undefined },
      { ...combinedEnv, T3CODE_LOCAL_DEV_BOOTSTRAP_TOKEN: undefined },
      { ...combinedEnv, T3CODE_MODE: "desktop" },
      { ...combinedEnv, T3CODE_HOST: "0.0.0.0" },
      { ...combinedEnv, T3CODE_HOST: "127.attacker.example" },
      { ...combinedEnv, VITE_HTTP_URL: "http://dev.example.com:13773" },
      { ...combinedEnv, VITE_DEV_SERVER_URL: "http://127.attacker.example:5733" },
      { ...combinedEnv, VITE_DEV_SERVER_URL: "https://localhost:5733" },
    ]) {
      expect(resolveLocalDevAutoAuthConfig(env)).toBeNull();
    }
  });
});

describe("createLocalDevAutoAuthMiddleware", () => {
  it("exchanges the internal token server-side and forwards only the session cookie", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ credential: "internal-secret" });
      return new Response('{"authenticated":true,"private":"not-forwarded"}', {
        status: 200,
        headers: new Headers([
          ["content-type", "application/json"],
          ["set-cookie", "backend_private=not-forwarded; HttpOnly; Path=/"],
          ["set-cookie", "t3_session_13773=signed-session; HttpOnly; SameSite=Strict; Path=/"],
          ["x-private-backend-header", "not-forwarded"],
        ]),
      });
    });

    const result = await invokeMiddleware({ fetch });

    expect(result).toEqual({
      statusCode: 204,
      headers: {
        "cache-control": "no-store",
        "set-cookie": ["t3_session_13773=signed-session; HttpOnly; SameSite=Strict; Path=/"],
      },
      nextCalled: false,
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://localhost:13773/api/auth/browser-session"),
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
  });

  it("reuses the validated session cookie for sequential clean browsers", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        expect(init.headers).toEqual({ cookie: "t3_session_13773=reusable-session" });
        return new Response(
          JSON.stringify({
            authenticated: true,
            sessionMethod: "browser-session-cookie",
          }),
          { status: 200 },
        );
      }
      return new Response(null, {
        status: 200,
        headers: {
          "set-cookie": "t3_session_13773=reusable-session; HttpOnly; SameSite=Strict; Path=/",
        },
      });
    });
    const middleware = createTestMiddleware(fetch);

    const firstBrowser = await invokeMiddleware({ middleware });
    const secondBrowser = await invokeMiddleware({ middleware });

    expect(firstBrowser.statusCode).toBe(204);
    expect(secondBrowser).toEqual(firstBrowser);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL("http://localhost:13773/api/auth/session"),
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("replaces a cached session after it is revoked", async () => {
    let exchangeCount = 0;
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        expect(init.headers).toEqual({ cookie: "t3_session_13773=revoked-session" });
        return new Response(
          JSON.stringify({
            authenticated: false,
          }),
          { status: 200 },
        );
      }
      exchangeCount += 1;
      return new Response(null, {
        status: 200,
        headers: {
          "set-cookie": `t3_session_13773=${exchangeCount === 1 ? "revoked" : "replacement"}-session; HttpOnly; SameSite=Strict; Path=/`,
        },
      });
    });
    const middleware = createTestMiddleware(fetch);

    const firstBrowser = await invokeMiddleware({ middleware });
    const secondBrowser = await invokeMiddleware({ middleware });

    expect(firstBrowser.headers["set-cookie"]).toEqual([
      "t3_session_13773=revoked-session; HttpOnly; SameSite=Strict; Path=/",
    ]);
    expect(secondBrowser.headers["set-cookie"]).toEqual([
      "t3_session_13773=replacement-session; HttpOnly; SameSite=Strict; Path=/",
    ]);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET", "POST"]);
  });

  it("re-bootstraps after a backend reset invalidates the cached session", async () => {
    let exchangeCount = 0;
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        throw new TypeError("fetch failed: backend connection reset");
      }
      exchangeCount += 1;
      return new Response(null, {
        status: 200,
        headers: {
          "set-cookie": `t3_session_13773=${exchangeCount === 1 ? "before" : "after"}-reset; HttpOnly; SameSite=Strict; Path=/`,
        },
      });
    });
    const middleware = createTestMiddleware(fetch);

    const firstBrowser = await invokeMiddleware({ middleware });
    const secondBrowser = await invokeMiddleware({ middleware });

    expect(firstBrowser.headers["set-cookie"]).toEqual([
      "t3_session_13773=before-reset; HttpOnly; SameSite=Strict; Path=/",
    ]);
    expect(secondBrowser.headers["set-cookie"]).toEqual([
      "t3_session_13773=after-reset; HttpOnly; SameSite=Strict; Path=/",
    ]);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET", "POST"]);
  });

  it("coalesces concurrent first requests into one bootstrap exchange", async () => {
    let resolveExchange: ((response: Response) => void) | undefined;
    const exchange = new Promise<Response>((resolve) => {
      resolveExchange = resolve;
    });
    const fetch = vi.fn(() => exchange);
    const middleware = createTestMiddleware(fetch);

    const firstBrowser = invokeMiddleware({ middleware });
    const secondBrowser = invokeMiddleware({ middleware });

    expect(fetch).toHaveBeenCalledTimes(1);
    resolveExchange?.(
      new Response(null, {
        status: 200,
        headers: {
          "set-cookie": "t3_session_13773=shared-session; HttpOnly; SameSite=Strict; Path=/",
        },
      }),
    );

    await expect(Promise.all([firstBrowser, secondBrowser])).resolves.toEqual([
      {
        statusCode: 204,
        headers: {
          "cache-control": "no-store",
          "set-cookie": ["t3_session_13773=shared-session; HttpOnly; SameSite=Strict; Path=/"],
        },
        nextCalled: false,
      },
      {
        statusCode: 204,
        headers: {
          "cache-control": "no-store",
          "set-cookie": ["t3_session_13773=shared-session; HttpOnly; SameSite=Strict; Path=/"],
        },
        nextCalled: false,
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a successful exchange that omits the expected session cookie", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "set-cookie": "t3_session=signed-for-another-server; HttpOnly; Path=/" },
        }),
    );

    const result = await invokeMiddleware({ fetch });

    expect(result.statusCode).toBe(503);
    expect(result.headers).toEqual({ "cache-control": "no-store" });
  });

  it("rejects cross-origin and non-loopback requests before using the token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const crossOrigin = await invokeMiddleware({
      origin: "http://attacker.example.com",
      fetch,
    });
    const remoteClient = await invokeMiddleware({
      remoteAddress: "192.0.2.10",
      fetch,
    });

    expect(crossOrigin.statusCode).toBe(403);
    expect(remoteClient.statusCode).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong method", { method: "GET" }],
    ["query string", { url: `${LOCAL_DEV_AUTO_AUTH_PATH}?credential=leak` }],
    ["Host mismatch", { host: "127.0.0.1:5733" }],
    ["missing fetch metadata", { secFetchSite: null }],
    ["missing custom header", { bootstrapHeader: null }],
  ] as const)("rejects %s before using the token", async (_label, overrides) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const result = await invokeMiddleware({ fetch, ...overrides });

    expect(result.statusCode).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
