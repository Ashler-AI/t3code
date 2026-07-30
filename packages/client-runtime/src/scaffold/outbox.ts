import type { ProjectId, ScaffoldAgentEffort } from "@t3tools/contracts";

import {
  ScaffoldCreateLifecycleAction,
  ScaffoldCreateParameters,
  ScaffoldLifecycleAction,
  ScaffoldPauseLifecycleAction,
  ScaffoldResumeLifecycleAction,
  type ScaffoldDeployment,
} from "./model.ts";

export interface ScaffoldLifecycleActionStore {
  readonly list: () => Promise<ReadonlyArray<ScaffoldLifecycleAction>>;
  readonly put: (action: ScaffoldLifecycleAction) => Promise<void>;
  readonly remove: (actionId: string) => Promise<void>;
}

export type ScaffoldOutboxExecutionResult =
  | { readonly _tag: "acknowledged" }
  | {
      readonly _tag: "wait";
      readonly retryAfterMs: number;
      readonly errorCode: string;
      readonly observation?: {
        readonly sessionId: string;
        readonly lifecycleEpoch: number;
      };
    }
  | { readonly _tag: "retry"; readonly retryAfterMs: number; readonly errorCode: string }
  | { readonly _tag: "blocked"; readonly errorCode: string };

export interface ScaffoldLifecycleOutboxOptions {
  readonly store: ScaffoldLifecycleActionStore;
  readonly execute: (action: ScaffoldLifecycleAction) => Promise<ScaffoldOutboxExecutionResult>;
  readonly now?: () => number;
  readonly maxAttempts?: number;
  readonly onWait?: (action: ScaffoldLifecycleAction) => void;
  readonly onBlocked?: (action: ScaffoldLifecycleAction) => void;
}

function byCreationOrder(left: ScaffoldLifecycleAction, right: ScaffoldLifecycleAction): number {
  const time = left.createdAt.localeCompare(right.createdAt);
  return time === 0 ? left.actionId.localeCompare(right.actionId) : time;
}

export function makeScaffoldLifecycleOutbox(options: ScaffoldLifecycleOutboxOptions) {
  const now = options.now ?? Date.now;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 8);
  let draining: Promise<void> | undefined;
  let storeQueue: Promise<void> = Promise.resolve();

  const withStoreLock = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = storeQueue.then(operation, operation);
    storeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const enqueue = async (action: ScaffoldLifecycleAction): Promise<void> => {
    // Durability precedes publication/wakeup. A crash after this await leaves
    // an action that the next client instance can safely retry by stable id.
    await withStoreLock(() => options.store.put(action));
  };

  const drainOnce = async (): Promise<void> => {
    const pending = [...(await withStoreLock(() => options.store.list()))].sort(byCreationOrder);
    for (const action of pending) {
      if (action.blocked) {
        // The UI projection is persisted separately from this outbox. Re-emit
        // terminal state after a reload so a blocked create cannot remain as
        // an indefinitely "Connecting" draft when the original callback was
        // interrupted before the projection committed.
        options.onBlocked?.(action);
        continue;
      }
      if (action.nextAttemptAt !== null && action.nextAttemptAt > now()) continue;
      let result: ScaffoldOutboxExecutionResult;
      try {
        result = await options.execute(action);
      } catch {
        result = { _tag: "retry", retryAfterMs: 1_000, errorCode: "network" };
      }
      switch (result._tag) {
        case "acknowledged":
          await withStoreLock(() => options.store.remove(action.actionId));
          break;
        case "wait":
          {
            const updated = updateScaffoldLifecycleAction(action, {
              attempt: action.attempt,
              nextAttemptAt: now() + Math.max(0, result.retryAfterMs),
              lastErrorCode: result.errorCode,
              blocked: false,
              ...(action.kind === "create" && result.observation
                ? {
                    sessionId: result.observation.sessionId,
                    expectedLifecycleEpoch: result.observation.lifecycleEpoch,
                  }
                : {}),
            });
            await withStoreLock(() => options.store.put(updated));
            options.onWait?.(updated);
          }
          break;
        case "retry":
          {
            const attempt = action.attempt + 1;
            const blocked = attempt >= maxAttempts;
            const updated = updateScaffoldLifecycleAction(action, {
              attempt,
              nextAttemptAt: blocked ? null : now() + Math.max(0, result.retryAfterMs),
              lastErrorCode: result.errorCode,
              blocked,
            });
            await withStoreLock(() => options.store.put(updated));
            if (blocked) options.onBlocked?.(updated);
          }
          break;
        case "blocked":
          {
            const updated = updateScaffoldLifecycleAction(action, {
              attempt: action.attempt + 1,
              nextAttemptAt: null,
              lastErrorCode: result.errorCode,
              blocked: true,
            });
            await withStoreLock(() => options.store.put(updated));
            options.onBlocked?.(updated);
          }
          break;
      }
    }
  };

  return {
    enqueue,
    drain: (): Promise<void> => {
      if (!draining) {
        draining = drainOnce().finally(() => {
          draining = undefined;
        });
      }
      return draining;
    },
  };
}

function updateScaffoldLifecycleAction(
  action: ScaffoldLifecycleAction,
  update: Pick<ScaffoldLifecycleAction, "attempt" | "nextAttemptAt" | "lastErrorCode" | "blocked"> &
    Partial<Pick<ScaffoldLifecycleAction, "sessionId" | "expectedLifecycleEpoch">>,
): ScaffoldLifecycleAction {
  switch (action.kind) {
    case "create":
      return new ScaffoldCreateLifecycleAction({ ...action, ...update });
    case "resume":
      return new ScaffoldResumeLifecycleAction({ ...action, ...update });
    case "pause":
      return new ScaffoldPauseLifecycleAction({ ...action, ...update });
  }
}

interface MakeScaffoldLifecycleActionBase {
  readonly actionId: string;
  readonly environmentId: ScaffoldLifecycleAction["environmentId"];
  readonly connectionId: string;
  readonly sessionId: string;
  readonly expectedLifecycleEpoch: number;
  readonly createdAt: string;
}

type MakeScaffoldLifecycleActionInput = MakeScaffoldLifecycleActionBase &
  (
    | {
        readonly kind: "create";
        readonly deployment: ScaffoldDeployment;
        readonly draftId: string;
        readonly sourceEnvironmentId: ScaffoldLifecycleAction["environmentId"];
        readonly sourceProjectId: ProjectId;
        readonly create?: {
          readonly sourceRef?: string;
          readonly snapshotId?: string;
          readonly name?: string;
          readonly modelRouteId?: string;
          readonly agentEffort?: ScaffoldAgentEffort;
        };
      }
    | {
        readonly kind: "resume";
        readonly deployment?: never;
        readonly create?: never;
      }
    | {
        readonly kind: "pause";
        readonly sourceThreadId: Extract<
          ScaffoldLifecycleAction,
          { readonly kind: "pause" }
        >["sourceThreadId"];
        readonly deployment?: never;
        readonly create?: never;
      }
  );

export function makeScaffoldLifecycleAction(
  input: MakeScaffoldLifecycleActionInput,
): ScaffoldLifecycleAction {
  const fields = {
    actionId: input.actionId,
    environmentId: input.environmentId,
    connectionId: input.connectionId,
    sessionId: input.sessionId,
    expectedLifecycleEpoch: input.expectedLifecycleEpoch,
    createdAt: input.createdAt,
    attempt: 0,
    nextAttemptAt: null,
    lastErrorCode: null,
    blocked: false,
  } as const;
  switch (input.kind) {
    case "create":
      return new ScaffoldCreateLifecycleAction({
        ...fields,
        kind: "create",
        deployment: input.deployment,
        draftId: input.draftId,
        sourceEnvironmentId: input.sourceEnvironmentId,
        sourceProjectId: input.sourceProjectId,
        create: new ScaffoldCreateParameters(input.create ?? {}),
      });
    case "resume":
      return new ScaffoldResumeLifecycleAction({ ...fields, kind: "resume" });
    case "pause":
      return new ScaffoldPauseLifecycleAction({
        ...fields,
        kind: "pause",
        sourceThreadId: input.sourceThreadId,
      });
  }
}
