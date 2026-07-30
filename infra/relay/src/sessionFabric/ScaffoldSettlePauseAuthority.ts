import { scaffoldWakeAuthoritySignature } from "./ScaffoldWakeAuthority.ts";

const VERSION = 1 as const;
const DEFAULT_TIMEOUT_MS = 10_000;

export const SCAFFOLD_SETTLE_PAUSE_TIMESTAMP_HEADER =
  "x-ashler-session-fabric-settled-pause-timestamp" as const;
export const SCAFFOLD_SETTLE_PAUSE_SIGNATURE_HEADER =
  "x-ashler-session-fabric-settled-pause-signature" as const;

export interface ScaffoldSettlePauseAuthorityConfigInput {
  readonly endpoint?: string | null;
  readonly sharedSecret?: string | null;
  readonly timeoutMs?: number;
}

export interface ScaffoldSettlePauseAuthorityConfig {
  readonly endpoint: URL;
  readonly sharedSecret: string;
  readonly timeoutMs: number;
}

export interface ScaffoldSettlePauseAuthorityRequest {
  readonly fabricSessionId: string;
  readonly settlementEventId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly scaffoldSessionId: string;
  readonly expectedLifecycleEpoch: number;
}

export interface ScaffoldSettlePauseAuthorityResponse {
  readonly ok: true;
  readonly version: typeof VERSION;
  readonly fabricSessionId: string;
  readonly settlementEventId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly scaffoldSessionId: string;
  readonly expectedLifecycleEpoch: number;
  readonly targetLifecycleEpoch: number;
  readonly outcome: "paused" | "already_inactive" | "superseded";
  readonly deduplicated: boolean;
}

export type ScaffoldSettlePauseAuthorityResult =
  | { readonly ok: true; readonly response: ScaffoldSettlePauseAuthorityResponse }
  | {
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

export class ScaffoldSettlePauseAuthorityConfigError extends Error {
  override readonly name = "ScaffoldSettlePauseAuthorityConfigError";
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function validateScaffoldSettlePauseAuthorityConfig(
  input?: ScaffoldSettlePauseAuthorityConfigInput | null,
): ScaffoldSettlePauseAuthorityConfig | null {
  if (input == null || (input.endpoint == null && input.sharedSecret == null)) return null;
  const endpoint = input.endpoint?.trim() ?? "";
  if (!endpoint)
    throw new ScaffoldSettlePauseAuthorityConfigError(
      "Scaffold settle-pause authority endpoint is required.",
    );
  if (!input.sharedSecret?.trim())
    throw new ScaffoldSettlePauseAuthorityConfigError(
      "Scaffold settle-pause authority shared secret is required.",
    );
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ScaffoldSettlePauseAuthorityConfigError(
      "Scaffold settle-pause authority endpoint must be a valid HTTP(S) URL.",
    );
  }
  if (!(["http:", "https:"] as const).includes(parsed.protocol as "http:" | "https:")) {
    throw new ScaffoldSettlePauseAuthorityConfigError(
      "Scaffold settle-pause authority endpoint must use HTTP or HTTPS.",
    );
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new ScaffoldSettlePauseAuthorityConfigError(
      "Scaffold settle-pause authority endpoint must not contain credentials or a fragment.",
    );
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ScaffoldSettlePauseAuthorityConfigError(
      "Scaffold settle-pause authority timeout must be a positive integer.",
    );
  }
  return { endpoint: parsed, sharedSecret: input.sharedSecret, timeoutMs };
}

function validRequest(input: ScaffoldSettlePauseAuthorityRequest): boolean {
  return (
    nonEmpty(input.fabricSessionId) &&
    nonEmpty(input.settlementEventId) &&
    nonEmpty(input.environmentId) &&
    nonEmpty(input.threadId) &&
    nonEmpty(input.scaffoldSessionId) &&
    Number.isSafeInteger(input.expectedLifecycleEpoch) &&
    input.expectedLifecycleEpoch >= 0 &&
    input.expectedLifecycleEpoch < Number.MAX_SAFE_INTEGER
  );
}

function response(value: unknown): ScaffoldSettlePauseAuthorityResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  return row.ok === true &&
    row.version === VERSION &&
    nonEmpty(row.fabricSessionId) &&
    nonEmpty(row.settlementEventId) &&
    nonEmpty(row.environmentId) &&
    nonEmpty(row.threadId) &&
    nonEmpty(row.scaffoldSessionId) &&
    Number.isSafeInteger(row.expectedLifecycleEpoch) &&
    Number.isSafeInteger(row.targetLifecycleEpoch) &&
    (row.outcome === "paused" ||
      row.outcome === "already_inactive" ||
      row.outcome === "superseded") &&
    typeof row.deduplicated === "boolean"
    ? (row as unknown as ScaffoldSettlePauseAuthorityResponse)
    : null;
}

export async function pauseSettledScaffoldSession(
  config: ScaffoldSettlePauseAuthorityConfig | null,
  input: ScaffoldSettlePauseAuthorityRequest,
  dependencies: {
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
    readonly crypto?: Crypto;
  } = {},
): Promise<ScaffoldSettlePauseAuthorityResult> {
  if (config === null)
    return {
      ok: false,
      classification: "unavailable",
      code: "not_configured",
      message: "Scaffold settle-pause authority is not configured.",
    };
  if (!validRequest(input))
    return {
      ok: false,
      classification: "terminal",
      code: "invalid_request",
      message: "Scaffold settle-pause request is invalid.",
    };
  const rawBody = JSON.stringify({ version: VERSION, ...input });
  const timestamp = String((dependencies.now ?? Date.now)());
  let signature: string;
  try {
    signature = await scaffoldWakeAuthoritySignature({
      sharedSecret: config.sharedSecret,
      timestamp,
      rawBody,
      ...(dependencies.crypto ? { crypto: dependencies.crypto } : {}),
    });
  } catch {
    return {
      ok: false,
      classification: "terminal",
      code: "signing_error",
      message: "Scaffold settle-pause authority request could not be signed.",
    };
  }
  let result: Response;
  try {
    result = await (dependencies.fetch ?? globalThis.fetch)(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SCAFFOLD_SETTLE_PAUSE_TIMESTAMP_HEADER]: timestamp,
        [SCAFFOLD_SETTLE_PAUSE_SIGNATURE_HEADER]: signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === "TimeoutError";
    return {
      ok: false,
      classification: "retryable",
      code: timeout ? "timeout" : "network_error",
      message: timeout
        ? `Scaffold settle-pause authority timed out after ${config.timeoutMs}ms.`
        : "Scaffold settle-pause authority could not be reached.",
    };
  }
  if (!result.ok) {
    const retryable =
      result.status === 408 ||
      result.status === 425 ||
      result.status === 429 ||
      result.status >= 500;
    return {
      ok: false,
      classification: retryable ? "retryable" : "terminal",
      code: retryable ? "retryable_status" : "terminal_status",
      message: `Scaffold settle-pause authority returned HTTP ${result.status}.`,
      status: result.status,
    };
  }
  const decoded = response(await result.json().catch(() => null));
  if (decoded === null)
    return {
      ok: false,
      classification: "terminal",
      code: "invalid_response",
      message: "Scaffold settle-pause authority returned an invalid response.",
    };
  if (
    decoded.fabricSessionId !== input.fabricSessionId ||
    decoded.settlementEventId !== input.settlementEventId ||
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
      message: "Scaffold settle-pause authority response did not match the request.",
    };
  }
  return { ok: true, response: decoded };
}
