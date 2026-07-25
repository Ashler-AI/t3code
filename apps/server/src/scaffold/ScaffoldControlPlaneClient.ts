import {
  EnvironmentId,
  type ScaffoldDeployment,
  ScaffoldLifecycleError,
  ScaffoldSessionObservation,
  ScaffoldSessionStatus,
} from "@t3tools/contracts";

import type { ScaffoldTargetConfig } from "./ScaffoldConfig.ts";

export type ScaffoldFetch = (
  input: Request | string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ScaffoldEphemeralTransport {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
  readonly lifecycleEpoch: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bootstrapCredential: string;
  readonly expiresAt: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeCode(value: unknown, fallback: string): string {
  const candidate = stringValue(value);
  return candidate && /^[a-zA-Z0-9_.-]+$/u.test(candidate) ? candidate.slice(0, 96) : fallback;
}

export function parseScaffoldSessionObservation(
  value: unknown,
): ScaffoldSessionObservation | undefined {
  const body = record(value);
  const session = record(body?.session) ?? record(body?.sandbox) ?? body;
  if (!session) return undefined;
  // Scaffold's session resource is keyed by `id`. Do not revive the old
  // prototype's invented `sessionId` response field.
  const sessionId = stringValue(session.id);
  const rawStatus = stringValue(session.status);
  const status =
    rawStatus && ScaffoldSessionStatus.literals.includes(rawStatus as never)
      ? (rawStatus as ScaffoldSessionObservation["status"])
      : undefined;
  const lifecycleEpoch = numberValue(session.lifecycleEpoch) ?? 0;
  if (!sessionId || !status) return undefined;
  const updatedAt = stringValue(session.updatedAt);
  return new ScaffoldSessionObservation({
    sessionId,
    status,
    lifecycleEpoch,
    ...(updatedAt ? { updatedAt } : {}),
  });
}

function validatedEndpoint(value: unknown, protocol: "https:" | "wss:"): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== protocol || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function errorReason(status: number): ScaffoldLifecycleError["reason"] {
  if (status === 0 || status === 408 || status === 429 || status >= 500) return "unavailable";
  if (status === 401 || status === 403) return "authentication";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  return "invalid_response";
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds * 1_000) : undefined;
}

export function makeScaffoldControlPlaneClient(options: {
  readonly target: ScaffoldTargetConfig;
  readonly fetch?: ScaffoldFetch;
  readonly now?: () => number;
}) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const request = async (pathname: string, init: RequestInit = {}) => {
    let response: Response;
    try {
      response = await fetchImpl(new URL(pathname, options.target.baseUrl), {
        ...init,
        headers: {
          accept: "application/json",
          ...(options.target.authorization ? { authorization: options.target.authorization } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new ScaffoldLifecycleError({
        reason: "network",
        message: "Scaffold could not be reached.",
        status: 0,
        code: "scaffold_network_error",
      });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const decoded = record(body);
      const observation = parseScaffoldSessionObservation(body);
      const retry = retryAfterMs(response);
      throw new ScaffoldLifecycleError({
        reason: errorReason(response.status),
        message: "Scaffold lifecycle request failed.",
        status: response.status,
        code: safeCode(decoded?.error, `scaffold_http_${response.status}`),
        ...(retry === undefined ? {} : { retryAfterMs: retry }),
        ...(observation ? { observation } : {}),
      });
    }
    return body;
  };

  const expectObservation = (body: unknown, expectedSessionId?: string) => {
    const observation = parseScaffoldSessionObservation(body);
    if (!observation || (expectedSessionId && observation.sessionId !== expectedSessionId)) {
      throw new ScaffoldLifecycleError({
        reason: "invalid_response",
        message: "Scaffold returned an invalid session response.",
        status: 502,
        code: "scaffold_invalid_response",
      });
    }
    return observation;
  };

  const mutate = async (input: {
    readonly kind: "resume" | "pause";
    readonly sessionId: string;
    readonly operationId: string;
    readonly lifecycleEpoch: number;
  }) =>
    expectObservation(
      await request(
        `${options.target.collectionPath}/${encodeURIComponent(input.sessionId)}/${input.kind}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": input.operationId },
          body: JSON.stringify({ lifecycleEpoch: input.lifecycleEpoch }),
        },
      ),
      input.sessionId,
    );

  return {
    deployment: options.target.deployment as ScaffoldDeployment,
    baseUrl: options.target.baseUrl,
    createSession: async (input: {
      readonly sessionId?: string;
      readonly operationId: string;
      readonly sourceRef?: string;
      readonly snapshotId?: string;
      readonly name?: string;
    }) =>
      expectObservation(
        await request(options.target.collectionPath, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": input.operationId },
          body: JSON.stringify({
            ...(input.sessionId ? { id: input.sessionId } : {}),
            runtimeProfile: "agent_t3_omp",
            origin: { type: "t3" },
            ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
            ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
            ...(input.name ? { name: input.name } : {}),
          }),
        }),
        input.sessionId,
      ),
    getSession: async (sessionId: string) =>
      expectObservation(
        await request(`${options.target.collectionPath}/${encodeURIComponent(sessionId)}`),
        sessionId,
      ),
    resumeSession: (input: Omit<Parameters<typeof mutate>[0], "kind">) =>
      mutate({ ...input, kind: "resume" }),
    pauseSession: (input: Omit<Parameters<typeof mutate>[0], "kind">) =>
      mutate({ ...input, kind: "pause" }),
    issueT3Transport: async (input: {
      readonly environmentId?: EnvironmentId;
      readonly sessionId: string;
      readonly lifecycleEpoch: number;
    }): Promise<ScaffoldEphemeralTransport> => {
      const body = record(
        await request(
          `${options.target.collectionPath}/${encodeURIComponent(input.sessionId)}/t3-transport`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ lifecycleEpoch: input.lifecycleEpoch }),
          },
        ),
      );
      const transport = record(body?.transport) ?? body;
      const environmentId = stringValue(body?.environmentId);
      const sessionId = stringValue(body?.id);
      const lifecycleEpoch = numberValue(body?.lifecycleEpoch);
      const httpBaseUrl = validatedEndpoint(transport?.httpBaseUrl, "https:");
      const wsBaseUrl = validatedEndpoint(transport?.wsBaseUrl, "wss:");
      const bootstrapCredential = stringValue(
        transport?.bootstrapCredential ?? transport?.credential,
      );
      const expiresAt = stringValue(transport?.expiresAt);
      const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
      if (
        !environmentId ||
        (input.environmentId !== undefined && environmentId !== input.environmentId) ||
        sessionId !== input.sessionId ||
        lifecycleEpoch !== input.lifecycleEpoch ||
        !httpBaseUrl ||
        !wsBaseUrl ||
        !bootstrapCredential ||
        !expiresAt ||
        !Number.isFinite(expiresAtMs) ||
        expiresAtMs <= now()
      ) {
        throw new ScaffoldLifecycleError({
          reason: "invalid_response",
          message: "Scaffold returned an invalid T3 bootstrap response.",
          status: 502,
          code: "scaffold_invalid_transport",
        });
      }
      return {
        environmentId: EnvironmentId.make(environmentId),
        sessionId,
        lifecycleEpoch,
        httpBaseUrl,
        wsBaseUrl,
        bootstrapCredential,
        expiresAt,
      };
    },
  };
}

export type ScaffoldControlPlaneClient = ReturnType<typeof makeScaffoldControlPlaneClient>;
