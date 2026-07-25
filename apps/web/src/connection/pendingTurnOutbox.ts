import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

const DATABASE_NAME = "t3code:pending-turn-outbox";
const DATABASE_VERSION = 1;
const STORE_NAME = "pending-turns";

export type PendingTurnStatus = "pending" | "sending" | "failed";

export interface PendingTurnOutboxEntry {
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly draftId: string | null;
  readonly input: StartThreadTurnInput;
  readonly status: PendingTurnStatus;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastError: string | null;
}

export interface PendingTurnOutboxStorage {
  readonly list: () => Promise<ReadonlyArray<PendingTurnOutboxEntry>>;
  readonly put: (entry: PendingTurnOutboxEntry) => Promise<void>;
  readonly remove: (idempotencyKey: string) => Promise<void>;
}

export interface PendingTurnDrainResult {
  readonly entry: PendingTurnOutboxEntry;
  readonly outcome: "acknowledged" | "sent" | "failed";
  readonly error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The pending message could not be sent.";
}

function isPendingTurnOutboxEntry(value: unknown): value is PendingTurnOutboxEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<PendingTurnOutboxEntry>;
  const input = entry.input as Partial<StartThreadTurnInput> | undefined;
  const message = input?.message as Partial<StartThreadTurnInput["message"]> | undefined;
  return (
    entry.schemaVersion === 1 &&
    typeof entry.idempotencyKey === "string" &&
    typeof entry.environmentId === "string" &&
    typeof entry.threadId === "string" &&
    typeof entry.messageId === "string" &&
    (entry.draftId === null || typeof entry.draftId === "string") &&
    typeof entry.input === "object" &&
    entry.input !== null &&
    input?.commandId === entry.idempotencyKey &&
    input.threadId === entry.threadId &&
    typeof message === "object" &&
    message !== null &&
    message.messageId === entry.messageId &&
    (entry.status === "pending" || entry.status === "sending" || entry.status === "failed") &&
    typeof entry.attemptCount === "number" &&
    typeof entry.createdAt === "string" &&
    typeof entry.updatedAt === "string" &&
    (entry.lastError === null || typeof entry.lastError === "string")
  );
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
        request.result.createObjectStore(STORE_NAME, { keyPath: "idempotencyKey" });
      }
    });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Could not open the pending-turn outbox."));
    });
    request.addEventListener("success", () => resolve(request.result));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("The outbox transaction was aborted.")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("The outbox transaction failed.")),
    );
  });
}

export function createIndexedDbPendingTurnOutboxStorage(): PendingTurnOutboxStorage {
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
            reject(request.error ?? new Error("Could not read the pending-turn outbox.")),
          );
        });
        await done;
        return values
          .filter(isPendingTurnOutboxEntry)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      } finally {
        database.close();
      }
    },
    async put(entry) {
      const database = await openDatabase();
      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(STORE_NAME).put(entry);
        await done;
      } finally {
        database.close();
      }
    },
    async remove(idempotencyKey) {
      const database = await openDatabase();
      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(STORE_NAME).delete(idempotencyKey);
        await done;
      } finally {
        database.close();
      }
    },
  };
}

export function createMemoryPendingTurnOutboxStorage(
  initial: ReadonlyArray<PendingTurnOutboxEntry> = [],
): PendingTurnOutboxStorage {
  const entries = new Map(initial.map((entry) => [entry.idempotencyKey, entry]));
  return {
    async list() {
      return [...entries.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
    },
    async put(entry) {
      entries.set(entry.idempotencyKey, entry);
    },
    async remove(idempotencyKey) {
      entries.delete(idempotencyKey);
    },
  };
}

export const browserPendingTurnOutbox = createIndexedDbPendingTurnOutboxStorage();

export async function enqueuePendingTurn(
  storage: PendingTurnOutboxStorage,
  input: Omit<
    PendingTurnOutboxEntry,
    "schemaVersion" | "status" | "attemptCount" | "updatedAt" | "lastError"
  >,
): Promise<PendingTurnOutboxEntry> {
  if (
    input.input.commandId !== input.idempotencyKey ||
    input.input.threadId !== input.threadId ||
    input.input.message.messageId !== input.messageId
  ) {
    throw new Error("Pending turn identifiers must match its durable command payload.");
  }
  const existing = (await storage.list()).find(
    (entry) => entry.idempotencyKey === input.idempotencyKey,
  );
  if (existing) return existing;

  const entry: PendingTurnOutboxEntry = {
    ...input,
    schemaVersion: 1,
    status: "pending",
    attemptCount: 0,
    updatedAt: input.createdAt,
    lastError: null,
  };
  await storage.put(entry);
  return entry;
}

export async function listPendingTurnsForThread(
  storage: PendingTurnOutboxStorage,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<ReadonlyArray<PendingTurnOutboxEntry>> {
  return (await storage.list()).filter(
    (entry) => entry.environmentId === environmentId && entry.threadId === threadId,
  );
}

/**
 * A server restart can preserve the thread row while losing its in-memory
 * command receipt. Replaying the stable first-turn command must still deliver
 * the message, but must not repeat the already-committed thread.create step.
 */
export function reconcilePendingTurnForExistingThread(
  input: StartThreadTurnInput,
): StartThreadTurnInput {
  if (input.bootstrap?.createThread === undefined) return input;

  const { createThread: _createThread, ...remainingBootstrap } = input.bootstrap;
  const { bootstrap: _bootstrap, ...turnInput } = input;
  return Object.keys(remainingBootstrap).length === 0
    ? turnInput
    : { ...turnInput, bootstrap: remainingBootstrap };
}

export async function acknowledgePendingTurn(
  storage: PendingTurnOutboxStorage,
  idempotencyKey: string,
): Promise<void> {
  await storage.remove(idempotencyKey);
}

export async function recordPendingTurnFailure(
  storage: PendingTurnOutboxStorage,
  idempotencyKey: string,
  error: unknown,
): Promise<void> {
  const entry = (await storage.list()).find(
    (candidate) => candidate.idempotencyKey === idempotencyKey,
  );
  if (!entry) return;
  await storage.put({
    ...entry,
    status: "failed",
    attemptCount: entry.attemptCount + 1,
    updatedAt: new Date().toISOString(),
    lastError: errorMessage(error),
  });
}

let drainQueue: Promise<void> = Promise.resolve();
const BROWSER_DRAIN_LOCK_NAME = "t3code:pending-turn-outbox:drain";

/**
 * Drain matching entries serially in this browser process. A stable command id
 * is stored inside every entry, so a crash or a second browser tab may safely
 * repeat the RPC while the server still applies the command exactly once.
 */
export async function drainPendingTurnOutbox(input: {
  readonly storage: PendingTurnOutboxStorage;
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly idempotencyKey?: string;
  readonly isAcknowledged?: (entry: PendingTurnOutboxEntry) => boolean | Promise<boolean>;
  readonly dispatch: (entry: PendingTurnOutboxEntry) => Promise<void>;
}): Promise<ReadonlyArray<PendingTurnDrainResult>> {
  let release!: () => void;
  const previous = drainQueue;
  drainQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  try {
    const drain = async (): Promise<ReadonlyArray<PendingTurnDrainResult>> => {
      const entries = (await input.storage.list()).filter(
        (entry) =>
          (input.environmentId === undefined || entry.environmentId === input.environmentId) &&
          (input.threadId === undefined || entry.threadId === input.threadId) &&
          (input.idempotencyKey === undefined || entry.idempotencyKey === input.idempotencyKey),
      );
      const results: PendingTurnDrainResult[] = [];
      for (const entry of entries) {
        if ((await input.isAcknowledged?.(entry)) === true) {
          await input.storage.remove(entry.idempotencyKey);
          results.push({ entry, outcome: "acknowledged", error: null });
          continue;
        }

        const sending: PendingTurnOutboxEntry = {
          ...entry,
          status: "sending",
          attemptCount: entry.attemptCount + 1,
          updatedAt: new Date().toISOString(),
          lastError: null,
        };
        await input.storage.put(sending);
        try {
          await input.dispatch(sending);
          await input.storage.remove(sending.idempotencyKey);
          results.push({ entry: sending, outcome: "sent", error: null });
        } catch (error) {
          const message = errorMessage(error);
          await input.storage.put({
            ...sending,
            status: "failed",
            updatedAt: new Date().toISOString(),
            lastError: message,
          });
          results.push({ entry: sending, outcome: "failed", error: message });
        }
      }
      return results;
    };

    if (typeof navigator !== "undefined" && navigator.locks) {
      return await navigator.locks.request(BROWSER_DRAIN_LOCK_NAME, drain);
    }
    return await drain();
  } finally {
    release();
  }
}
