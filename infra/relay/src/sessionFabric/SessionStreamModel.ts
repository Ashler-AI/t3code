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
  | { readonly type: "accepted" }
  | { readonly type: "rejected"; readonly detail: string };

export function decideAuthorizedCommandSubmit(input: {
  readonly controllerMatchesSession: boolean;
  readonly runnerState: string;
  readonly eligibleRunnerCount: number;
}): AuthorizedCommandSubmitDecision {
  if (!input.controllerMatchesSession) {
    return { type: "rejected", detail: "Controller capability required" };
  }
  if (input.runnerState !== "online" || input.eligibleRunnerCount === 0) {
    return { type: "rejected", detail: "Session runner is offline" };
  }
  return { type: "accepted" };
}
