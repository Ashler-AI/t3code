declare const __T3CODE_BUILD_SESSION_FABRIC_RELAY_URL__: string | undefined;

const buildSessionFabricRelayUrl =
  typeof __T3CODE_BUILD_SESSION_FABRIC_RELAY_URL__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_SESSION_FABRIC_RELAY_URL__;

function normalizeSessionFabricRelayUrl(value: string | undefined): string | undefined {
  const normalizedValue = value?.trim();
  if (!normalizedValue) return undefined;

  try {
    const url = new URL(normalizedValue);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

export function resolveDesktopSessionFabricRelayUrl(
  runtimeUrl = process.env.T3CODE_SESSION_FABRIC_RELAY_URL,
  buildUrl = buildSessionFabricRelayUrl,
): string | undefined {
  return normalizeSessionFabricRelayUrl(runtimeUrl) ?? normalizeSessionFabricRelayUrl(buildUrl);
}
