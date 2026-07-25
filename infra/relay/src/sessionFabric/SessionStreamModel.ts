export type RunnerGenerationDecision = "accepted" | "current" | "stale";

export function decideRunnerGeneration(
  currentGeneration: number,
  incomingGeneration: number,
): RunnerGenerationDecision {
  if (incomingGeneration < currentGeneration) return "stale";
  if (incomingGeneration === currentGeneration) return "current";
  return "accepted";
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
