const REQUEST_VERSION = "scaffold.session_fabric.wake.v1" as const;
const RESPONSE_VERSION = "scaffold.session_fabric.wake_result.v1" as const;
const DEFAULT_TIMEOUT_MS = 10_000;

export const SCAFFOLD_WAKE_TIMESTAMP_HEADER = "x-ashler-session-fabric-wake-timestamp" as const;
export const SCAFFOLD_WAKE_SIGNATURE_HEADER = "x-ashler-session-fabric-wake-signature" as const;

export interface ScaffoldWakeAuthorityConfigInput {
  readonly endpoint?: string | null;
  readonly sharedSecret?: string | null;
  readonly timeoutMs?: number;
}

export interface ScaffoldWakeAuthorityConfig {
  readonly endpoint: URL;
  readonly sharedSecret: string;
  readonly timeoutMs: number;
}

export interface ScaffoldWakeAuthorityRequest {
  readonly fabricSessionId: string;
  readonly commandId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly scaffoldSessionId: string;
  readonly expectedLifecycleEpoch: number;
  readonly actorId: string;
}

export interface ScaffoldWakeAuthorityResponse {
  readonly ok: true;
  readonly version: typeof RESPONSE_VERSION;
  readonly fabricSessionId: string;
  readonly commandId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly scaffoldSessionId: string;
  readonly expectedLifecycleEpoch: number;
  readonly targetLifecycleEpoch: number;
  readonly status: "resuming" | "ready" | "agent_running";
  readonly deduplicated: boolean;
}

export type ScaffoldWakeAuthorityFailure = {
  readonly ok: false;
  readonly classification: "unavailable" | "retryable" | "terminal";
  readonly code:
    | "not_configured"
    | "signing_error"
    | "timeout"
    | "network_error"
    | "retryable_status"
    | "terminal_status"
    | "invalid_request"
    | "invalid_response"
    | "response_mismatch";
  readonly message: string;
  readonly status?: number;
};

export type ScaffoldWakeAuthorityResult =
  | { readonly ok: true; readonly response: ScaffoldWakeAuthorityResponse }
  | ScaffoldWakeAuthorityFailure;

export interface ScaffoldWakeAuthorityDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly crypto?: Crypto;
}

export class ScaffoldWakeAuthorityConfigError extends Error {
  override readonly name = "ScaffoldWakeAuthorityConfigError";
}

function configError(message: string): never {
  throw new ScaffoldWakeAuthorityConfigError(message);
}

export function validateScaffoldWakeAuthorityConfig(
  input?: ScaffoldWakeAuthorityConfigInput | null,
): ScaffoldWakeAuthorityConfig | null {
  if (input === undefined || input === null) return null;
  if (input.endpoint == null && input.sharedSecret == null) return null;
  const endpoint = input?.endpoint?.trim() ?? "";
  const sharedSecret = input?.sharedSecret ?? "";
  if (endpoint.length === 0) configError("Scaffold wake authority endpoint is required.");
  if (sharedSecret.trim().length === 0) {
    configError("Scaffold wake authority shared secret is required.");
  }

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    configError("Scaffold wake authority endpoint must be a valid HTTP(S) URL.");
  }
  if (parsedEndpoint.protocol !== "http:" && parsedEndpoint.protocol !== "https:") {
    configError("Scaffold wake authority endpoint must use HTTP or HTTPS.");
  }
  if (parsedEndpoint.username !== "" || parsedEndpoint.password !== "") {
    configError("Scaffold wake authority endpoint must not contain credentials.");
  }
  if (parsedEndpoint.hash !== "") {
    configError("Scaffold wake authority endpoint must not contain a fragment.");
  }

  const timeoutMs = input?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    configError("Scaffold wake authority timeout must be a positive integer.");
  }
  return { endpoint: parsedEndpoint, sharedSecret, timeoutMs };
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function scaffoldWakeAuthoritySignature(input: {
  readonly sharedSecret: string;
  readonly timestamp: string;
  readonly rawBody: string;
  readonly crypto?: Crypto;
}): Promise<string> {
  const crypto = input.crypto ?? globalThis.crypto;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.sharedSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${input.timestamp}.${input.rawBody}`)),
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validRequest(input: ScaffoldWakeAuthorityRequest): boolean {
  return (
    nonEmptyString(input.fabricSessionId) &&
    nonEmptyString(input.commandId) &&
    nonEmptyString(input.environmentId) &&
    nonEmptyString(input.threadId) &&
    nonEmptyString(input.scaffoldSessionId) &&
    Number.isSafeInteger(input.expectedLifecycleEpoch) &&
    input.expectedLifecycleEpoch >= 0 &&
    input.expectedLifecycleEpoch < Number.MAX_SAFE_INTEGER &&
    nonEmptyString(input.actorId)
  );
}

function isResponse(value: unknown): value is ScaffoldWakeAuthorityResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return (
    response.ok === true &&
    response.version === RESPONSE_VERSION &&
    nonEmptyString(response.fabricSessionId) &&
    nonEmptyString(response.commandId) &&
    nonEmptyString(response.environmentId) &&
    nonEmptyString(response.threadId) &&
    nonEmptyString(response.scaffoldSessionId) &&
    Number.isSafeInteger(response.expectedLifecycleEpoch) &&
    Number.isSafeInteger(response.targetLifecycleEpoch) &&
    (response.status === "resuming" ||
      response.status === "ready" ||
      response.status === "agent_running") &&
    typeof response.deduplicated === "boolean"
  );
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export async function wakeScaffoldSession(
  config: ScaffoldWakeAuthorityConfig | null,
  input: ScaffoldWakeAuthorityRequest,
  dependencies: ScaffoldWakeAuthorityDependencies = {},
): Promise<ScaffoldWakeAuthorityResult> {
  if (config === null) {
    return {
      ok: false,
      classification: "unavailable",
      code: "not_configured",
      message: "Scaffold wake authority is not configured.",
    };
  }
  if (!validRequest(input)) {
    return {
      ok: false,
      classification: "terminal",
      code: "invalid_request",
      message: "Scaffold wake request is invalid.",
    };
  }

  const rawBody = JSON.stringify({ version: REQUEST_VERSION, ...input });
  const timestamp = String((dependencies.now ?? Date.now)());
  let signature: string;
  try {
    signature = await scaffoldWakeAuthoritySignature({
      sharedSecret: config.sharedSecret,
      timestamp,
      rawBody,
      ...(dependencies.crypto === undefined ? {} : { crypto: dependencies.crypto }),
    });
  } catch {
    return {
      ok: false,
      classification: "terminal",
      code: "signing_error",
      message: "Scaffold wake authority request could not be signed.",
    };
  }
  const controller = new AbortController();
  let didTimeout = false;
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  let rejectTimeout: (reason?: unknown) => void = () => undefined;
  const onTimeout = () => {
    didTimeout = true;
    controller.abort();
    rejectTimeout(new Error("Scaffold wake authority request timed out."));
  };
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  timeoutSignal.addEventListener("abort", onTimeout, { once: true });

  let response: Response;
  let responseBody: string | null;
  try {
    ({ response, responseBody } = await Promise.race([
      (async () => {
        const response = await (dependencies.fetch ?? globalThis.fetch)(config.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SCAFFOLD_WAKE_TIMESTAMP_HEADER]: timestamp,
            [SCAFFOLD_WAKE_SIGNATURE_HEADER]: signature,
          },
          body: rawBody,
          signal: controller.signal,
        });
        return { response, responseBody: response.ok ? await response.text() : null };
      })(),
      timeout,
    ]));
  } catch {
    return didTimeout
      ? {
          ok: false,
          classification: "retryable",
          code: "timeout",
          message: `Scaffold wake authority timed out after ${config.timeoutMs}ms.`,
        }
      : {
          ok: false,
          classification: "retryable",
          code: "network_error",
          message: "Scaffold wake authority could not be reached.",
        };
  } finally {
    timeoutSignal.removeEventListener("abort", onTimeout);
  }

  if (!response.ok) {
    const retryable = retryableStatus(response.status);
    return {
      ok: false,
      classification: retryable ? "retryable" : "terminal",
      code: retryable ? "retryable_status" : "terminal_status",
      message: `Scaffold wake authority returned HTTP ${response.status}.`,
      status: response.status,
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(responseBody ?? "");
  } catch {
    return {
      ok: false,
      classification: "terminal",
      code: "invalid_response",
      message: "Scaffold wake authority returned an invalid response.",
    };
  }
  if (!isResponse(decoded)) {
    return {
      ok: false,
      classification: "terminal",
      code: "invalid_response",
      message: "Scaffold wake authority returned an invalid response.",
    };
  }
  if (
    decoded.fabricSessionId !== input.fabricSessionId ||
    decoded.commandId !== input.commandId ||
    decoded.environmentId !== input.environmentId ||
    decoded.threadId !== input.threadId ||
    decoded.scaffoldSessionId !== input.scaffoldSessionId ||
    decoded.expectedLifecycleEpoch !== input.expectedLifecycleEpoch ||
    decoded.targetLifecycleEpoch !== input.expectedLifecycleEpoch + 1
  ) {
    return {
      ok: false,
      classification: "terminal",
      code: "response_mismatch",
      message: "Scaffold wake authority response did not match the request.",
    };
  }
  return { ok: true, response: decoded };
}
