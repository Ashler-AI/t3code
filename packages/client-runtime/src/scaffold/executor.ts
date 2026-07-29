import { ScaffoldControlPlaneError, type ScaffoldControlPlaneClient } from "./client.ts";
import type { ScaffoldLifecycleAction } from "./model.ts";
import type { ScaffoldOutboxExecutionResult } from "./outbox.ts";
import { reconcileScaffoldLifecycle, type ReconcileScaffoldLifecycleInput } from "./reconcile.ts";

export interface ExecuteScaffoldLifecycleActionInput {
  readonly client: ScaffoldControlPlaneClient;
  readonly action: ScaffoldLifecycleAction;
}

function isAmbiguousFailure(error: ScaffoldControlPlaneError): boolean {
  return (
    error.status === 0 ||
    error.status === 408 ||
    error.status === 409 ||
    error.status === 429 ||
    error.status >= 500
  );
}

function resultFromReconciliation(
  reconciliation: ReturnType<typeof reconcileScaffoldLifecycle>,
  fallbackErrorCode: string,
): ScaffoldOutboxExecutionResult {
  switch (reconciliation._tag) {
    case "converged":
    case "superseded":
      return { _tag: "acknowledged" };
    case "wait":
      return {
        _tag: "wait",
        retryAfterMs: reconciliation.retryAfterMs,
        errorCode: `session_${reconciliation.observation.status}`,
        observation: {
          sessionId: reconciliation.observation.sessionId,
          lifecycleEpoch: reconciliation.observation.lifecycleEpoch,
        },
      };
    case "stale":
      return {
        _tag: "retry",
        retryAfterMs: reconciliation.retryAfterMs,
        errorCode: "stale_lifecycle_epoch",
      };
    case "retry":
      return {
        _tag: "retry",
        retryAfterMs: reconciliation.retryAfterMs,
        errorCode: fallbackErrorCode,
      };
    case "blocked":
      return { _tag: "blocked", errorCode: reconciliation.reason };
  }
}

/**
 * Executes one durable intent. The persisted action id is always reused as the
 * Scaffold operation id, so retries after an ambiguous timeout remain
 * idempotent. Lifecycle responses are reconciled against an authoritative GET.
 */
export async function executeScaffoldLifecycleAction(
  input: ExecuteScaffoldLifecycleActionInput,
): Promise<ScaffoldOutboxExecutionResult> {
  const { action, client } = input;
  let mutationObservation: ReconcileScaffoldLifecycleInput["observation"];
  let mutationError: ScaffoldControlPlaneError | undefined;

  try {
    switch (action.kind) {
      case "create":
        mutationObservation = await client.createSession({
          sessionId: action.sessionId,
          operationId: action.actionId,
          ...action.create,
        });
        break;
      case "resume":
        mutationObservation = await client.resumeSession({
          sessionId: action.sessionId,
          operationId: action.actionId,
          expectedLifecycleEpoch: action.expectedLifecycleEpoch,
        });
        break;
      case "pause":
        mutationObservation = await client.pauseSession({
          sessionId: action.sessionId,
          operationId: action.actionId,
          expectedLifecycleEpoch: action.expectedLifecycleEpoch,
        });
        break;
    }
  } catch (error) {
    if (error instanceof ScaffoldControlPlaneError) {
      mutationError = error;
      mutationObservation = error.observation;
    } else {
      mutationError = new ScaffoldControlPlaneError({
        message: "Scaffold request could not be completed.",
        status: 0,
        code: "scaffold_network_error",
      });
    }
  }

  let observation = mutationObservation;
  let getError: ScaffoldControlPlaneError | undefined;
  if (!mutationError || isAmbiguousFailure(mutationError)) {
    try {
      observation = await client.getSession(action.sessionId);
    } catch (error) {
      getError =
        error instanceof ScaffoldControlPlaneError
          ? error
          : new ScaffoldControlPlaneError({
              message: "Scaffold request could not be completed.",
              status: 0,
              code: "scaffold_network_error",
            });
    }
  }

  const effectiveError = getError ?? mutationError;
  const reconciliation = reconcileScaffoldLifecycle({
    kind: action.kind,
    expectedLifecycleEpoch: action.expectedLifecycleEpoch,
    ...(observation ? { observation } : {}),
    ...(effectiveError
      ? {
          httpStatus: effectiveError.status,
          errorCode: effectiveError.code,
          ...(effectiveError.retryAfterMs !== undefined
            ? { retryAfterMs: effectiveError.retryAfterMs }
            : {}),
        }
      : {}),
  });

  return resultFromReconciliation(reconciliation, effectiveError?.code ?? "scaffold_not_converged");
}
