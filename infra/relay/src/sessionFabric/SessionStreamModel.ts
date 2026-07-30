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

export const SESSION_FABRIC_WAKE_MAX_ATTEMPTS = 6;

export function scaffoldWakeRetryDelayMs(attemptCount: number): number {
  const boundedAttempt = Math.max(1, Math.min(attemptCount, SESSION_FABRIC_WAKE_MAX_ATTEMPTS));
  return Math.min(30_000, 1_000 * 2 ** (boundedAttempt - 1));
}

export function scaffoldWakeKeepsCommandPending(status: string): boolean {
  return (
    status === "pending" ||
    status === "retrying" ||
    status === "joining" ||
    status === "joining_pause" ||
    status === "awaiting_snapshot" ||
    status === "ready"
  );
}

export function eventCancelsPendingSettlePause(eventType: string): boolean {
  return (
    eventType === "thread.unsettled" ||
    eventType === "thread.turn-start-requested" ||
    eventType === "thread.message-sent" ||
    eventType === "thread.activity-appended"
  );
}

export function settlePauseCancellationState(
  status: string,
): "cancelled" | "cancel_requested" | null {
  if (status === "pending") return "cancelled";
  if (status === "in_flight") return "cancel_requested";
  return null;
}

export function settlePauseCanResettle(status: string): boolean {
  return status === "cancelled" || status === "failed";
}

export function settlePauseLifecycleAuthority(input: {
  readonly currentLifecycleEpoch: number;
  readonly expectedLifecycleEpoch: number;
  readonly targetLifecycleEpoch: number;
}): number | null {
  return input.currentLifecycleEpoch === input.expectedLifecycleEpoch &&
    input.targetLifecycleEpoch === input.expectedLifecycleEpoch + 1
    ? input.targetLifecycleEpoch
    : null;
}

export function scaffoldWakeLifecycleAuthority(input: {
  readonly durableLifecycleEpoch: number;
  readonly controllerLifecycleEpoch: number;
}): number {
  return Math.max(input.durableLifecycleEpoch, input.controllerLifecycleEpoch);
}

export function settlePauseNeedsCompensatingWake(input: {
  readonly cancellationRequested: boolean;
  readonly joinedCommandCount: number;
}): boolean {
  return input.cancellationRequested && input.joinedCommandCount === 0;
}

export function settlePauseCompensationCommandId(settlementEventId: string): string {
  return `settled-pause:${settlementEventId}`;
}

export function settlementEventIdFromCompensationCommand(commandId: string): string | null {
  return commandId.startsWith("settled-pause:")
    ? commandId.slice("settled-pause:".length) || null
    : null;
}

export function settledEventCanQueueScaffoldPause(input: {
  readonly eventType: string;
  readonly eventThreadId: string;
  readonly snapshotThreadId: string;
  readonly publication: string;
  readonly environmentKind: string;
  readonly scaffoldSessionId: string | null;
  readonly lifecycleEpoch: number | null | undefined;
  readonly runnerGeneration: number;
}): boolean {
  return (
    input.eventType === "thread.settled" &&
    input.eventThreadId === input.snapshotThreadId &&
    input.publication === "public" &&
    input.environmentKind === "scaffold" &&
    input.scaffoldSessionId !== null &&
    input.lifecycleEpoch === input.runnerGeneration
  );
}

export function scaffoldWakeRequestsAuthority(status: string): boolean {
  return status === "pending" || status === "retrying" || status === "awaiting_snapshot";
}

export function scaffoldWakeHasAttemptsRemaining(attemptCount: number): boolean {
  return attemptCount < SESSION_FABRIC_WAKE_MAX_ATTEMPTS;
}

export function scaffoldWakeFollowerStatus(input: {
  readonly leaderStatus: string;
  readonly targetLifecycleEpoch: number | null;
}): "joining" | "awaiting_snapshot" | "ready" {
  if (input.targetLifecycleEpoch === null) return "joining";
  return input.leaderStatus === "ready" ? "ready" : "awaiting_snapshot";
}

export function nextSessionFabricMaintenanceDueAt(input: {
  readonly directoryDueAt: number | null;
  readonly wakeDueAt: number | null;
  readonly pauseDueAt?: number | null;
}): number | null {
  const due = [input.directoryDueAt, input.wakeDueAt, input.pauseDueAt ?? null].filter(
    (value): value is number => value !== null,
  );
  return due.length === 0 ? null : Math.min(...due);
}

export function offlineScaffoldCommandCanWake(input: {
  readonly controllerMatchesSnapshotIdentity: boolean;
  readonly runnerState: string;
  readonly eligibleRunnerCount: number;
  readonly wakeAlreadyActive: boolean;
  readonly publication: string;
  readonly environmentKind: string;
  readonly scaffoldSessionId: string | null;
  readonly controllerLifecycleEpoch: number | null | undefined;
  readonly wakeAuthorityConfigured: boolean;
}): boolean {
  return (
    input.controllerMatchesSnapshotIdentity &&
    (input.runnerState !== "online" || input.wakeAlreadyActive) &&
    input.eligibleRunnerCount === 0 &&
    input.publication === "public" &&
    input.environmentKind === "scaffold" &&
    input.scaffoldSessionId !== null &&
    Number.isSafeInteger(input.controllerLifecycleEpoch) &&
    (input.controllerLifecycleEpoch ?? -1) >= 0 &&
    input.wakeAuthorityConfigured
  );
}

export function snapshotProvesScaffoldWakeTarget(input: {
  readonly wakeFabricSessionId: string;
  readonly wakeEnvironmentId: string;
  readonly wakeThreadId: string;
  readonly wakeScaffoldSessionId: string;
  readonly wakeTargetLifecycleEpoch: number | null;
  readonly snapshotFabricSessionId: string;
  readonly snapshotEnvironmentKind: string;
  readonly snapshotEnvironmentId: string;
  readonly snapshotThreadId: string;
  readonly snapshotScaffoldSessionId: string | null;
  readonly snapshotLifecycleEpoch: number | null | undefined;
  readonly runnerGeneration: number;
}): boolean {
  return (
    input.wakeTargetLifecycleEpoch !== null &&
    input.snapshotFabricSessionId === input.wakeFabricSessionId &&
    input.snapshotEnvironmentKind === "scaffold" &&
    input.snapshotEnvironmentId === input.wakeEnvironmentId &&
    input.snapshotThreadId === input.wakeThreadId &&
    input.snapshotScaffoldSessionId === input.wakeScaffoldSessionId &&
    input.snapshotLifecycleEpoch === input.wakeTargetLifecycleEpoch &&
    input.runnerGeneration === input.wakeTargetLifecycleEpoch
  );
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
