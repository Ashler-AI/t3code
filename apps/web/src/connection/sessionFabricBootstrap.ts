import { EnvironmentId, SessionFabricClientId, SessionFabricSessionId } from "@t3tools/contracts";
import {
  SessionFabricConnectionRegistration,
  SessionFabricConnectionTarget,
} from "@t3tools/client-runtime/connection";

const SESSION_FABRIC_ENVIRONMENT_PREFIX = "session-fabric:";

export function sessionFabricRoutePath(input: {
  readonly sessionId: string;
  readonly threadId: string;
  readonly runtimeBasePath?: string;
}): string {
  const runtimeBasePath = (input.runtimeBasePath ?? "").replace(/\/+$/, "");
  const environmentSegment = encodeURIComponent(
    `${SESSION_FABRIC_ENVIRONMENT_PREFIX}${input.sessionId}`,
  );
  return `${runtimeBasePath}/${environmentSegment}/${encodeURIComponent(input.threadId)}`;
}

function pathnameWithinRuntimeBase(pathname: string, runtimeBasePath: string): string | null {
  const normalizedBasePath = runtimeBasePath.replace(/\/+$/, "");
  if (!normalizedBasePath) return pathname;
  if (pathname === normalizedBasePath) return "/";
  return pathname.startsWith(`${normalizedBasePath}/`)
    ? pathname.slice(normalizedBasePath.length)
    : null;
}

function sessionFabricSessionIdFromPathname(
  pathname: string,
  runtimeBasePath: string,
): string | null {
  const routePathname = pathnameWithinRuntimeBase(pathname, runtimeBasePath);
  if (routePathname === null) return null;
  const segments = routePathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  let environmentSegment: string;
  try {
    environmentSegment = decodeURIComponent(segments[0]!);
  } catch {
    return null;
  }
  if (!environmentSegment.startsWith(SESSION_FABRIC_ENVIRONMENT_PREFIX)) return null;

  const sessionId = environmentSegment.slice(SESSION_FABRIC_ENVIRONMENT_PREFIX.length);
  return sessionId || null;
}

export function configuredSessionFabricRelayUrl(value: string | undefined): string | null {
  const configured = value?.trim();
  if (!configured) return null;

  try {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function sessionFabricRegistrationFromRoute(input: {
  readonly pathname: string;
  readonly runtimeBasePath?: string;
  readonly relayBaseUrl: string | null;
  readonly clientId: string;
}): SessionFabricConnectionRegistration | null {
  if (input.relayBaseUrl === null) return null;
  const sessionIdValue = sessionFabricSessionIdFromPathname(
    input.pathname,
    input.runtimeBasePath ?? "",
  );
  if (sessionIdValue === null) return null;
  const sessionId = SessionFabricSessionId.make(sessionIdValue);
  const environmentSegment = `${SESSION_FABRIC_ENVIRONMENT_PREFIX}${sessionIdValue}`;

  return new SessionFabricConnectionRegistration({
    target: new SessionFabricConnectionTarget({
      environmentId: EnvironmentId.make(environmentSegment),
      label: "Shared session",
      relayBaseUrl: input.relayBaseUrl,
      sessionId,
      clientId: SessionFabricClientId.make(input.clientId),
    }),
  });
}

export function isConfiguredSessionFabricRoute(input: {
  readonly pathname: string;
  readonly runtimeBasePath?: string;
  readonly relayBaseUrl: string | null;
}): boolean {
  return (
    input.relayBaseUrl !== null &&
    sessionFabricSessionIdFromPathname(input.pathname, input.runtimeBasePath ?? "") !== null
  );
}
