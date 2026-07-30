import {
  makeScaffoldLifecycleAction,
  makeScaffoldLifecycleOutbox,
  ScaffoldLifecycleAction as ScaffoldLifecycleActionSchema,
  type ScaffoldLifecycleAction,
  type ScaffoldLifecycleActionStore,
  type ScaffoldOutboxExecutionResult,
} from "@t3tools/client-runtime/scaffold";
import {
  EnvironmentId,
  ScaffoldPauseInput,
  type ScaffoldCreateParameters,
  type ScaffoldDeployment,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { DraftId } from "../composerDraftStore";
import { randomUUID } from "../lib/utils";
import { openIndexedDatabase } from "./indexedDbOpen";

const DATABASE_NAME = "t3code:scaffold-lifecycle-outbox";
const DATABASE_VERSION = 1;
const STORE_NAME = "actions";
const DRAIN_EVENT = "t3code:scaffold-lifecycle-outbox:drain";
const LIFECYCLE_LOCK = "t3code:scaffold-lifecycle-outbox:drain";
const PERSISTENCE_VERSION = 1;
export const LEGACY_CREATE_MISSING_AUTHORITY = "legacy_create_missing_authority";
let fallbackLifecycleLockTail: Promise<void> = Promise.resolve();

// The schema is intentionally the only accepted durable representation. It
// cannot contain a transport credential or sandbox bootstrap token. IndexedDB
// structured-clones class instances into plain objects, so persisted values
// must be decoded instead of checked with the prototype-sensitive Schema.is.
const decodeScaffoldLifecycleAction = Schema.decodeUnknownOption(ScaffoldLifecycleActionSchema);
type ScaffoldCreateLifecycleAction = Extract<ScaffoldLifecycleAction, { readonly kind: "create" }>;
type ScaffoldPauseLifecycleAction = Extract<ScaffoldLifecycleAction, { readonly kind: "pause" }>;

function decodeDurableAction(value: unknown): ScaffoldLifecycleAction | undefined {
  const decoded = decodeScaffoldLifecycleAction(value);
  return Option.isSome(decoded) ? decoded.value : undefined;
}

function hasCurrentPersistenceVersion(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "persistenceVersion" in value &&
    value.persistenceVersion === PERSISTENCE_VERSION
  );
}

function persistedAction(action: ScaffoldLifecycleAction): unknown {
  return { ...action, persistenceVersion: PERSISTENCE_VERSION };
}

function quarantineLegacyCreate(
  action: ScaffoldLifecycleAction,
): ScaffoldLifecycleAction | undefined {
  if (
    action.kind !== "create" ||
    (action.attempt !== 0 &&
      action.deployment !== undefined &&
      action.draftId !== undefined &&
      action.sourceEnvironmentId !== undefined &&
      action.sourceProjectId !== undefined)
  ) {
    return undefined;
  }
  return decodeDurableAction({
    ...action,
    blocked: true,
    nextAttemptAt: null,
    lastErrorCode: LEGACY_CREATE_MISSING_AUTHORITY,
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return openIndexedDatabase({
    databaseName: DATABASE_NAME,
    databaseVersion: DATABASE_VERSION,
    unavailableMessage: "IndexedDB is unavailable in this browser context.",
    openErrorMessage: "Could not open the Scaffold lifecycle outbox.",
    blockedMessage:
      "Scaffold storage is blocked by another tab. Close other T3 Code tabs and retry.",
    timeoutMessage: "Scaffold storage did not open.",
    upgrade: (database) => {
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "actionId" });
      }
    },
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("The Scaffold outbox transaction was aborted.")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("The Scaffold outbox transaction failed.")),
    );
  });
}

export function createIndexedDbScaffoldLifecycleActionStore(
  open: () => Promise<IDBDatabase> = openDatabase,
): ScaffoldLifecycleActionStore {
  return {
    async list() {
      const database = await open();
      try {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const done = transactionDone(transaction);
        const request = transaction.objectStore(STORE_NAME).getAll();
        const values = await new Promise<unknown[]>((resolve, reject) => {
          request.addEventListener("success", () => resolve(request.result));
          request.addEventListener("error", () =>
            reject(request.error ?? new Error("Could not read the Scaffold lifecycle outbox.")),
          );
        });
        await done;
        const quarantined: ScaffoldLifecycleAction[] = [];
        const actions = values.flatMap((value) => {
          const action = decodeDurableAction(value);
          if (!action) return [];
          if (
            hasCurrentPersistenceVersion(value) &&
            (action.kind !== "create" ||
              (action.blocked &&
                action.nextAttemptAt === null &&
                action.lastErrorCode === LEGACY_CREATE_MISSING_AUTHORITY) ||
              (action.deployment !== undefined &&
                action.draftId !== undefined &&
                action.sourceEnvironmentId !== undefined &&
                action.sourceProjectId !== undefined))
          ) {
            return [action];
          }
          const legacyCreate = quarantineLegacyCreate(action);
          if (!legacyCreate) return [action];
          quarantined.push(legacyCreate);
          return [legacyCreate];
        });
        if (quarantined.length > 0) {
          const quarantineTransaction = database.transaction(STORE_NAME, "readwrite");
          const quarantineDone = transactionDone(quarantineTransaction);
          const objectStore = quarantineTransaction.objectStore(STORE_NAME);
          for (const action of quarantined) objectStore.put(persistedAction(action));
          await quarantineDone;
        }
        return actions;
      } finally {
        database.close();
      }
    },
    async put(action) {
      const durableAction = decodeDurableAction(action);
      if (!durableAction) {
        throw new Error("Refusing to persist an invalid Scaffold lifecycle action.");
      }
      const database = await open();
      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(STORE_NAME).put(persistedAction(durableAction));
        await done;
      } finally {
        database.close();
      }
    },
    async remove(actionId) {
      const database = await open();
      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(STORE_NAME).delete(actionId);
        await done;
      } finally {
        database.close();
      }
    },
  };
}

export function createMemoryScaffoldLifecycleActionStore(
  initial: ReadonlyArray<ScaffoldLifecycleAction> = [],
): ScaffoldLifecycleActionStore {
  const actions = new Map(initial.map((action) => [action.actionId, action]));
  return {
    list: async () => [...actions.values()],
    put: async (action) => {
      actions.set(action.actionId, action);
    },
    remove: async (actionId) => {
      actions.delete(actionId);
    },
  };
}

export function makeScaffoldCreateAction(input: {
  readonly draftId: DraftId;
  readonly deployment: ScaffoldDeployment;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceProjectId: ProjectId;
  readonly create: ScaffoldCreateParameters;
  readonly createdAt?: string;
  readonly uuid?: () => string;
}): ScaffoldCreateLifecycleAction {
  const uuid = input.uuid ?? randomUUID;
  const action = makeScaffoldLifecycleAction({
    kind: "create",
    deployment: input.deployment,
    draftId: input.draftId,
    sourceEnvironmentId: input.sourceEnvironmentId,
    sourceProjectId: input.sourceProjectId,
    actionId: `op_${uuid()}`,
    environmentId: EnvironmentId.make(`scaffold-pending:${input.draftId}`),
    connectionId: `scaffold-connection:${uuid()}`,
    sessionId: `ses_${uuid()}`,
    expectedLifecycleEpoch: 0,
    createdAt: input.createdAt ?? new Date().toISOString(),
    create: input.create,
  });
  if (action.kind !== "create") throw new Error("Expected a Scaffold create action.");
  return action;
}

export function makeScaffoldPauseAction(input: {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sessionId: string;
  readonly expectedLifecycleEpoch: number;
  readonly createdAt?: string;
  readonly uuid?: () => string;
}): ScaffoldPauseLifecycleAction {
  const action = makeScaffoldLifecycleAction({
    kind: "pause",
    sourceThreadId: input.sourceThreadId,
    actionId: `op_${(input.uuid ?? randomUUID)()}`,
    environmentId: input.environmentId,
    connectionId: `scaffold-session:${input.sessionId}`,
    sessionId: input.sessionId,
    expectedLifecycleEpoch: input.expectedLifecycleEpoch,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  if (action.kind !== "pause") throw new Error("Expected a Scaffold pause action.");
  return action;
}

export function scaffoldPauseInputFromAction(input: {
  readonly action: ScaffoldPauseLifecycleAction;
  readonly deployment: ScaffoldDeployment;
}): ScaffoldPauseInput {
  return new ScaffoldPauseInput({
    deployment: input.deployment,
    operationId: input.action.actionId,
    environmentId: input.action.environmentId,
    sessionId: input.action.sessionId,
    expectedLifecycleEpoch: input.action.expectedLifecycleEpoch,
  });
}

export const browserScaffoldLifecycleActionStore = createIndexedDbScaffoldLifecycleActionStore();

export async function enqueueScaffoldLifecycleAction(
  store: ScaffoldLifecycleActionStore,
  action: ScaffoldLifecycleAction,
): Promise<void> {
  const outbox = makeScaffoldLifecycleOutbox({
    store,
    execute: async () => ({ _tag: "retry", retryAfterMs: 0, errorCode: "not_started" }),
  });
  await outbox.enqueue(action);
}

export async function retryScaffoldLifecycleAction(input: {
  readonly store: ScaffoldLifecycleActionStore;
  readonly actionId: string;
  readonly expectedDeployment: ScaffoldDeployment;
  readonly expectedDraftId: DraftId;
  readonly expectedSourceEnvironmentId: EnvironmentId;
  readonly expectedSourceProjectId: ProjectId;
  readonly expectedSessionId: string | null;
  readonly volatileCreateAction?: ScaffoldLifecycleAction;
  readonly onCreating: () => void;
  readonly onPersistenceFailure: (error: unknown) => void;
}): Promise<ScaffoldLifecycleAction | undefined> {
  return withScaffoldLifecycleLock(async () => {
    const action =
      (await input.store.list()).find((candidate) => candidate.actionId === input.actionId) ??
      input.volatileCreateAction;
    if (
      !action ||
      action.actionId !== input.actionId ||
      action.kind !== "create" ||
      input.expectedSessionId === null ||
      action.sessionId !== input.expectedSessionId ||
      action.environmentId !== `scaffold-pending:${input.expectedDraftId}` ||
      action.deployment !== input.expectedDeployment ||
      action.draftId !== input.expectedDraftId ||
      action.sourceEnvironmentId !== input.expectedSourceEnvironmentId ||
      action.sourceProjectId !== input.expectedSourceProjectId
    ) {
      return undefined;
    }
    const retried = decodeDurableAction({
      ...action,
      attempt: 0,
      nextAttemptAt: null,
      lastErrorCode: null,
      blocked: false,
    });
    if (!retried) return undefined;
    input.onCreating();
    try {
      await input.store.put(retried);
    } catch (error) {
      input.onPersistenceFailure(error);
      throw error;
    }
    return retried;
  });
}

function withScaffoldLifecycleLock<A>(run: () => Promise<A>): Promise<A> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks) return locks.request(LIFECYCLE_LOCK, run);
  const result = fallbackLifecycleLockTail.then(run);
  fallbackLifecycleLockTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function drainScaffoldLifecycleActions(input: {
  readonly store: ScaffoldLifecycleActionStore;
  readonly execute: (action: ScaffoldLifecycleAction) => Promise<ScaffoldOutboxExecutionResult>;
  readonly onWait?: (action: ScaffoldLifecycleAction) => void;
  readonly onBlocked?: (action: ScaffoldLifecycleAction) => void;
  readonly now?: () => number;
  readonly actionId?: string;
}): Promise<void> {
  const drain = async () => {
    const store = input.actionId
      ? {
          list: async () =>
            (await input.store.list()).filter((action) => action.actionId === input.actionId),
          put: input.store.put,
          remove: input.store.remove,
        }
      : input.store;
    const outbox = makeScaffoldLifecycleOutbox({
      store,
      execute: input.execute,
      ...(input.onWait ? { onWait: input.onWait } : {}),
      ...(input.onBlocked ? { onBlocked: input.onBlocked } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
    await outbox.drain();
  };
  await withScaffoldLifecycleLock(drain);
}

export function createScaffoldLifecycleDrainRunner(input: {
  readonly run: (actionId?: string) => Promise<void>;
  readonly onIdle: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}): {
  readonly drain: (actionId?: string) => Promise<void>;
  readonly dispose: () => void;
} {
  let disposed = false;
  let running: Promise<void> | null = null;
  let rerunRequested = false;

  const drain = (actionId?: string): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (running !== null) {
      rerunRequested = true;
      return running;
    }
    running = (async () => {
      let nextActionId = actionId;
      while (true) {
        if (disposed) break;
        rerunRequested = false;
        try {
          await input.run(nextActionId);
        } catch (error) {
          input.onError(error);
        }
        nextActionId = undefined;
        if (rerunRequested) continue;
        try {
          await input.onIdle();
        } catch (error) {
          input.onError(error);
        }
        if (!rerunRequested) break;
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    drain,
    dispose: () => {
      disposed = true;
    },
  };
}

export async function resolveScaffoldLifecycleRetryDelay(input: {
  readonly store: ScaffoldLifecycleActionStore;
  readonly isDisposed: () => boolean;
  readonly now?: () => number;
}): Promise<number | null> {
  if (input.isDisposed()) return null;
  const pending = await input.store.list();
  if (input.isDisposed()) return null;
  const now = (input.now ?? Date.now)();
  const readyAt = pending
    .filter((action) => !action.blocked)
    .map((action) => action.nextAttemptAt ?? now)
    .sort((left, right) => left - right)[0];
  return readyAt === undefined ? null : Math.max(0, readyAt - now);
}

export function requestScaffoldLifecycleDrain(actionId?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DRAIN_EVENT, { detail: { actionId } }));
}

export function subscribeScaffoldLifecycleDrain(listener: (actionId?: string) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handleDrain = (event: Event) => {
    const actionId =
      event instanceof CustomEvent &&
      typeof (event.detail as { readonly actionId?: unknown } | undefined)?.actionId === "string"
        ? (event.detail as { readonly actionId: string }).actionId
        : undefined;
    listener(actionId);
  };
  const handleOnline = () => listener();
  const handlePageShow = () => listener();
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") listener();
  };
  window.addEventListener(DRAIN_EVENT, handleDrain);
  window.addEventListener("online", handleOnline);
  window.addEventListener("pageshow", handlePageShow);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  return () => {
    window.removeEventListener(DRAIN_EVENT, handleDrain);
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("pageshow", handlePageShow);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
