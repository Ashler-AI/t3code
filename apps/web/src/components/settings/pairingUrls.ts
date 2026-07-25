import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";

import { buildHostedPairingUrl } from "../../hostedPairing";
import { setPairingTokenOnUrl } from "../../pairingUrl";
import { resolveRuntimePathname } from "../../runtimeBasePath";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(environmentEndpointUrl(endpointUrl, "/pair"));
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveCurrentOriginPairingUrl(
  currentLocationHref: string,
  credential: string,
): string {
  const url = new URL(resolveRuntimePathname("/pair"), currentLocationHref);
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}
