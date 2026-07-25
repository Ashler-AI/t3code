import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createMemoryPendingTurnOutboxStorage,
  drainPendingTurnOutbox,
  enqueuePendingTurn,
  listPendingTurnsForThread,
  reconcilePendingTurnForExistingThread,
  recordPendingTurnFailure,
  type PendingTurnOutboxEntry,
} from "./pendingTurnOutbox";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("thread-1");
const messageId = MessageId.make("message-1");
const commandId = CommandId.make("command-1");

function pendingInput(): Parameters<typeof enqueuePendingTurn>[1] {
  return {
    idempotencyKey: commandId,
    environmentId,
    threadId,
    messageId,
    draftId: "draft-1",
    createdAt: "2026-07-24T12:00:00.000Z",
    input: {
      commandId,
      threadId,
      message: {
        messageId,
        role: "user" as const,
        text: "Build the feature",
        attachments: [],
      },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      createdAt: "2026-07-24T12:00:00.000Z",
    },
  };
}

describe("pending turn outbox", () => {
  it("rehydrates and delivers a provisional first message exactly once across a restart", async () => {
    const storage = createMemoryPendingTurnOutboxStorage();
    await enqueuePendingTurn(storage, pendingInput());

    // Simulate ChatView mounting after a browser refresh. Its hydration path
    // renders outbox messages optimistically while excluding server/projected
    // message ids and ids already present in local state.
    const pendingAfterRestart = await listPendingTurnsForThread(storage, environmentId, threadId);
    const optimisticMessages = pendingAfterRestart.flatMap((entry) => [
      {
        id: entry.messageId,
        text: entry.input.message.text,
        commandId: entry.input.commandId,
      },
    ]);
    expect(optimisticMessages).toEqual([{ id: messageId, text: "Build the feature", commandId }]);

    const deliveredCommandIds: string[] = [];
    const projectedMessageIds = new Set<string>();
    await drainPendingTurnOutbox({
      storage,
      environmentId,
      threadId,
      dispatch: async (entry) => {
        expect(entry.input.commandId).toBe(entry.idempotencyKey);
        deliveredCommandIds.push(entry.idempotencyKey);
        projectedMessageIds.add(entry.messageId);
      },
    });

    // ChatView drops the provisional copy as soon as the same stable message id
    // appears in the server projection, leaving one rendered message.
    const renderedMessages = [
      ...[...projectedMessageIds].map((id) => ({ id, source: "server" as const })),
      ...optimisticMessages
        .filter((message) => !projectedMessageIds.has(message.id))
        .map((message) => ({ id: message.id, source: "optimistic" as const })),
    ];
    expect(renderedMessages).toEqual([{ id: messageId, source: "server" }]);

    // A second restart has neither another provisional message nor another
    // command to deliver.
    expect(await listPendingTurnsForThread(storage, environmentId, threadId)).toEqual([]);
    await drainPendingTurnOutbox({
      storage,
      environmentId,
      threadId,
      dispatch: async (entry) => {
        deliveredCommandIds.push(entry.idempotencyKey);
      },
    });
    expect(deliveredCommandIds).toEqual([commandId]);
  });

  it("persists one entry for a stable idempotency key", async () => {
    const storage = createMemoryPendingTurnOutboxStorage();

    await enqueuePendingTurn(storage, pendingInput());
    await enqueuePendingTurn(storage, pendingInput());

    const entries = await listPendingTurnsForThread(storage, environmentId, threadId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      idempotencyKey: commandId,
      status: "pending",
      attemptCount: 0,
    });
  });

  it("preserves generic file payloads for a provisional first turn retry", async () => {
    const storage = createMemoryPendingTurnOutboxStorage();
    const baseInput = pendingInput();
    const input: Parameters<typeof enqueuePendingTurn>[1] = {
      ...baseInput,
      input: {
        ...baseInput.input,
        message: {
          ...baseInput.input.message,
          attachments: [
            {
              type: "file",
              name: "diagnostics.zip",
              mimeType: "application/zip",
              sizeBytes: 3,
              dataUrl: "data:application/zip;base64,AQID",
            },
          ],
        },
      },
    };

    await enqueuePendingTurn(storage, input);
    await recordPendingTurnFailure(storage, commandId, new Error("offline"));

    const [entry] = await listPendingTurnsForThread(storage, environmentId, threadId);
    expect(entry?.input.message.attachments).toEqual(input.input.message.attachments);
  });

  it("persists a pre-readiness turn and drains concurrent requests exactly once", async () => {
    const storage = createMemoryPendingTurnOutboxStorage();
    await enqueuePendingTurn(storage, pendingInput());
    let releaseDispatch!: () => void;
    const readiness = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const dispatch = vi.fn(async () => readiness);

    const firstDrain = drainPendingTurnOutbox({ storage, dispatch });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(await storage.list()).toMatchObject([{ status: "sending", attemptCount: 1 }]);

    const secondDrain = drainPendingTurnOutbox({ storage, dispatch });
    releaseDispatch();
    await Promise.all([firstDrain, secondDrain]);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await storage.list()).toEqual([]);
  });

  it("keeps failures visible and retries with the same command and message ids", async () => {
    const storage = createMemoryPendingTurnOutboxStorage();
    await enqueuePendingTurn(storage, pendingInput());
    const seen: PendingTurnOutboxEntry[] = [];

    const first = await drainPendingTurnOutbox({
      storage,
      dispatch: async (entry) => {
        seen.push(entry);
        throw new Error("offline");
      },
    });
    expect(first[0]).toMatchObject({ outcome: "failed", error: "offline" });
    expect(await storage.list()).toMatchObject([
      { status: "failed", attemptCount: 1, lastError: "offline" },
    ]);

    await drainPendingTurnOutbox({
      storage,
      dispatch: async (entry) => {
        seen.push(entry);
      },
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.input.commandId).toBe(commandId);
    expect(seen[1]?.input.commandId).toBe(commandId);
    expect(seen[1]?.messageId).toBe(messageId);
    expect(await storage.list()).toEqual([]);
  });

  it("records an immediate dispatch failure without replacing the durable payload", async () => {
    const storage = createMemoryPendingTurnOutboxStorage();
    await enqueuePendingTurn(storage, pendingInput());

    await recordPendingTurnFailure(storage, commandId, new Error("worktree unavailable"));

    expect(await storage.list()).toMatchObject([
      {
        status: "failed",
        attemptCount: 1,
        lastError: "worktree unavailable",
        input: {
          commandId,
          message: { messageId, text: "Build the feature" },
        },
      },
    ]);
  });

  it("removes an already acknowledged entry without dispatching it", async () => {
    const storage = createMemoryPendingTurnOutboxStorage();
    await enqueuePendingTurn(storage, pendingInput());
    const dispatch = vi.fn(async () => undefined);

    const result = await drainPendingTurnOutbox({
      storage,
      dispatch,
      isAcknowledged: (entry) => entry.messageId === messageId,
    });

    expect(result[0]?.outcome).toBe("acknowledged");
    expect(dispatch).not.toHaveBeenCalled();
    expect(await storage.list()).toEqual([]);
  });

  it("replays a committed draft create exactly once without changing first-turn identities", async () => {
    const base = pendingInput();
    const input = {
      ...base.input,
      bootstrap: {
        createThread: {
          projectId: "project-1" as never,
          title: "Build the feature",
          modelSelection: {
            instanceId: "codex" as never,
            model: "gpt-5.4",
          },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: "main",
          worktreePath: null,
          createdAt: base.createdAt,
        },
        prepareWorktree: {
          projectCwd: "/repo",
          baseBranch: "main",
          branch: "t3/thread-1",
        },
        runSetupScript: true,
      },
    };

    const reconciled = reconcilePendingTurnForExistingThread(input);

    expect(reconciled).toMatchObject({
      commandId,
      threadId,
      message: { messageId },
      bootstrap: {
        prepareWorktree: input.bootstrap.prepareWorktree,
        runSetupScript: true,
      },
    });
    expect(reconciled.bootstrap).not.toHaveProperty("createThread");

    const storage = createMemoryPendingTurnOutboxStorage();
    await enqueuePendingTurn(storage, { ...base, input });
    const dispatched: PendingTurnOutboxEntry[] = [];
    await drainPendingTurnOutbox({
      storage,
      dispatch: async (entry) => {
        dispatched.push(entry);
        throw new Error("connection lost after thread.create committed");
      },
    });
    await drainPendingTurnOutbox({
      storage,
      dispatch: async (entry) => {
        dispatched.push({
          ...entry,
          input: reconcilePendingTurnForExistingThread(entry.input),
        });
      },
    });

    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]?.input.bootstrap).toHaveProperty("createThread");
    expect(dispatched[1]?.input.bootstrap).not.toHaveProperty("createThread");
    expect(dispatched.map((entry) => entry.input.commandId)).toEqual([commandId, commandId]);
    expect(dispatched.map((entry) => entry.messageId)).toEqual([messageId, messageId]);
    expect(await storage.list()).toEqual([]);
  });
});
