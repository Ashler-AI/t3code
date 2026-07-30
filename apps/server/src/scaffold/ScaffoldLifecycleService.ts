import {
  type ScaffoldDeployment,
  ScaffoldDeploymentCapability,
  type ScaffoldDeploymentCapabilities,
  ScaffoldEnvironmentBinding,
  ScaffoldLifecycleError,
  type ScaffoldObserveInput,
  type ScaffoldPauseInput,
  type ScaffoldRenameInput,
  ScaffoldPreparedConnection,
  ScaffoldSessionLinks,
  type ScaffoldSessionObservation,
  type ScaffoldPrepareConnectionInput,
  type SessionFabricCapabilityGrant,
} from "@t3tools/contracts";

import {
  makeScaffoldControlPlaneClient,
  type ScaffoldControlPlaneClient,
  type ScaffoldSessionFabricCapabilityInput,
} from "./ScaffoldControlPlaneClient.ts";
import {
  invalidateScaffoldOauthCredential,
  resolveScaffoldTarget,
  ScaffoldConfigurationError,
} from "./ScaffoldConfig.ts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const DEFAULT_READINESS_INTERVAL_MS = 1_000;
const isScaffoldLifecycleError = Schema.is(ScaffoldLifecycleError);
const SCAFFOLD_DEPLOYMENTS = ["staging", "production"] as const;

export interface ScaffoldLifecycleServiceOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly client?: (deployment: ScaffoldDeployment) => ScaffoldControlPlaneClient;
  readonly now?: () => number;
  /** @deprecated Readiness retries are owned by the durable client outbox. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** @deprecated Readiness retries are owned by the durable client outbox. */
  readonly readinessTimeoutMs?: number;
  readonly readinessIntervalMs?: number;
}

function configuredCapabilityDeployment(
  requested: ScaffoldDeployment | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): ScaffoldDeployment {
  if (requested !== undefined) return requested;
  const configured = environment.T3CODE_SCAFFOLD_DEFAULT_DEPLOYMENT?.trim().toLowerCase();
  if (configured === "staging" || configured === "production") return configured;
  const hasStaging = Boolean(environment.T3CODE_SCAFFOLD_STAGING_URL?.trim());
  const hasProduction = Boolean(environment.T3CODE_SCAFFOLD_PRODUCTION_URL?.trim());
  if (hasStaging !== hasProduction) return hasStaging ? "staging" : "production";
  throw configurationError();
}

function configurationError(): ScaffoldLifecycleError {
  return new ScaffoldLifecycleError({
    reason: "configuration",
    message: "Scaffold is not configured for the requested deployment.",
    status: 0,
    code: "scaffold_not_configured",
  });
}

function terminalError(observation: ScaffoldSessionObservation): ScaffoldLifecycleError {
  return new ScaffoldLifecycleError({
    reason: "terminal",
    message: "Scaffold session cannot be prepared.",
    status: 409,
    code: `scaffold_session_${observation.status}`,
    observation,
  });
}

function isRemoteCodeWriteCredentialDenial(error: ScaffoldLifecycleError): boolean {
  if (error.status !== 403) return false;
  const code = error.code.toLowerCase();
  return (
    code === "remote_code_token_forbidden" ||
    code === "remote_code_insufficient_scope" ||
    code === "oauth_insufficient_scope" ||
    (code.includes("remote_code") &&
      code.includes("write") &&
      (code.includes("forbidden") || code.includes("missing") || code.includes("required")))
  );
}

function stableLinks(baseUrl: string, sessionId: string): ScaffoldSessionLinks {
  const origin = new URL(baseUrl).origin;
  const encoded = encodeURIComponent(sessionId);
  return new ScaffoldSessionLinks({
    session: `${origin}/?q=${encoded}`,
    web: `${origin}/sessions/${encoded}/web`,
    tilt: `${origin}/sessions/${encoded}/tilt`,
  });
}

export function makeScaffoldLifecycleService(options: ScaffoldLifecycleServiceOptions = {}) {
  const serviceEnvironment = options.environment ?? process.env;
  const now = options.now ?? Date.now;
  const readinessIntervalMs = options.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
  const renameFlights = new Map<string, Promise<ScaffoldSessionObservation>>();

  const clientFor = (deployment: ScaffoldDeployment): ScaffoldControlPlaneClient => {
    if (options.client) return options.client(deployment);
    try {
      return makeScaffoldControlPlaneClient({
        target: resolveScaffoldTarget(deployment, serviceEnvironment),
      });
    } catch (error) {
      if (error instanceof ScaffoldConfigurationError) throw configurationError();
      throw error;
    }
  };

  const observeReadiness = async (
    client: ScaffoldControlPlaneClient,
    initial: ScaffoldSessionObservation,
  ): Promise<ScaffoldSessionObservation> => {
    // The durable client outbox owns retries. A server invocation takes one
    // fresh observation so it never nests a polling loop inside an outbox attempt.
    if (initial.status === "ready" || initial.status === "agent_running") return initial;
    if (initial.status === "failed" || initial.status === "stopped") {
      throw terminalError(initial);
    }

    const observation = await client.getSession(initial.sessionId);
    if (observation.status === "ready" || observation.status === "agent_running") {
      return observation;
    }
    if (observation.status === "failed" || observation.status === "stopped") {
      throw terminalError(observation);
    }
    throw new ScaffoldLifecycleError({
      reason: "unavailable",
      message: "Scaffold session is still preparing.",
      status: 202,
      code: "scaffold_preparation_pending",
      retryAfterMs: readinessIntervalMs,
      observation,
    });
  };

  const reconcileResume = async (
    client: ScaffoldControlPlaneClient,
    input: Extract<
      ScaffoldPrepareConnectionInput,
      { readonly _tag: "ScaffoldResumeAndPrepareInput" }
    >,
  ): Promise<ScaffoldSessionObservation> => {
    const resumeAtEpoch = (lifecycleEpoch: number) =>
      client.resumeSession({
        sessionId: input.sessionId,
        operationId: input.operationId,
        lifecycleEpoch,
      });
    try {
      return await resumeAtEpoch(input.expectedLifecycleEpoch);
    } catch (error) {
      if (!isScaffoldLifecycleError(error) || error.status !== 409) throw error;
      const current = await client.getSession(input.sessionId);
      if (current.status === "failed" || current.status === "stopped") {
        throw terminalError(current);
      }
      if (current.lifecycleEpoch < input.expectedLifecycleEpoch) throw error;
      if (current.status === "ready" || current.status === "agent_running") return current;
      if (current.status !== "paused" || current.lifecycleEpoch === input.expectedLifecycleEpoch) {
        throw new ScaffoldLifecycleError({
          reason: error.reason,
          message: error.message,
          status: error.status,
          code: error.code,
          ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
          observation: current,
        });
      }

      // A saved target can legitimately lag a pause completed by another tab.
      // Retry once at the authoritative paused epoch, preserving the original
      // operation id so the control plane retains idempotent mutation fencing.
      try {
        return await resumeAtEpoch(current.lifecycleEpoch);
      } catch (retryError) {
        if (!isScaffoldLifecycleError(retryError) || retryError.status !== 409) throw retryError;
        const refreshed = await client.getSession(input.sessionId);
        if (refreshed.status === "failed" || refreshed.status === "stopped") {
          throw terminalError(refreshed);
        }
        if (refreshed.status === "ready" || refreshed.status === "agent_running") return refreshed;
        throw new ScaffoldLifecycleError({
          reason: retryError.reason,
          message: retryError.message,
          status: retryError.status,
          code: retryError.code,
          ...(retryError.retryAfterMs !== undefined
            ? { retryAfterMs: retryError.retryAfterMs }
            : {}),
          observation: refreshed,
        });
      }
    }
  };

  const reconcileCreate = async (
    client: ScaffoldControlPlaneClient,
    input: Extract<
      ScaffoldPrepareConnectionInput,
      { readonly _tag: "ScaffoldCreateAndPrepareInput" }
    >,
  ): Promise<ScaffoldSessionObservation> => {
    try {
      return await client.createSession({
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        operationId: input.operationId,
        ...input.create,
      });
    } catch (error) {
      if (
        !input.sessionId ||
        !isScaffoldLifecycleError(error) ||
        !(
          error.status === 0 ||
          error.status === 408 ||
          error.status === 409 ||
          error.status === 429 ||
          error.status >= 500
        )
      ) {
        throw error;
      }
      try {
        const current = await client.getSession(input.sessionId);
        if (current.status === "failed" || current.status === "stopped") throw error;
        return current;
      } catch (getError) {
        if (getError === error) throw error;
        throw error;
      }
    }
  };

  const prepare = async (
    input: ScaffoldPrepareConnectionInput,
  ): Promise<ScaffoldPreparedConnection> => {
    const client = clientFor(input.deployment);
    const initial =
      input._tag === "ScaffoldCreateAndPrepareInput"
        ? await reconcileCreate(client, input)
        : await reconcileResume(client, input);
    const ready = await observeReadiness(client, initial);
    const transport = await client.issueT3Transport({
      sessionId: ready.sessionId,
      lifecycleEpoch: ready.lifecycleEpoch,
      ...(input._tag === "ScaffoldResumeAndPrepareInput"
        ? { environmentId: input.environmentId }
        : {}),
    });
    const binding = new ScaffoldEnvironmentBinding({
      deployment: input.deployment,
      environmentId: transport.environmentId,
      sessionId: ready.sessionId,
      lifecycleEpoch: ready.lifecycleEpoch,
      status: ready.status,
      links: stableLinks(client.baseUrl, ready.sessionId),
      lastKnownAt: DateTime.formatIso(DateTime.makeUnsafe(now())),
    });
    return new ScaffoldPreparedConnection({
      binding,
      httpBaseUrl: transport.httpBaseUrl,
      wsBaseUrl: transport.wsBaseUrl,
      bootstrapCredential: transport.bootstrapCredential,
      attachCredential: transport.attachCredential,
      expiresAt: transport.expiresAt,
    });
  };

  const pause = async (input: ScaffoldPauseInput): Promise<ScaffoldEnvironmentBinding> => {
    const client = clientFor(input.deployment);
    const pauseAtEpoch = (lifecycleEpoch: number) =>
      client.pauseSession({
        sessionId: input.sessionId,
        operationId: input.operationId,
        lifecycleEpoch,
      });
    let observation: ScaffoldSessionObservation;
    try {
      observation = await pauseAtEpoch(input.expectedLifecycleEpoch);
    } catch (error) {
      if (!isScaffoldLifecycleError(error) || error.status !== 409) throw error;
      observation = await client.getSession(input.sessionId);
      if (
        (observation.status === "ready" || observation.status === "agent_running") &&
        observation.lifecycleEpoch > input.expectedLifecycleEpoch
      ) {
        try {
          observation = await pauseAtEpoch(observation.lifecycleEpoch);
        } catch (retryError) {
          if (!isScaffoldLifecycleError(retryError) || retryError.status !== 409) throw retryError;
          observation = await client.getSession(input.sessionId);
          if (observation.status !== "paused" && observation.status !== "stopped") {
            throw new ScaffoldLifecycleError({
              reason: retryError.reason,
              message: retryError.message,
              status: retryError.status,
              code: retryError.code,
              ...(retryError.retryAfterMs !== undefined
                ? { retryAfterMs: retryError.retryAfterMs }
                : {}),
              observation,
            });
          }
        }
      } else if (observation.status !== "paused" && observation.status !== "stopped") {
        throw new ScaffoldLifecycleError({
          reason: error.reason,
          message: error.message,
          status: error.status,
          code: error.code,
          ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
          observation,
        });
      }
    }
    return new ScaffoldEnvironmentBinding({
      deployment: input.deployment,
      // Pause does not need or return transport authority. The caller merges
      // this lifecycle projection into its existing cached binding.
      environmentId: input.environmentId,
      sessionId: input.sessionId,
      lifecycleEpoch: observation.lifecycleEpoch,
      status: observation.status,
      links: stableLinks(client.baseUrl, input.sessionId),
      lastKnownAt: DateTime.formatIso(DateTime.makeUnsafe(now())),
    });
  };

  const observe = async (input: ScaffoldObserveInput): Promise<ScaffoldSessionObservation> =>
    clientFor(input.deployment).getSession(input.sessionId);

  const rename = (input: ScaffoldRenameInput): Promise<ScaffoldSessionObservation> => {
    const key = `${input.deployment}:${input.sessionId}`;
    const currentFlight = renameFlights.get(key);
    if (currentFlight) return currentFlight;

    const client = clientFor(input.deployment);
    const operation = (async () => {
      const current = await client.getSession(input.sessionId);
      if (current.name === input.name) return current;
      // The project title is the create-time fallback. A different current
      // value is a user-authored/manual name and must never be overwritten by
      // automatic thread-title synchronization.
      if (current.name !== undefined && current.name !== input.expectedCurrentName) return current;
      return client.renameSession({
        sessionId: input.sessionId,
        operationId: input.operationId,
        name: input.name,
      });
    })();
    const flight = operation.finally(() => {
      if (renameFlights.get(key) === flight) renameFlights.delete(key);
    });
    renameFlights.set(key, flight);
    return flight;
  };

  const issueSessionFabricCapability = async (input: {
    readonly deployment?: ScaffoldDeployment;
    readonly capability: ScaffoldSessionFabricCapabilityInput;
  }): Promise<SessionFabricCapabilityGrant> => {
    const deployment = configuredCapabilityDeployment(input.deployment, serviceEnvironment);
    try {
      return await clientFor(deployment).issueSessionFabricCapability(input.capability);
    } catch (error) {
      if (
        input.capability.role === "controller" &&
        isScaffoldLifecycleError(error) &&
        isRemoteCodeWriteCredentialDenial(error)
      ) {
        invalidateScaffoldOauthCredential(deployment, serviceEnvironment);
      }
      throw error;
    }
  };

  const deploymentCapabilities = async (): Promise<ScaffoldDeploymentCapabilities> => ({
    deployments: await Promise.all(
      SCAFFOLD_DEPLOYMENTS.map(async (deployment) => {
        try {
          await clientFor(deployment).probeSessionCollection();
          return new ScaffoldDeploymentCapability({
            deployment,
            status: "available",
            description: "New Scaffold sandbox",
          });
        } catch (error) {
          if (error instanceof ScaffoldConfigurationError) {
            return new ScaffoldDeploymentCapability({
              deployment,
              status: "unavailable",
              description: "Scaffold is not configured",
            });
          }
          if (isScaffoldLifecycleError(error)) {
            if (error.reason === "configuration") {
              return new ScaffoldDeploymentCapability({
                deployment,
                status: "unavailable",
                description: "Scaffold is not configured",
              });
            }
            if (error.reason === "not_found") {
              return new ScaffoldDeploymentCapability({
                deployment,
                status: "unsupported",
                description: "Agent sessions are not available in this deployment",
              });
            }
            if (error.reason === "authentication") {
              return new ScaffoldDeploymentCapability({
                deployment,
                status: "unavailable",
                description: "Scaffold sign-in is required",
              });
            }
          }
          return new ScaffoldDeploymentCapability({
            deployment,
            status: "unavailable",
            description: "Scaffold is temporarily unavailable",
          });
        }
      }),
    ),
  });

  return { prepare, observe, pause, rename, issueSessionFabricCapability, deploymentCapabilities };
}

export type ScaffoldLifecycleService = ReturnType<typeof makeScaffoldLifecycleService>;
