import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProjectId,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";

import { openIndexedDatabase } from "./indexedDbOpen";
import { resolveScaffoldDraftModelSelection } from "../hooks/useHandleNewThread";

const DATABASE_NAME = "t3code:pending-turn-outbox";
const DATABASE_VERSION = 1;
const STORE_NAME = "pending-turns";
const DRAIN_EVENT = "t3code:pending-turn-outbox:drain";
const DRAIN_CHANNEL = "t3code:pending-turn-outbox";

export type PendingTurnStatus = "pending" | "sending" | "failed" | "terminal";

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
  readonly putMany: (entries: ReadonlyArray<PendingTurnOutboxEntry>) => Promise<void>;
  readonly remove: (idempotencyKey: string) => Promise<void>;
}

function announcePendingTurnDrain(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DRAIN_EVENT));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(DRAIN_CHANNEL);
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel.postMessage has no targetOrigin parameter.
    channel.postMessage("drain");
    channel.close();
  }
}

export interface PendingTurnDrainResult {
  readonly entry: PendingTurnOutboxEntry;
  readonly outcome: "acknowledged" | "sent" | "failed" | "terminal" | "deferred";
  readonly error: string | null;
}

function errorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return "The pending message could not be sent.";
}

function errorTag(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return null;
  return typeof error._tag === "string" ? error._tag : null;
}

const PERMANENT_PENDING_TURN_FAILURE_TAGS = new Set([
  "OrchestrationDispatchCommandError",
  "EnvironmentAuthorizationError",
  "EnvironmentAuthInvalidError",
  "EnvironmentScopeRequiredError",
  "EnvironmentOperationForbiddenError",
]);

/** Only declared command rejections and intentional auth failures are terminal. */
export function isPendingTurnDispatchFailureRetryable(error: unknown): boolean {
  const tag = errorTag(error);
  return tag === null || !PERMANENT_PENDING_TURN_FAILURE_TAGS.has(tag);
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
    (entry.status === "pending" ||
      entry.status === "sending" ||
      entry.status === "failed" ||
      entry.status === "terminal") &&
    typeof entry.attemptCount === "number" &&
    typeof entry.createdAt === "string" &&
    typeof entry.updatedAt === "string" &&
    (entry.lastError === null || typeof entry.lastError === "string")
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return openIndexedDatabase({
    databaseName: DATABASE_NAME,
    databaseVersion: DATABASE_VERSION,
    unavailableMessage: "IndexedDB is unavailable in this browser context.",
    openErrorMessage: "Could not open the pending-turn outbox.",
    blockedMessage:
      "Message storage is blocked by another tab. Close other T3 Code tabs and retry.",
    timeoutMessage: "Message storage did not open.",
    upgrade: (database) => {
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "idempotencyKey" });
      }
    },
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
        announcePendingTurnDrain();
      } finally {
        database.close();
      }
    },
    async putMany(entries) {
      if (entries.length === 0) return;
      const database = await openDatabase();
      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const done = transactionDone(transaction);
        const store = transaction.objectStore(STORE_NAME);
        for (const entry of entries) store.put(entry);
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
    async putMany(nextEntries) {
      for (const entry of nextEntries) entries.set(entry.idempotencyKey, entry);
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

function retargetTurnInputForScaffold(
  input: StartThreadTurnInput,
  projectId: ProjectId,
  targetProviders: ReadonlyArray<ServerProvider>,
): StartThreadTurnInput {
  const resolveSelection = (selection: ModelSelection): ModelSelection => {
    const resolved = resolveScaffoldDraftModelSelection(targetProviders, selection);
    if (resolved === null) {
      throw new Error("The target Scaffold OMP model catalog is not ready.");
    }
    return resolved;
  };
  const { bootstrap: _bootstrap, ...turnInput } = input;
  const createThread = input.bootstrap?.createThread;
  const retargetedTurnInput = {
    ...turnInput,
    ...(input.modelSelection ? { modelSelection: resolveSelection(input.modelSelection) } : {}),
  };
  if (createThread === undefined) return retargetedTurnInput;

  return {
    ...retargetedTurnInput,
    bootstrap: {
      createThread: {
        ...createThread,
        projectId,
        modelSelection: resolveSelection(createThread.modelSelection),
      },
    },
  };
}

/**
 * A Scaffold draft accepts the user's turn before the target project exists in
 * the browser projection. Once that project hydrates, preserve the accepted
 * command/message identities and user payload while replacing only
 * destination-bound routing. Local worktree preparation must never run inside
 * a sandbox that already owns its workspace.
 */
export async function retargetPendingTurnsForDraft(
  storage: PendingTurnOutboxStorage,
  draftId: string,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  targetProviders: ReadonlyArray<ServerProvider>,
): Promise<ModelSelection | null> {
  const entries = (await storage.list()).filter((entry) => entry.draftId === draftId);
  if (entries.length === 0) return null;
  const retargetedEntries = entries.map((entry) => ({
    ...entry,
    environmentId,
    input: retargetTurnInputForScaffold(entry.input, projectId, targetProviders),
  }));
  await storage.putMany(retargetedEntries);
  announcePendingTurnDrain();

  const latestAcceptedTurn = retargetedEntries.at(-1)?.input;
  return (
    latestAcceptedTurn?.modelSelection ??
    latestAcceptedTurn?.bootstrap?.createThread?.modelSelection ??
    null
  );
}

export function subscribePendingTurnDrain(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(DRAIN_EVENT, listener);
  window.addEventListener("online", listener);
  const channel =
    typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(DRAIN_CHANNEL);
  channel?.addEventListener("message", listener);
  return () => {
    window.removeEventListener(DRAIN_EVENT, listener);
    window.removeEventListener("online", listener);
    channel?.removeEventListener("message", listener);
    channel?.close();
  };
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
 * Bootstrap reconciliation belongs to the server, where each orchestration
 * phase has a durable idempotency identity. Keep this compatibility helper as
 * an identity operation so every retry sends the exact durable payload.
 */
export function reconcilePendingTurnForExistingThread(
  input: StartThreadTurnInput,
): StartThreadTurnInput {
  return input;
}

export interface PendingTurnCoordinatorAdapter {
  readonly environmentIsLive: (environmentId: EnvironmentId) => boolean;
  readonly dispatch: (entry: PendingTurnOutboxEntry) => Promise<boolean>;
}

/**
 * The background coordinator cannot safely infer thread existence from a
 * cached shell during reconnect. Wait until the environment shell is live,
 * then reconcile an ambiguously committed draft create against that
 * authoritative projection before replaying the stable command.
 */
export function createPendingTurnCoordinatorAdapter(input: {
  readonly readEnvironmentShellStatus: (environmentId: EnvironmentId) => EnvironmentShellStatus;
  /** @deprecated Replay is server-idempotent; retained for caller compatibility. */
  readonly threadExists?: (threadRef: ScopedThreadRef) => boolean;
  readonly dispatch: (input: {
    readonly environmentId: EnvironmentId;
    readonly turn: StartThreadTurnInput;
  }) => Promise<void>;
}): PendingTurnCoordinatorAdapter {
  const environmentIsLive = (environmentId: EnvironmentId) =>
    input.readEnvironmentShellStatus(environmentId) === "live";

  return {
    environmentIsLive,
    async dispatch(entry) {
      if (!environmentIsLive(entry.environmentId)) return false;

      await input.dispatch({ environmentId: entry.environmentId, turn: entry.input });
      return true;
    },
  };
}

export async function acknowledgePendingTurn(
  storage: PendingTurnOutboxStorage,
  idempotencyKey: string,
): Promise<void> {
  await storage.remove(idempotencyKey);
}

export async function discardPendingTurn(
  storage: PendingTurnOutboxStorage,
  idempotencyKey: string,
): Promise<void> {
  await storage.remove(idempotencyKey);
  announcePendingTurnDrain();
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
  const retryable = isPendingTurnDispatchFailureRetryable(error);
  await storage.put({
    ...entry,
    status: retryable ? "failed" : "terminal",
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
      const allEntries = [...(await input.storage.list())];
      const entries = allEntries.filter(
        (entry) =>
          (input.environmentId === undefined || entry.environmentId === input.environmentId) &&
          (input.threadId === undefined || entry.threadId === input.threadId) &&
          (input.idempotencyKey === undefined || entry.idempotencyKey === input.idempotencyKey),
      );
      const results: PendingTurnDrainResult[] = [];
      for (const entry of entries) {
        if (entry.status === "terminal") {
          results.push({ entry, outcome: "terminal", error: entry.lastError });
          continue;
        }

        const entryIndex = allEntries.indexOf(entry);
        const hasEarlierTurnInThread = allEntries.some(
          (candidate, candidateIndex) =>
            candidateIndex < entryIndex &&
            candidate.environmentId === entry.environmentId &&
            candidate.threadId === entry.threadId &&
            candidate.idempotencyKey !== entry.idempotencyKey,
        );
        if (hasEarlierTurnInThread) {
          results.push({ entry, outcome: "deferred", error: null });
          continue;
        }

        if ((await input.isAcknowledged?.(entry)) === true) {
          await input.storage.remove(entry.idempotencyKey);
          allEntries.splice(allEntries.indexOf(entry), 1);
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
          allEntries.splice(allEntries.indexOf(entry), 1);
          results.push({ entry: sending, outcome: "sent", error: null });
        } catch (error) {
          const message = errorMessage(error);
          const retryable = isPendingTurnDispatchFailureRetryable(error);
          await input.storage.put({
            ...sending,
            status: retryable ? "failed" : "terminal",
            updatedAt: new Date().toISOString(),
            lastError: message,
          });
          results.push({
            entry: sending,
            outcome: retryable ? "failed" : "terminal",
            error: message,
          });
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
