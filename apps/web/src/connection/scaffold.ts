import { ScaffoldLifecycleGateway } from "@t3tools/client-runtime/scaffold";
import {
  ScaffoldDeploymentCapabilities,
  ScaffoldLifecycleError,
  ScaffoldObserveInput,
  ScaffoldPreparedConnection,
  ScaffoldResumeAndPrepareInput,
  ScaffoldSessionObservation,
  type ScaffoldDeploymentCapabilities as ScaffoldDeploymentCapabilitiesValue,
  type ScaffoldPrepareConnectionInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { randomUUID } from "../lib/utils";

const decodePrepared = Schema.decodeUnknownOption(ScaffoldPreparedConnection);
const decodeDeploymentCapabilities = Schema.decodeUnknownOption(ScaffoldDeploymentCapabilities);
const decodeSessionObservation = Schema.decodeUnknownOption(ScaffoldSessionObservation);
const decodeLifecycleError = Schema.decodeUnknownOption(ScaffoldLifecycleError);
const isLifecycleError = Schema.is(ScaffoldLifecycleError);
/** Allows the server's 60-second readiness window to complete before transport cancellation. */
export const DEFAULT_LOCAL_LIFECYCLE_TIMEOUT_MS = 65_000;

function operationId(): string {
  return randomUUID();
}

const requestPreparedEffect = (input: ScaffoldPrepareConnectionInput) =>
  Effect.tryPromise({
    try: () => requestScaffoldPreparedConnection(input),
    catch: (cause) =>
      isLifecycleError(cause)
        ? cause
        : new ScaffoldLifecycleError({
            reason: "unavailable",
            message: "The local T3 lifecycle service could not be reached.",
            status: 0,
            code: "scaffold_local_unexpected_error",
          }),
  });

export async function requestScaffoldPreparedConnection(
  input: ScaffoldPrepareConnectionInput,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  lifecycleUrl: string = resolvePrimaryEnvironmentHttpUrl("/api/scaffold/connection"),
  timeoutMs: number = DEFAULT_LOCAL_LIFECYCLE_TIMEOUT_MS,
): Promise<ScaffoldPreparedConnection> {
  const bearerToken = await readDesktopPrimaryBearerToken();
  let response: Response;
  try {
    response = await fetchImpl(lifecycleUrl, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ScaffoldLifecycleError({
      reason: "network",
      message: "The local T3 lifecycle service could not be reached.",
      status: 0,
      code: "scaffold_local_network_error",
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const lifecycleError = decodeLifecycleError(body);
    if (Option.isSome(lifecycleError)) {
      throw lifecycleError.value;
    }
    throw new ScaffoldLifecycleError({
      reason: "invalid_response",
      message: "The local T3 lifecycle service returned an invalid response.",
      status: response.status,
      code: "scaffold_local_invalid_response",
    });
  }
  const prepared = decodePrepared(body);
  if (Option.isNone(prepared)) {
    throw new ScaffoldLifecycleError({
      reason: "invalid_response",
      message: "The local T3 lifecycle service returned an invalid response.",
      status: 502,
      code: "scaffold_local_invalid_response",
    });
  }
  return prepared.value;
}

export async function requestScaffoldDeploymentCapabilities(
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  capabilitiesUrl: string = resolvePrimaryEnvironmentHttpUrl("/api/scaffold/deployments"),
  timeoutMs: number = 10_000,
): Promise<ScaffoldDeploymentCapabilitiesValue> {
  const bearerToken = await readDesktopPrimaryBearerToken();
  const response = await fetchImpl(capabilitiesUrl, {
    method: "GET",
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error("Scaffold availability could not be checked.");
  }
  const body: unknown = await response.json().catch(() => undefined);
  const capabilities = decodeDeploymentCapabilities(body);
  if (Option.isNone(capabilities)) {
    throw new Error("Scaffold availability response was invalid.");
  }
  return capabilities.value;
}

export async function requestScaffoldSessionObservation(
  input: ScaffoldObserveInput,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  observationUrl: string = resolvePrimaryEnvironmentHttpUrl("/api/scaffold/observation"),
  timeoutMs: number = 10_000,
): Promise<ScaffoldSessionObservation> {
  const bearerToken = await readDesktopPrimaryBearerToken();
  const response = await fetchImpl(observationUrl, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const lifecycleError = decodeLifecycleError(body);
    if (Option.isSome(lifecycleError)) throw lifecycleError.value;
    throw new Error("Scaffold session status could not be checked.");
  }
  const observation = decodeSessionObservation(body);
  if (Option.isNone(observation)) {
    throw new Error("Scaffold session status response was invalid.");
  }
  return observation.value;
}

export const scaffoldLifecycleGatewayLayer = Layer.effect(
  ScaffoldLifecycleGateway,
  Effect.gen(function* () {
    // A create response is handed to the resolver once, in memory. This avoids
    // immediately resuming the session and never persists bootstrap authority.
    const preparedOnce = yield* Ref.make(new Map<string, ScaffoldPreparedConnection>());
    const create: ScaffoldLifecycleGateway["Service"]["create"] = (input) =>
      requestPreparedEffect(input).pipe(
        Effect.tap((prepared) =>
          Ref.update(preparedOnce, (current) => {
            const next = new Map(current);
            next.set(prepared.binding.environmentId, prepared);
            return next;
          }),
        ),
      );
    const prepare: ScaffoldLifecycleGateway["Service"]["prepare"] = (target) =>
      Ref.modify(preparedOnce, (current) => {
        const cached = current.get(target.environmentId);
        if (
          cached !== undefined &&
          cached.binding.sessionId === target.sessionId &&
          cached.binding.lifecycleEpoch === target.lifecycleEpoch
        ) {
          const next = new Map(current);
          next.delete(target.environmentId);
          return [Option.some(cached), next] as const;
        }
        if (cached === undefined) {
          return [Option.none<ScaffoldPreparedConnection>(), current] as const;
        }
        const next = new Map(current);
        next.delete(target.environmentId);
        return [Option.none<ScaffoldPreparedConnection>(), next] as const;
      }).pipe(
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              requestPreparedEffect(
                new ScaffoldResumeAndPrepareInput({
                  deployment: target.deployment,
                  operationId: operationId(),
                  environmentId: target.environmentId,
                  sessionId: target.sessionId,
                  expectedLifecycleEpoch: target.lifecycleEpoch,
                }),
              ),
          }),
        ),
      );
    return ScaffoldLifecycleGateway.of({ create, prepare });
  }),
);
