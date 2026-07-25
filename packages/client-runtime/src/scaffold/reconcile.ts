import type { ScaffoldLifecycleActionKind, ScaffoldSessionObservation } from "./model.ts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export type ScaffoldLifecycleReconciliation =
  | { readonly _tag: "converged"; readonly observation: ScaffoldSessionObservation }
  | {
      readonly _tag: "wait";
      readonly observation: ScaffoldSessionObservation;
      readonly retryAfterMs: number;
    }
  | {
      readonly _tag: "stale";
      readonly observation: ScaffoldSessionObservation;
      readonly retryAfterMs: number;
    }
  | {
      readonly _tag: "retry";
      readonly observation?: ScaffoldSessionObservation;
      readonly retryAfterMs: number;
    }
  | {
      readonly _tag: "blocked";
      readonly observation?: ScaffoldSessionObservation;
      readonly reason: string;
    }
  | { readonly _tag: "superseded"; readonly observation: ScaffoldSessionObservation };

const DEFAULT_RETRY_AFTER_MS = 1_000;

export interface ReconcileScaffoldLifecycleInput {
  readonly kind: ScaffoldLifecycleActionKind;
  readonly expectedLifecycleEpoch: number;
  readonly observation?: ScaffoldSessionObservation;
  readonly httpStatus?: number;
  readonly errorCode?: string;
  readonly retryAfterMs?: number;
}

function retryAfter(input: ReconcileScaffoldLifecycleInput): number {
  return Math.max(0, input.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS);
}

function isRetryableHttpStatus(status: number | undefined): boolean {
  return (
    status === undefined ||
    status === 0 ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

export function reconcileScaffoldLifecycle(
  input: ReconcileScaffoldLifecycleInput,
): ScaffoldLifecycleReconciliation {
  const observation = input.observation;
  if (!observation) {
    return isRetryableHttpStatus(input.httpStatus)
      ? { _tag: "retry", retryAfterMs: retryAfter(input) }
      : {
          _tag: "blocked",
          reason: input.errorCode ?? `scaffold_http_${input.httpStatus ?? "unknown"}`,
        };
  }

  if (observation.lifecycleEpoch > input.expectedLifecycleEpoch) {
    return { _tag: "superseded", observation };
  }
  if (observation.lifecycleEpoch < input.expectedLifecycleEpoch) {
    return { _tag: "stale", observation, retryAfterMs: retryAfter(input) };
  }

  const errorCode = input.errorCode ?? observation.errorCode;
  if (input.kind === "pause" && errorCode === "agent_turn_running") {
    return { _tag: "blocked", observation, reason: "agent_turn_running" };
  }

  switch (input.kind) {
    case "create": {
      switch (observation.status) {
        case "ready":
        case "agent_running":
        case "paused":
          return { _tag: "converged", observation };
        case "creating":
        case "restoring_snapshot":
        case "starting":
        case "resuming":
          return { _tag: "wait", observation, retryAfterMs: retryAfter(input) };
        case "stopped":
          return { _tag: "blocked", observation, reason: "session_stopped" };
        case "failed":
          return { _tag: "blocked", observation, reason: errorCode ?? "sandbox_failed" };
      }
    }
    case "resume": {
      switch (observation.status) {
        case "ready":
        case "agent_running":
          return { _tag: "converged", observation };
        case "creating":
        case "restoring_snapshot":
        case "starting":
        case "resuming":
          return { _tag: "wait", observation, retryAfterMs: retryAfter(input) };
        case "paused":
          return { _tag: "retry", observation, retryAfterMs: retryAfter(input) };
        case "stopped":
          return { _tag: "blocked", observation, reason: "session_stopped" };
        case "failed":
          return { _tag: "blocked", observation, reason: errorCode ?? "sandbox_failed" };
      }
    }
    case "pause": {
      switch (observation.status) {
        case "paused":
        case "stopped":
          return { _tag: "converged", observation };
        case "creating":
        case "restoring_snapshot":
        case "starting":
        case "resuming":
          return { _tag: "wait", observation, retryAfterMs: retryAfter(input) };
        case "ready":
          return { _tag: "retry", observation, retryAfterMs: retryAfter(input) };
        case "agent_running":
          return { _tag: "blocked", observation, reason: "agent_turn_running" };
        case "failed":
          return { _tag: "blocked", observation, reason: errorCode ?? "sandbox_failed" };
      }
    }
  }
}

export function shouldRenewScaffoldTransportGrant(input: {
  readonly expiresAt: string;
  readonly nowMs: number;
  readonly minimumValidityMs?: number;
}): boolean {
  const expiresAtMs = Option.map(DateTime.make(input.expiresAt), DateTime.toEpochMillis);
  if (Option.isNone(expiresAtMs)) return true;
  return expiresAtMs.value <= input.nowMs + Math.max(0, input.minimumValidityMs ?? 30_000);
}
