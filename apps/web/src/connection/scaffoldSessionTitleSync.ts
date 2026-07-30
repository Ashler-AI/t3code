import type {
  ConnectionTarget,
  EnvironmentConnectionPhase,
  ScaffoldConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";

const DEFAULT_THREAD_TITLE = "New thread";

interface EnvironmentProject extends OrchestrationProjectShell {
  readonly environmentId: EnvironmentId;
}

interface EnvironmentThread extends OrchestrationThreadShell {
  readonly environmentId: EnvironmentId;
}

export interface ScaffoldSessionTitleSyncCandidate {
  readonly deployment: ScaffoldConnectionTarget["deployment"];
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly expectedCurrentName: string;
  readonly name: string;
  readonly operationId: string;
}

export interface ScaffoldSessionTitleSyncTargetAvailability {
  readonly target: ScaffoldConnectionTarget;
  readonly usable: boolean;
}

interface EnvironmentConnection {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly entry: { readonly target: ConnectionTarget };
}

function byCreatedAtThenId<T extends { readonly createdAt: string; readonly id: string }>(
  left: T,
  right: T,
): number {
  const createdAt = left.createdAt.localeCompare(right.createdAt);
  return createdAt === 0 ? left.id.localeCompare(right.id) : createdAt;
}

function projectForThread(
  projects: ReadonlyArray<EnvironmentProject>,
  thread: Pick<EnvironmentThread, "environmentId" | "projectId">,
): EnvironmentProject | undefined {
  return projects.find(
    (project) => project.environmentId === thread.environmentId && project.id === thread.projectId,
  );
}

/**
 * Selects the first usable T3 thread title for each Scaffold environment.
 * Both the candidate and create-time fallback come from server-projected
 * shells; browser persistence is not consulted for session naming authority.
 */
export function selectScaffoldSessionTitleSyncCandidates(input: {
  readonly targets: ReadonlyArray<ScaffoldConnectionTarget>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThread>;
}): ScaffoldSessionTitleSyncCandidate[] {
  const candidates: ScaffoldSessionTitleSyncCandidate[] = [];
  const seenSessions = new Set<string>();

  for (const target of input.targets) {
    const sessionKey = `${target.deployment}:${target.sessionId}`;
    if (seenSessions.has(sessionKey)) continue;
    seenSessions.add(sessionKey);

    const thread = input.threads
      .filter((candidate) => candidate.environmentId === target.environmentId)
      .sort(byCreatedAtThenId)
      .find((candidate) => {
        const title = candidate.title.trim();
        const project = projectForThread(input.projects, candidate);
        return (
          project !== undefined &&
          title !== "" &&
          title !== DEFAULT_THREAD_TITLE &&
          title !== project.title.trim()
        );
      });
    if (!thread) continue;
    const project = projectForThread(input.projects, thread);
    if (!project) continue;

    candidates.push({
      deployment: target.deployment,
      environmentId: target.environmentId,
      sessionId: target.sessionId,
      threadId: thread.id,
      expectedCurrentName: project.title.trim(),
      name: thread.title.trim(),
      operationId: `scaffold-title-sync:${target.sessionId}:${thread.id}`,
    });
  }

  return candidates;
}

/**
 * Naming is issued through the primary environment's RPC connection and reads
 * the target sandbox before renaming it. Both connections must therefore be
 * live; a persisted target alone is not usable naming authority.
 */
export function scaffoldSessionTitleSyncTargetAvailability(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environments: ReadonlyArray<EnvironmentConnection>;
}): ScaffoldSessionTitleSyncTargetAvailability[] {
  const primary = input.environments.find(
    (environment) => environment.environmentId === input.primaryEnvironmentId,
  );
  const primaryUsable =
    primary?.connection.phase === "connected" &&
    primary.entry.target._tag !== "SessionFabricConnectionTarget";

  return input.environments.flatMap((environment) => {
    const target = environment.entry.target;
    if (target._tag !== "ScaffoldConnectionTarget") return [];
    return [
      {
        target,
        usable:
          primaryUsable &&
          environment.connection.phase === "connected" &&
          environment.environmentId === target.environmentId,
      },
    ];
  });
}

const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS_PER_CONNECTION = 2;
const DEFAULT_MAX_RETRY_DELAY_MS = 5 * 60_000;

function sessionKey(input: Pick<ScaffoldSessionTitleSyncCandidate, "deployment" | "sessionId">) {
  return `${input.deployment}:${input.sessionId}`;
}

export interface ScaffoldSessionTitleSyncRunner {
  readonly run: (candidate: ScaffoldSessionTitleSyncCandidate) => Promise<void>;
  readonly reconcileAvailability: (
    availability: ReadonlyArray<ScaffoldSessionTitleSyncTargetAvailability>,
  ) => void;
}

function isTerminalTitleSyncFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("reason" in error)) return false;
  const reason = error.reason;
  return reason === "terminal" || reason === "not_found";
}

/**
 * Coalesces concurrent renders in one UI runtime and backs off failed calls.
 * Transient failures retry automatically with bounded exponential backoff;
 * reconnecting resets the delay. Successful responses include the server's
 * manual-name no-op, while terminal lifecycle outcomes permanently stop work.
 */
export function createScaffoldSessionTitleSyncRunner(
  rename: (candidate: ScaffoldSessionTitleSyncCandidate) => Promise<void>,
  options: {
    readonly now?: () => number;
    readonly retryDelayMs?: number;
    readonly maxAttemptsPerConnection?: number;
    readonly maxRetryDelayMs?: number;
  } = {},
): ScaffoldSessionTitleSyncRunner {
  const now = options.now ?? Date.now;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttemptsPerConnection = Math.max(
    1,
    options.maxAttemptsPerConnection ?? DEFAULT_MAX_ATTEMPTS_PER_CONNECTION,
  );
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const completed = new Set<string>();
  const stopped = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const retryNotBefore = new Map<string, number>();
  const attempts = new Map<string, number>();
  const available = new Map<string, boolean>();
  const candidates = new Map<string, ScaffoldSessionTitleSyncCandidate>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearRetryTimer = (key: string) => {
    const timer = retryTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    retryTimers.delete(key);
  };

  const retryDelayForAttempt = (attempt: number): number => {
    const backoffStep = Math.min(Math.max(0, attempt - 1), maxAttemptsPerConnection - 1);
    return Math.min(retryDelayMs * 2 ** backoffStep, maxRetryDelayMs);
  };

  const scheduleRetry = (key: string, delayMs: number) => {
    clearRetryTimer(key);
    const timer = setTimeout(() => {
      retryTimers.delete(key);
      retryNotBefore.delete(key);
      const candidate = candidates.get(key);
      if (!candidate || completed.has(key) || stopped.has(key) || available.get(key) === false) {
        return;
      }
      void run(candidate).catch(() => {
        // The failed attempt schedules its own retry. Initial callers report
        // errors; background retries stay quiet to avoid a console storm.
      });
    }, delayMs);
    retryTimers.set(key, timer);
  };

  const reconcileAvailability = (
    availability: ReadonlyArray<ScaffoldSessionTitleSyncTargetAvailability>,
  ) => {
    const nextKeys = new Set<string>();
    for (const entry of availability) {
      const key = sessionKey(entry.target);
      nextKeys.add(key);
      const wasAvailable = available.get(key);
      available.set(key, entry.usable);
      if (entry.usable && wasAvailable === false) {
        attempts.delete(key);
        retryNotBefore.delete(key);
        clearRetryTimer(key);
        const candidate = candidates.get(key);
        if (candidate && !completed.has(key) && !stopped.has(key)) {
          void run(candidate).catch(() => {
            // A failed reconnect attempt schedules the bounded retry loop.
          });
        }
      } else if (!entry.usable) {
        clearRetryTimer(key);
      }
    }
    for (const key of available.keys()) {
      if (!nextKeys.has(key)) {
        available.set(key, false);
        clearRetryTimer(key);
      }
    }
  };

  function run(candidate: ScaffoldSessionTitleSyncCandidate): Promise<void> {
    const key = sessionKey(candidate);
    candidates.set(key, candidate);
    if (completed.has(key) || stopped.has(key)) return Promise.resolve();
    if (available.get(key) === false) return Promise.resolve();
    const current = inFlight.get(key);
    if (current) return current;
    if ((retryNotBefore.get(key) ?? 0) > now()) return Promise.resolve();
    const attempt = attempts.get(key) ?? 0;
    const nextAttempt = Math.min(attempt + 1, maxAttemptsPerConnection);
    attempts.set(key, nextAttempt);

    const flight = rename(candidate)
      .then(() => {
        completed.add(key);
        attempts.delete(key);
        retryNotBefore.delete(key);
        clearRetryTimer(key);
      })
      .catch((error: unknown) => {
        if (isTerminalTitleSyncFailure(error)) {
          stopped.add(key);
          attempts.delete(key);
          retryNotBefore.delete(key);
          clearRetryTimer(key);
          throw error;
        }
        const delayMs = retryDelayForAttempt(nextAttempt);
        retryNotBefore.set(key, now() + delayMs);
        scheduleRetry(key, delayMs);
        throw error;
      })
      .finally(() => {
        if (inFlight.get(key) === flight) inFlight.delete(key);
      });
    inFlight.set(key, flight);
    return flight;
  }

  return { run, reconcileAvailability };
}

export type { EnvironmentProject as ScaffoldTitleSyncProject };
export type { EnvironmentThread as ScaffoldTitleSyncThread };
