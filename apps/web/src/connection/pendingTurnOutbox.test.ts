import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createMemoryPendingTurnOutboxStorage,
  createPendingTurnCoordinatorAdapter,
  discardPendingTurn,
  drainPendingTurnOutbox,
  enqueuePendingTurn,
  isPendingTurnDispatchFailureRetryable,
  listPendingTurnsForThread,
  reconcilePendingTurnForExistingThread,
  recordPendingTurnFailure,
  retargetPendingTurnsForDraft,
  type PendingTurnOutboxEntry,
  type PendingTurnOutboxStorage,
} from "./pendingTurnOutbox";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("thread-1");
const messageId = MessageId.make("message-1");
const commandId = CommandId.make("command-1");
const targetProviders: ReadonlyArray<ServerProvider> = [
  {
    instanceId: ProviderInstanceId.make("omp"),
    driver: ProviderDriverKind.make("omp"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-27T00:00:00.000Z",
    models: [
      {
        slug: "openai/gpt-5.6-sol",
        name: "GPT-5.6-Sol",
        isCustom: false,
        isDefault: true,
        capabilities: {},
      },
    ],
    slashCommands: [],
    skills: [],
  },
];

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
  afterEach(() => vi.unstubAllGlobals());

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

  it("retargets a prepared Scaffold command to the hydrated sandbox project", async () => {
    const storage = createMemoryPendingTurnOutboxStorage();
    const pending = pendingInput();
    const sourceProjectId = ProjectId.make("source-project");
    const targetProjectId = ProjectId.make("target-project");
    const accepted = await enqueuePendingTurn(storage, {
      ...pending,
      input: {
        ...pending.input,
        modelSelection: {
          instanceId: "omp" as never,
          model: "openai-codex/gpt-5.6-sol",
          options: [{ id: "reasoning_effort", value: "high" }],
        },
        bootstrap: {
          createThread: {
            projectId: sourceProjectId,
            title: "Build the feature",
            modelSelection: {
              instanceId: "omp" as never,
              model: "openai-codex/gpt-5.6-sol",
              options: [{ id: "reasoning_effort", value: "high" }],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature/source",
            worktreePath: null,
            createdAt: pending.createdAt,
          },
          prepareWorktree: {
            projectCwd: "/Users/example/source-repo",
            baseBranch: "feature/source",
            branch: "t3/thread-1",
          },
          runSetupScript: true,
        },
      },
    });
    const targetEnvironmentId = EnvironmentId.make("scaffold-session");

    await retargetPendingTurnsForDraft(
      storage,
      "draft-1",
      targetEnvironmentId,
      targetProjectId,
      targetProviders,
    );

    const [retargeted] = await storage.list();
    expect(retargeted?.environmentId).toBe(targetEnvironmentId);
    expect(retargeted?.idempotencyKey).toBe(accepted.idempotencyKey);
    expect(retargeted?.messageId).toBe(accepted.messageId);
    expect(retargeted?.input).toMatchObject({
      commandId,
      threadId,
      message: accepted.input.message,
      modelSelection: {
        instanceId: "omp",
        model: "openai/gpt-5.6-sol",
        options: [{ id: "reasoning_effort", value: "high" }],
      },
      bootstrap: {
        createThread: {
          ...accepted.input.bootstrap?.createThread,
          projectId: targetProjectId,
          modelSelection: {
            instanceId: "omp",
            model: "openai/gpt-5.6-sol",
            options: [{ id: "reasoning_effort", value: "high" }],
          },
        },
      },
    });
    expect(retargeted?.input.bootstrap).not.toHaveProperty("prepareWorktree");
    expect(retargeted?.input.bootstrap).not.toHaveProperty("runSetupScript");
  });

  it("does not dispatch a ready Scaffold draft locally before retargeting, then sends once remotely", async () => {
    const storage = createMemoryPendingTurnOutboxStorage();
    const sourceEnvironmentId = EnvironmentId.make("environment-source");
    const provisionalEnvironmentId = EnvironmentId.make("scaffold-pending:draft-1");
    const targetEnvironmentId = EnvironmentId.make("environment-scaffold");
    const targetProjectId = ProjectId.make("project-scaffold");
    const pending = pendingInput();
    await enqueuePendingTurn(storage, {
      ...pending,
      environmentId: provisionalEnvironmentId,
    });

    const localDispatch = vi.fn(async () => undefined);
    await drainPendingTurnOutbox({
      storage,
      environmentId: sourceEnvironmentId,
      threadId,
      dispatch: localDispatch,
    });
    expect(localDispatch).not.toHaveBeenCalled();

    await retargetPendingTurnsForDraft(
      storage,
      "draft-1",
      targetEnvironmentId,
      targetProjectId,
      targetProviders,
    );
    const remoteDispatch = vi.fn(async () => undefined);
    await drainPendingTurnOutbox({
      storage,
      environmentId: targetEnvironmentId,
      threadId,
      dispatch: remoteDispatch,
    });

    expect(remoteDispatch).toHaveBeenCalledTimes(1);
    expect(remoteDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: targetEnvironmentId,
        idempotencyKey: commandId,
      }),
    );
    expect(await storage.list()).toEqual([]);
  });

  it("atomically retargets every draft turn before one drain announcement", async () => {
    const memoryStorage = createMemoryPendingTurnOutboxStorage();
    await enqueuePendingTurn(memoryStorage, pendingInput());
    const laterCommandId = CommandId.make("command-2");
    const laterMessageId = MessageId.make("message-2");
    const later = pendingInput();
    await enqueuePendingTurn(memoryStorage, {
      ...later,
      idempotencyKey: laterCommandId,
      messageId: laterMessageId,
      createdAt: "2026-07-24T12:01:00.000Z",
      input: {
        ...later.input,
        commandId: laterCommandId,
        message: { ...later.input.message, messageId: laterMessageId, text: "Follow up" },
      },
    });

    const writeCompletionOrder: string[] = [];
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const put = vi.fn(async (_entry: PendingTurnOutboxEntry) => {
      throw new Error("Retargeting must not expose per-entry writes.");
    });
    const storage: PendingTurnOutboxStorage = {
      list: memoryStorage.list,
      put,
      putMany: async (entries) => {
        const prepared = await Promise.all(
          entries.map(async (entry, index) => {
            if (index === 0) await firstWriteBlocked;
            else releaseFirstWrite();
            writeCompletionOrder.push(entry.idempotencyKey);
            return entry;
          }),
        );
        await memoryStorage.putMany(prepared);
      },
      remove: memoryStorage.remove,
    };
    const dispatchEvent = vi.fn();
    const postMessage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        postMessage = postMessage;
        close = close;
      },
    );

    await retargetPendingTurnsForDraft(
      storage,
      "draft-1",
      EnvironmentId.make("scaffold-session"),
      ProjectId.make("target-project"),
      targetProviders,
    );

    expect(writeCompletionOrder).toEqual([laterCommandId, commandId]);
    expect(put).not.toHaveBeenCalled();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    const dispatched: string[] = [];
    await drainPendingTurnOutbox({
      storage: memoryStorage,
      dispatch: async (entry) => {
        dispatched.push(entry.idempotencyKey);
      },
    });
    expect(dispatched).toEqual([commandId, laterCommandId]);
  });

  it("durably queues later turns with their own immutable command and message ids", async () => {
    const storage = createMemoryPendingTurnOutboxStorage();
    await enqueuePendingTurn(storage, pendingInput());
    const laterCommandId = CommandId.make("command-2");
    const laterMessageId = MessageId.make("message-2");
    const later = pendingInput();
    await enqueuePendingTurn(storage, {
      ...later,
      idempotencyKey: laterCommandId,
      messageId: laterMessageId,
      createdAt: "2026-07-24T12:01:00.000Z",
      input: {
        ...later.input,
        commandId: laterCommandId,
        message: { ...later.input.message, messageId: laterMessageId, text: "Follow up" },
      },
    });

    expect(await storage.list()).toMatchObject([
      { idempotencyKey: commandId, messageId },
      { idempotencyKey: laterCommandId, messageId: laterMessageId },
    ]);
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

  it("uses the browser lock to coordinate drains across tabs", async () => {
    const storage = createMemoryPendingTurnOutboxStorage();
    await enqueuePendingTurn(storage, pendingInput());
    const request = vi.fn(async (_name: string, callback: () => Promise<ReadonlyArray<unknown>>) =>
      callback(),
    );
    vi.stubGlobal("navigator", { locks: { request } });
    const dispatch = vi.fn(async () => undefined);

    await Promise.all([
      drainPendingTurnOutbox({ storage, dispatch }),
      drainPendingTurnOutbox({ storage, dispatch }),
    ]);

    expect(request).toHaveBeenCalledWith("t3code:pending-turn-outbox:drain", expect.any(Function));
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

  it("retries transient and ambiguous dispatch failures", () => {
    expect(
      isPendingTurnDispatchFailureRetryable({
        _tag: "EnvironmentRpcUnavailableError",
        message: "Local is not connected.",
      }),
    ).toBe(true);
    expect(isPendingTurnDispatchFailureRetryable(new Error("SocketCloseError: reset"))).toBe(true);
    expect(isPendingTurnDispatchFailureRetryable(new Error("unexpected client defect"))).toBe(true);
  });

  it("retries unknown tagged dispatch failures", () => {
    expect(
      isPendingTurnDispatchFailureRetryable({
        _tag: "UnexpectedProviderFailure",
        message: "The provider returned a new failure shape.",
      }),
    ).toBe(true);
  });

  it("makes intentional authentication and scope failures terminal", () => {
    expect(
      [
        "EnvironmentAuthorizationError",
        "EnvironmentAuthInvalidError",
        "EnvironmentScopeRequiredError",
        "EnvironmentOperationForbiddenError",
      ].every((_tag) => !isPendingTurnDispatchFailureRetryable({ _tag, message: "denied" })),
    ).toBe(true);
  });

  it("makes declared command failures terminal and never resends them", async () => {
    const storage = createMemoryPendingTurnOutboxStorage();
    await enqueuePendingTurn(storage, pendingInput());
    const dispatch = vi.fn(async () => {
      throw {
        _tag: "OrchestrationDispatchCommandError",
        message: "Invalid model selection",
      };
    });

    const first = await drainPendingTurnOutbox({ storage, dispatch });
    const second = await drainPendingTurnOutbox({ storage, dispatch });

    expect(first[0]).toMatchObject({ outcome: "terminal", error: "Invalid model selection" });
    expect(second[0]).toMatchObject({ outcome: "terminal", error: "Invalid model selection" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await storage.list()).toMatchObject([
      { status: "terminal", attemptCount: 1, lastError: "Invalid model selection" },
    ]);

    await discardPendingTurn(storage, commandId);
    expect(await storage.list()).toEqual([]);
  });

  it("does not send a later turn ahead of a failed earlier turn", async () => {
    const storage = createMemoryPendingTurnOutboxStorage();
    await enqueuePendingTurn(storage, pendingInput());
    const later = pendingInput();
    const laterCommandId = CommandId.make("command-2");
    const laterMessageId = MessageId.make("message-2");
    await enqueuePendingTurn(storage, {
      ...later,
      idempotencyKey: laterCommandId,
      messageId: laterMessageId,
      createdAt: "2026-07-24T12:01:00.000Z",
      input: {
        ...later.input,
        commandId: laterCommandId,
        message: { ...later.input.message, messageId: laterMessageId },
      },
    });
    const dispatch = vi.fn(async (entry: PendingTurnOutboxEntry) => {
      if (entry.idempotencyKey === commandId) throw new Error("offline");
    });

    const results = await drainPendingTurnOutbox({ storage, dispatch });

    expect(results.map((result) => result.outcome)).toEqual(["failed", "deferred"]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: commandId }));
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

  it("replays the byte-equivalent bootstrap after the live shell hydrates the existing thread", async () => {
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
    });
    expect(reconciled).toBe(input);

    const storage = createMemoryPendingTurnOutboxStorage();
    await enqueuePendingTurn(storage, { ...base, input });
    const threadCreatedEvents: string[] = [];
    const firstAttempt = await drainPendingTurnOutbox({
      storage,
      dispatch: async (entry) => {
        threadCreatedEvents.push(entry.threadId);
        throw new Error("connection lost after thread.create committed");
      },
    });
    expect(firstAttempt).toMatchObject([{ outcome: "failed" }]);

    let shellStatus: EnvironmentShellStatus = "cached";
    const coordinatorDispatches: Array<{
      readonly environmentId: EnvironmentId;
      readonly turn: PendingTurnOutboxEntry["input"];
    }> = [];
    const coordinator = createPendingTurnCoordinatorAdapter({
      readEnvironmentShellStatus: () => shellStatus,
      dispatch: async (dispatchInput) => {
        coordinatorDispatches.push(dispatchInput);
      },
    });
    const [waitingEntry] = await storage.list();
    expect(waitingEntry).toBeDefined();
    expect(await coordinator.dispatch(waitingEntry!)).toBe(false);
    expect(coordinatorDispatches).toEqual([]);

    shellStatus = "live";
    const retry = await drainPendingTurnOutbox({
      storage,
      dispatch: async (entry) => {
        expect(await coordinator.dispatch(entry)).toBe(true);
      },
    });

    expect(retry).toMatchObject([{ outcome: "sent" }]);
    expect(coordinatorDispatches).toHaveLength(1);
    expect(coordinatorDispatches[0]).toMatchObject({
      environmentId,
      turn: {
        commandId,
        message: { messageId },
      },
    });
    expect(coordinatorDispatches[0]?.turn).toBe(input);
    expect(coordinatorDispatches[0]?.turn.bootstrap).toEqual(input.bootstrap);
    expect(threadCreatedEvents).toEqual([threadId]);
    expect(await storage.list()).toEqual([]);
  });

  it("keeps a first-turn bootstrap unchanged when the live shell has no thread", async () => {
    const pending = pendingInput();
    const input = {
      ...pending.input,
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
          createdAt: pending.createdAt,
        },
      },
    };
    const entry = await enqueuePendingTurn(createMemoryPendingTurnOutboxStorage(), {
      ...pending,
      input,
    });
    const dispatch = vi.fn(async () => undefined);
    const coordinator = createPendingTurnCoordinatorAdapter({
      readEnvironmentShellStatus: () => "live",
      dispatch,
    });

    expect(await coordinator.dispatch(entry)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ environmentId, turn: input });
  });
});
