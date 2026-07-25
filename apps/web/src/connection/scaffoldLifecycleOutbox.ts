import {
  makeScaffoldLifecycleAction,
  makeScaffoldLifecycleOutbox,
  ScaffoldLifecycleAction as ScaffoldLifecycleActionSchema,
  type ScaffoldLifecycleAction,
  type ScaffoldLifecycleActionStore,
  type ScaffoldOutboxExecutionResult,
} from "@t3tools/client-runtime/scaffold";
import { EnvironmentId, type ScaffoldCreateParameters } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { DraftId } from "../composerDraftStore";
import { randomUUID } from "../lib/utils";

const DATABASE_NAME = "t3code:scaffold-lifecycle-outbox";
const DATABASE_VERSION = 1;
const STORE_NAME = "actions";
const DRAIN_EVENT = "t3code:scaffold-lifecycle-outbox:drain";

// The schema is intentionally the only accepted durable representation. It
// cannot contain a transport credential or sandbox bootstrap token.
const isScaffoldLifecycleAction = Schema.is(ScaffoldLifecycleActionSchema);

function isDurableAction(value: unknown): value is ScaffoldLifecycleAction {
  return isScaffoldLifecycleAction(value);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this browser context."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "actionId" });
      }
    });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Could not open the Scaffold lifecycle outbox."));
    });
    request.addEventListener("success", () => resolve(request.result));
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

export function createIndexedDbScaffoldLifecycleActionStore(): ScaffoldLifecycleActionStore {
  return {
    async list() {
      const database = await openDatabase();
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
        return values.filter(isDurableAction);
      } finally {
        database.close();
      }
    },
    async put(action) {
      if (!isDurableAction(action)) {
        throw new Error("Refusing to persist an invalid Scaffold lifecycle action.");
      }
      const database = await openDatabase();
      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(STORE_NAME).put(action);
        await done;
      } finally {
        database.close();
      }
    },
    async remove(actionId) {
      const database = await openDatabase();
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
  readonly create: ScaffoldCreateParameters;
  readonly createdAt?: string;
  readonly uuid?: () => string;
}): ScaffoldLifecycleAction {
  const uuid = input.uuid ?? randomUUID;
  return makeScaffoldLifecycleAction({
    kind: "create",
    actionId: `op_${uuid()}`,
    environmentId: EnvironmentId.make(`scaffold-pending:${input.draftId}`),
    connectionId: `scaffold-connection:${uuid()}`,
    sessionId: `ses_${uuid()}`,
    expectedLifecycleEpoch: 0,
    createdAt: input.createdAt ?? new Date().toISOString(),
    create: input.create,
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

export async function drainScaffoldLifecycleActions(input: {
  readonly store: ScaffoldLifecycleActionStore;
  readonly execute: (action: ScaffoldLifecycleAction) => Promise<ScaffoldOutboxExecutionResult>;
  readonly onBlocked?: (action: ScaffoldLifecycleAction) => void;
  readonly now?: () => number;
}): Promise<void> {
  const drain = async () => {
    const outbox = makeScaffoldLifecycleOutbox({
      store: input.store,
      execute: input.execute,
      ...(input.onBlocked ? { onBlocked: input.onBlocked } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
    await outbox.drain();
  };
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) {
    await drain();
    return;
  }
  await locks.request("t3code:scaffold-lifecycle-outbox:drain", drain);
}

export function requestScaffoldLifecycleDrain(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DRAIN_EVENT));
}

export function subscribeScaffoldLifecycleDrain(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(DRAIN_EVENT, listener);
  window.addEventListener("online", listener);
  return () => {
    window.removeEventListener(DRAIN_EVENT, listener);
    window.removeEventListener("online", listener);
  };
}
