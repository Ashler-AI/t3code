import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  type ScaffoldDeployment,
  type ScaffoldSessionObservation,
  ScaffoldSessionStatus,
  type ScaffoldT3TransportGrant,
  normalizeScaffoldControlPlaneBaseUrl,
} from "./model.ts";

export type ScaffoldFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ScaffoldControlPlaneError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | undefined;
  readonly observation: ScaffoldSessionObservation | undefined;

  constructor(input: {
    readonly message: string;
    readonly status: number;
    readonly code: string;
    readonly retryAfterMs?: number;
    readonly observation?: ScaffoldSessionObservation;
  }) {
    super(input.message);
    this.name = "ScaffoldControlPlaneError";
    this.status = input.status;
    this.code = input.code;
    this.retryAfterMs = input.retryAfterMs;
    this.observation = input.observation;
  }
}

export interface ScaffoldControlPlaneClientOptions {
  readonly deployment: ScaffoldDeployment;
  readonly baseUrl: string;
  readonly fetch?: ScaffoldFetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly now?: () => number;
}

export interface ScaffoldCreateSessionInput {
  readonly sessionId: string;
  readonly operationId: string;
  readonly sourceRef?: string;
  readonly snapshotId?: string;
  readonly name?: string;
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

function errorCode(value: unknown, fallback: string): string {
  const candidate = stringValue(value);
  return candidate && /^[a-zA-Z0-9_.-]+$/.test(candidate) ? candidate.slice(0, 96) : fallback;
}

export function parseScaffoldSessionObservation(
  value: unknown,
): ScaffoldSessionObservation | undefined {
  const body = record(value);
  if (!body) return undefined;
  const session = record(body.session) ?? body;
  const sessionId = stringValue(session.sessionId);
  const rawStatus = stringValue(session.status);
  const status =
    rawStatus && ScaffoldSessionStatus.literals.includes(rawStatus as never)
      ? (rawStatus as ScaffoldSessionStatus)
      : undefined;
  const lifecycleEpoch = numberValue(session.lifecycleEpoch);
  if (!sessionId || !status || lifecycleEpoch === undefined) return undefined;
  const updatedAt = stringValue(session.updatedAt);
  const parsedErrorCode = stringValue(body.error)
    ? errorCode(body.error, "scaffold_error")
    : undefined;
  return {
    sessionId,
    status,
    lifecycleEpoch,
    ...(updatedAt ? { updatedAt } : {}),
    ...(parsedErrorCode ? { errorCode: parsedErrorCode } : {}),
  };
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Option.map(DateTime.make(raw), DateTime.toEpochMillis);
  return Option.isSome(date)
    ? Math.max(0, date.value - DateTime.toEpochMillis(DateTime.nowUnsafe()))
    : undefined;
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

function transportGrant(
  value: unknown,
  expected: {
    readonly environmentId: EnvironmentId;
    readonly sessionId: string;
    readonly lifecycleEpoch: number;
    readonly nowMs: number;
  },
): ScaffoldT3TransportGrant {
  const body = record(value);
  const transport = record(body?.transport) ?? body;
  const environmentId = stringValue(body?.environmentId);
  const sessionId = stringValue(body?.sessionId);
  const lifecycleEpoch = numberValue(body?.lifecycleEpoch);
  const httpBaseUrl = validatedEndpoint(transport?.httpBaseUrl, "https:");
  const wsBaseUrl = validatedEndpoint(transport?.wsBaseUrl, "wss:");
  const token = stringValue(transport?.token);
  const expiresAt = stringValue(transport?.expiresAt);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (
    !environmentId ||
    !sessionId ||
    lifecycleEpoch === undefined ||
    !httpBaseUrl ||
    !wsBaseUrl ||
    !token ||
    !expiresAt ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= expected.nowMs ||
    environmentId !== expected.environmentId ||
    sessionId !== expected.sessionId ||
    lifecycleEpoch !== expected.lifecycleEpoch
  ) {
    throw new Error("Scaffold returned an invalid T3 transport grant.");
  }
  return {
    environmentId: EnvironmentId.make(environmentId),
    sessionId,
    lifecycleEpoch,
    httpBaseUrl,
    wsBaseUrl,
    token,
    expiresAt,
  };
}

export function makeScaffoldControlPlaneClient(options: ScaffoldControlPlaneClientOptions) {
  const baseUrl = normalizeScaffoldControlPlaneBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const protocolError = () =>
    new ScaffoldControlPlaneError({
      message: "Scaffold returned an invalid response.",
      status: 502,
      code: "scaffold_invalid_response",
    });
  const request = async (
    pathname: string,
    init: RequestInit,
  ): Promise<{ readonly response: Response; readonly body: unknown }> => {
    let response: Response;
    try {
      response = await fetchImpl(new URL(pathname, baseUrl), {
        credentials: "include",
        ...init,
        headers: {
          accept: "application/json",
          ...options.headers,
          ...init.headers,
        },
      });
    } catch {
      throw new ScaffoldControlPlaneError({
        message: "Scaffold request could not be completed.",
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
      const sandbox = record(decoded?.sandbox);
      const fallbackCode = `scaffold_http_${response.status}`;
      const code = errorCode(decoded?.error ?? sandbox?.error, fallbackCode);
      const parsedRetryAfterMs = retryAfterMs(response);
      const parsedObservation = parseScaffoldSessionObservation(body);
      throw new ScaffoldControlPlaneError({
        message: "Scaffold request failed.",
        status: response.status,
        code,
        ...(parsedRetryAfterMs !== undefined ? { retryAfterMs: parsedRetryAfterMs } : {}),
        ...(parsedObservation ? { observation: parsedObservation } : {}),
      });
    }
    return { response, body };
  };

  const getSession = async (sessionId: string): Promise<ScaffoldSessionObservation> => {
    const { body } = await request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET",
    });
    const observation = parseScaffoldSessionObservation(body);
    if (!observation || observation.sessionId !== sessionId) throw protocolError();
    return observation;
  };

  const lifecycle = async (input: {
    readonly kind: "resume" | "pause";
    readonly sessionId: string;
    readonly operationId: string;
    readonly expectedLifecycleEpoch: number;
  }): Promise<ScaffoldSessionObservation> => {
    const { body } = await request(
      `/api/sessions/${encodeURIComponent(input.sessionId)}/${input.kind}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: input.operationId,
          lifecycleEpoch: input.expectedLifecycleEpoch,
        }),
      },
    );
    const observation = parseScaffoldSessionObservation(body);
    if (!observation || observation.sessionId !== input.sessionId) throw protocolError();
    return observation;
  };

  return {
    deployment: options.deployment,
    baseUrl,
    createSession: async (input: ScaffoldCreateSessionInput) => {
      const { body } = await request("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: input.sessionId,
          operationId: input.operationId,
          kind: "agent",
          runtimeProfile: "agent_t3_omp",
          ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
          ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
          ...(input.name ? { name: input.name } : {}),
        }),
      });
      const observation = parseScaffoldSessionObservation(body);
      if (!observation || observation.sessionId !== input.sessionId) throw protocolError();
      return observation;
    },
    getSession,
    resumeSession: (input: Omit<Parameters<typeof lifecycle>[0], "kind">) =>
      lifecycle({ ...input, kind: "resume" }),
    pauseSession: (input: Omit<Parameters<typeof lifecycle>[0], "kind">) =>
      lifecycle({ ...input, kind: "pause" }),
    issueT3Transport: async (input: {
      readonly environmentId: EnvironmentId;
      readonly sessionId: string;
      readonly expectedLifecycleEpoch: number;
    }) => {
      const { body } = await request(
        `/api/sessions/${encodeURIComponent(input.sessionId)}/t3-transport`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lifecycleEpoch: input.expectedLifecycleEpoch }),
        },
      );
      return transportGrant(body, {
        environmentId: input.environmentId,
        sessionId: input.sessionId,
        lifecycleEpoch: input.expectedLifecycleEpoch,
        nowMs: now(),
      });
    },
  };
}

export type ScaffoldControlPlaneClient = ReturnType<typeof makeScaffoldControlPlaneClient>;
