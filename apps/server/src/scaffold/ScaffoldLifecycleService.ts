import {
  type ScaffoldDeployment,
  ScaffoldEnvironmentBinding,
  ScaffoldLifecycleError,
  type ScaffoldPauseInput,
  ScaffoldPreparedConnection,
  ScaffoldSessionLinks,
  type ScaffoldSessionObservation,
  type ScaffoldPrepareConnectionInput,
} from "@t3tools/contracts";

import {
  makeScaffoldControlPlaneClient,
  type ScaffoldControlPlaneClient,
} from "./ScaffoldControlPlaneClient.ts";
import { resolveScaffoldTarget, ScaffoldConfigurationError } from "./ScaffoldConfig.ts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
const DEFAULT_READINESS_INTERVAL_MS = 1_000;
const isScaffoldLifecycleError = Schema.is(ScaffoldLifecycleError);

export interface ScaffoldLifecycleServiceOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly client?: (deployment: ScaffoldDeployment) => ScaffoldControlPlaneClient;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly readinessTimeoutMs?: number;
  readonly readinessIntervalMs?: number;
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
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((milliseconds: number) => NodeTimersPromises.setTimeout(milliseconds));
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const readinessIntervalMs = options.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS;

  const clientFor = (deployment: ScaffoldDeployment): ScaffoldControlPlaneClient => {
    if (options.client) return options.client(deployment);
    try {
      return makeScaffoldControlPlaneClient({
        target: resolveScaffoldTarget(deployment, options.environment),
      });
    } catch (error) {
      if (error instanceof ScaffoldConfigurationError) throw configurationError();
      throw error;
    }
  };

  const awaitReady = async (
    client: ScaffoldControlPlaneClient,
    initial: ScaffoldSessionObservation,
  ): Promise<ScaffoldSessionObservation> => {
    let observation = initial;
    const deadline = now() + readinessTimeoutMs;
    while (observation.status !== "ready" && observation.status !== "agent_running") {
      if (observation.status === "failed" || observation.status === "stopped") {
        throw terminalError(observation);
      }
      if (now() >= deadline) {
        throw new ScaffoldLifecycleError({
          reason: "unavailable",
          message: "Scaffold session is still preparing.",
          status: 202,
          code: "scaffold_preparation_pending",
          retryAfterMs: readinessIntervalMs,
          observation,
        });
      }
      await sleep(readinessIntervalMs);
      observation = await client.getSession(observation.sessionId);
    }
    return observation;
  };

  const reconcileResume = async (
    client: ScaffoldControlPlaneClient,
    input: Extract<
      ScaffoldPrepareConnectionInput,
      { readonly _tag: "ScaffoldResumeAndPrepareInput" }
    >,
  ): Promise<ScaffoldSessionObservation> => {
    try {
      return await client.resumeSession({
        sessionId: input.sessionId,
        operationId: input.operationId,
        lifecycleEpoch: input.expectedLifecycleEpoch,
      });
    } catch (error) {
      if (!isScaffoldLifecycleError(error) || error.status !== 409) throw error;
      const current = await client.getSession(input.sessionId);
      if (
        current.lifecycleEpoch < input.expectedLifecycleEpoch ||
        current.status === "failed" ||
        current.status === "stopped"
      ) {
        throw error;
      }
      return current;
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
    const ready = await awaitReady(client, initial);
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
    let observation: ScaffoldSessionObservation;
    try {
      observation = await client.pauseSession({
        sessionId: input.sessionId,
        operationId: input.operationId,
        lifecycleEpoch: input.expectedLifecycleEpoch,
      });
    } catch (error) {
      if (!isScaffoldLifecycleError(error) || error.status !== 409) throw error;
      observation = await client.getSession(input.sessionId);
      if (observation.status !== "paused" && observation.status !== "stopped") throw error;
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

  return { prepare, pause };
}

export type ScaffoldLifecycleService = ReturnType<typeof makeScaffoldLifecycleService>;
import * as NodeTimersPromises from "node:timers/promises";
