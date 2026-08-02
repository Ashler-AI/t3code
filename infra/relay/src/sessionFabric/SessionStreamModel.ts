export type RunnerGenerationDecision = "accepted" | "current" | "stale";

export const SESSION_FABRIC_AUTHENTICATION_CLOSE_CODE = 4401;
export const SESSION_FABRIC_PERMISSION_CLOSE_CODE = 4403;

export function decideRunnerGeneration(
  currentGeneration: number,
  incomingGeneration: number,
): RunnerGenerationDecision {
  if (incomingGeneration < currentGeneration) return "stale";
  if (incomingGeneration === currentGeneration) return "current";
  return "accepted";
}

export function runnerHelloMatchesLease(input: {
  readonly currentGeneration: number;
  readonly currentRunnerId: string | null;
  readonly incomingGeneration: number;
  readonly incomingRunnerId: string;
}): boolean {
  if (input.incomingGeneration < input.currentGeneration) return false;
  return !(
    input.incomingGeneration === input.currentGeneration &&
    input.currentRunnerId !== null &&
    input.incomingRunnerId !== input.currentRunnerId
  );
}

export type EventAppendDecision = "accepted" | "duplicate" | "stale-runner";

export function decideEventAppend(input: {
  readonly currentRunnerGeneration: number;
  readonly incomingRunnerGeneration: number;
  readonly eventAlreadyExists: boolean;
}): EventAppendDecision {
  if (input.eventAlreadyExists) return "duplicate";
  if (input.incomingRunnerGeneration < input.currentRunnerGeneration) return "stale-runner";
  return "accepted";
}

export type CommandSubmitDecision<Existing> =
  | { readonly type: "accepted" }
  | { readonly type: "duplicate"; readonly existing: Existing };

/**
 * Duplicate command ids must reuse the complete stored receipt state. In
 * particular, an accepted receipt's original result sequence is part of the
 * idempotent command result and cannot be regenerated from a later stream
 * cursor.
 */
export function decideCommandSubmit<Existing>(
  existing: Existing | undefined,
): CommandSubmitDecision<Existing> {
  return existing === undefined ? { type: "accepted" } : { type: "duplicate", existing };
}

export function shouldReplayCommand(status: string): boolean {
  return status === "queued" || status === "delivered";
}

export function isCurrentRunnerAttachment(input: {
  readonly attachmentGeneration: number | null;
  readonly attachmentRunnerId: string | null;
  readonly currentGeneration: number;
  readonly currentRunnerId: string | null;
}): boolean {
  return (
    input.attachmentGeneration === input.currentGeneration &&
    input.attachmentRunnerId !== null &&
    input.attachmentRunnerId === input.currentRunnerId
  );
}

export type AuthorizedCommandSubmitDecision =
  | { readonly type: "accepted"; readonly delivery: "runner" | "scaffold-wake" }
  | { readonly type: "rejected"; readonly detail: string };

export function decideAuthorizedCommandSubmit(input: {
  readonly controllerMatchesSession: boolean;
  readonly runnerState: string;
  readonly eligibleRunnerCount: number;
  readonly scaffoldWakeEligible: boolean;
}): AuthorizedCommandSubmitDecision {
  if (!input.controllerMatchesSession) {
    return { type: "rejected", detail: "Controller capability required" };
  }
  if (input.runnerState === "online" && input.eligibleRunnerCount > 0) {
    return { type: "accepted", delivery: "runner" };
  }
  return input.scaffoldWakeEligible
    ? { type: "accepted", delivery: "scaffold-wake" }
    : { type: "rejected", detail: "Session runner is offline" };
}

export function commandTargetsRunnerGeneration(input: {
  readonly targetRunnerGeneration: number | null;
  readonly runnerGeneration: number;
}): boolean {
  return (
    input.targetRunnerGeneration === null || input.targetRunnerGeneration === input.runnerGeneration
  );
}

export function commandNeedsScaffoldWakeRetry(input: {
  readonly status: string;
  readonly targetRunnerGeneration: number | null;
  readonly runnerGeneration: number;
  readonly wakeActorId: string | null;
}): boolean {
  return (
    shouldReplayCommand(input.status) &&
    input.wakeActorId !== null &&
    input.targetRunnerGeneration === input.runnerGeneration + 1
  );
}

export function scaffoldWakeRetryDelayMs(input: {
  readonly wakeStartedAt: string;
  readonly nowMs: number;
}): number | null {
  const wakeStartedAtMs = Date.parse(input.wakeStartedAt);
  if (!Number.isFinite(wakeStartedAtMs)) return null;
  const elapsedMs = Math.max(0, input.nowMs - wakeStartedAtMs);
  if (elapsedMs >= 10 * 60_000) return null;
  if (elapsedMs < 10_000) return 2_000;
  if (elapsedMs < 30_000) return 5_000;
  if (elapsedMs < 2 * 60_000) return 15_000;
  return 60_000;
}

export function resolveScaffoldWakeActorId(input: {
  readonly claimedGeneration: number | null;
  readonly claimedActorId: string | null;
  readonly targetRunnerGeneration: number;
  readonly candidateActorId: string;
}): string {
  return input.claimedGeneration === input.targetRunnerGeneration && input.claimedActorId !== null
    ? input.claimedActorId
    : input.candidateActorId;
}
