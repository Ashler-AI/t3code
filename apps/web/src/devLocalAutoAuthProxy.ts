export const LOCAL_DEV_AUTO_AUTH_PATH = "/__t3/local-dev/browser-session";
export const LOCAL_DEV_AUTO_AUTH_HEADER = "x-t3-local-dev-bootstrap";

type Fetch = typeof globalThis.fetch;

export interface LocalDevAutoAuthRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly socket: { readonly remoteAddress?: string };
}

export interface LocalDevAutoAuthResponse {
  statusCode: number;
  setHeader(name: string, value: string | number | ReadonlyArray<string>): unknown;
  end(): unknown;
}

export interface LocalDevAutoAuthConfig {
  readonly backendUrl: URL;
  readonly bootstrapToken: string;
  readonly sessionCookieName: string;
  readonly webPort: string;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  const octets = normalized.split(".");
  const isIpv4Loopback =
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255);
  return normalized === "localhost" || normalized === "::1" || isIpv4Loopback;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  return normalized === "::1" || normalized.startsWith("127.");
}

function singleHeader(value: string | ReadonlyArray<string> | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function resolveLocalDevAutoAuthConfig(
  env: Readonly<Record<string, string | undefined>>,
): LocalDevAutoAuthConfig | null {
  const bootstrapToken = env.T3CODE_LOCAL_DEV_BOOTSTRAP_TOKEN?.trim();
  const backendValue = env.VITE_HTTP_URL?.trim();
  const webValue = env.VITE_DEV_SERVER_URL?.trim();
  const webPort = env.PORT?.trim();
  if (
    env.T3CODE_LOCAL_DEV_AUTO_AUTH !== "1" ||
    env.T3CODE_MODE !== "web" ||
    !bootstrapToken ||
    !backendValue ||
    !webValue ||
    !webPort
  ) {
    return null;
  }

  try {
    const backendUrl = new URL(backendValue);
    const webUrl = new URL(webValue);
    const configuredHost = env.HOST?.trim();
    const configuredBackendHost = env.T3CODE_HOST?.trim();
    if (
      backendUrl.protocol !== "http:" ||
      webUrl.protocol !== "http:" ||
      !isLoopbackHostname(backendUrl.hostname) ||
      !isLoopbackHostname(webUrl.hostname) ||
      webUrl.port !== webPort ||
      (configuredHost !== undefined && !isLoopbackHostname(configuredHost)) ||
      (configuredBackendHost !== undefined && !isLoopbackHostname(configuredBackendHost))
    ) {
      return null;
    }
    backendUrl.pathname = "/api/auth/browser-session";
    backendUrl.search = "";
    backendUrl.hash = "";
    const backendPort = backendUrl.port || "80";
    return {
      backendUrl,
      bootstrapToken,
      sessionCookieName: `t3_session_${backendPort}`,
      webPort,
    };
  } catch {
    return null;
  }
}

function readSetCookies(headers: Headers): ReadonlyArray<string> {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => Array<string> }).getSetCookie;
  if (typeof getSetCookie === "function") {
    return getSetCookie.call(headers);
  }
  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

function setCookieName(cookie: string): string | undefined {
  const pair = cookie.split(";", 1)[0];
  if (!pair) return undefined;
  const separator = pair.indexOf("=");
  if (separator <= 0) return undefined;
  return pair.slice(0, separator).trim();
}

function cookieRequestHeader(cookie: string): string | undefined {
  const pair = cookie.split(";", 1)[0]?.trim();
  return pair && pair.includes("=") ? pair : undefined;
}

function isAuthenticatedBrowserSession(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "authenticated" in value &&
    value.authenticated === true &&
    "sessionMethod" in value &&
    value.sessionMethod === "browser-session-cookie"
  );
}

function reject(response: LocalDevAutoAuthResponse, statusCode: number): void {
  response.statusCode = statusCode;
  response.setHeader("cache-control", "no-store");
  response.end();
}

export function createLocalDevAutoAuthMiddleware(input: {
  readonly config: LocalDevAutoAuthConfig;
  readonly fetch?: Fetch;
}): (
  request: LocalDevAutoAuthRequest,
  response: LocalDevAutoAuthResponse,
  next: () => void,
) => void {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  let sessionCookie: string | undefined;
  let pendingSessionCookie: Promise<string | undefined> | undefined;

  const sessionUrl = new URL(input.config.backendUrl);
  sessionUrl.pathname = "/api/auth/session";

  const validateSessionCookie = async (cookie: string): Promise<boolean> => {
    const cookieHeader = cookieRequestHeader(cookie);
    if (!cookieHeader) return false;

    try {
      const backendResponse = await fetchImpl(sessionUrl, {
        method: "GET",
        headers: { cookie: cookieHeader },
        redirect: "error",
      });
      if (!backendResponse.ok) return false;
      return isAuthenticatedBrowserSession(await backendResponse.json());
    } catch {
      return false;
    }
  };

  const exchangeBootstrapToken = async (): Promise<string | undefined> => {
    const backendResponse = await fetchImpl(input.config.backendUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: input.config.bootstrapToken }),
      redirect: "error",
    });
    const sessionCookies = readSetCookies(backendResponse.headers).filter(
      (cookie) => setCookieName(cookie) === input.config.sessionCookieName,
    );
    if (!backendResponse.ok || sessionCookies.length !== 1) {
      return undefined;
    }
    sessionCookie = sessionCookies[0];
    return sessionCookie;
  };

  const resolveSessionCookie = async (): Promise<string | undefined> => {
    const cachedCookie = sessionCookie;
    if (cachedCookie !== undefined) {
      if (await validateSessionCookie(cachedCookie)) {
        return cachedCookie;
      }
      if (sessionCookie === cachedCookie) {
        sessionCookie = undefined;
      }
    }
    return exchangeBootstrapToken();
  };

  const getSessionCookie = (): Promise<string | undefined> => {
    if (pendingSessionCookie === undefined) {
      pendingSessionCookie = resolveSessionCookie().finally(() => {
        pendingSessionCookie = undefined;
      });
    }
    return pendingSessionCookie;
  };

  return (request, response, next) => {
    const requestUrl = new URL(request.url ?? "/", "http://local-dev.invalid");
    if (requestUrl.pathname !== LOCAL_DEV_AUTO_AUTH_PATH) {
      next();
      return;
    }

    const originValue = singleHeader(request.headers.origin);
    const hostValue = singleHeader(request.headers.host);
    let origin: URL;
    try {
      origin = new URL(originValue ?? "invalid:");
    } catch {
      reject(response, 403);
      return;
    }
    const sameOriginHost = hostValue !== undefined && origin.host === hostValue;
    if (
      request.method !== "POST" ||
      requestUrl.search !== "" ||
      origin.protocol !== "http:" ||
      !isLoopbackHostname(origin.hostname) ||
      origin.port !== input.config.webPort ||
      !sameOriginHost ||
      singleHeader(request.headers["sec-fetch-site"]) !== "same-origin" ||
      singleHeader(request.headers[LOCAL_DEV_AUTO_AUTH_HEADER]) !== "1" ||
      !isLoopbackAddress(request.socket.remoteAddress)
    ) {
      reject(response, 403);
      return;
    }

    void getSessionCookie()
      .then((cookie) => {
        if (cookie === undefined) {
          reject(response, 503);
          return;
        }
        response.statusCode = 204;
        response.setHeader("cache-control", "no-store");
        response.setHeader("set-cookie", [cookie]);
        response.end();
      })
      .catch(() => reject(response, 503));
  };
}
