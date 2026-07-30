import { DraftId } from "../composerDraftStore";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ScaffoldLifecycleActionStore } from "@t3tools/client-runtime/scaffold";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createIndexedDbScaffoldLifecycleActionStore,
  createMemoryScaffoldLifecycleActionStore,
  createScaffoldLifecycleDrainRunner,
  drainScaffoldLifecycleActions,
  enqueueScaffoldLifecycleAction,
  makeScaffoldCreateAction,
  makeScaffoldPauseAction,
  retryScaffoldLifecycleAction,
  resolveScaffoldLifecycleRetryDelay,
  scaffoldPauseInputFromAction,
  subscribeScaffoldLifecycleDrain,
} from "./scaffoldLifecycleOutbox";

function makeIndexedDbWithRows(initial: ReadonlyArray<unknown>): {
  readonly database: IDBDatabase;
  readonly rows: Map<IDBValidKey, unknown>;
} {
  const rows = new Map<IDBValidKey, unknown>();
  for (const row of initial) {
    if (typeof row === "object" && row !== null && "actionId" in row) {
      rows.set(String(row.actionId), row);
    }
  }

  const database = {
    close: () => undefined,
    transaction: () => {
      const transaction = new EventTarget() as IDBTransaction;
      const objectStore = {
        getAll: () => {
          const request = new EventTarget() as IDBRequest<unknown[]>;
          Object.defineProperty(request, "result", { value: [...rows.values()] });
          queueMicrotask(() => {
            request.dispatchEvent(new Event("success"));
            transaction.dispatchEvent(new Event("complete"));
          });
          return request;
        },
        put: (value: unknown) => {
          if (typeof value === "object" && value !== null && "actionId" in value) {
            rows.set(String(value.actionId), structuredClone(value));
          }
          queueMicrotask(() => transaction.dispatchEvent(new Event("complete")));
        },
        delete: (key: IDBValidKey) => {
          rows.delete(key);
          queueMicrotask(() => transaction.dispatchEvent(new Event("complete")));
        },
      } as IDBObjectStore;
      Object.defineProperty(transaction, "objectStore", { value: () => objectStore });
      return transaction;
    },
  } as unknown as IDBDatabase;

  return { database, rows };
}

function makeSerializedNavigatorLocks() {
  let tail: Promise<void> = Promise.resolve();
  let active = 0;
  let maxActive = 0;
  const request = <A>(_name: string, run: () => Promise<A> | A): Promise<A> => {
    const result = tail.then(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await run();
      } finally {
        active -= 1;
      }
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    navigator: { locks: { request } },
    maxActive: () => maxActive,
  };
}

describe("Scaffold lifecycle browser outbox", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reruns a drain when a wake arrives while the current pass is active", async () => {
    let releaseFirstRun: (() => void) | undefined;
    const firstRun = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    const runs: Array<string | undefined> = [];
    const onIdle = vi.fn(async () => undefined);
    const runner = createScaffoldLifecycleDrainRunner({
      run: async (actionId) => {
        runs.push(actionId);
        if (runs.length === 1) await firstRun;
      },
      onIdle,
      onError: (error) => {
        throw error;
      },
    });

    const active = runner.drain("op_first");
    await vi.waitFor(() => expect(runs).toEqual(["op_first"]));
    const queued = runner.drain("op_second");
    releaseFirstRun?.();
    await Promise.all([active, queued]);

    expect(runs).toEqual(["op_first", undefined]);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("preserves a queued wake and rearms retry scheduling after a rejected drain", async () => {
    let rejectFirstRun: ((error: Error) => void) | undefined;
    const firstRun = new Promise<void>((_resolve, reject) => {
      rejectFirstRun = reject;
    });
    const runs: Array<string | undefined> = [];
    const onIdle = vi.fn(async () => undefined);
    const onError = vi.fn();
    const runner = createScaffoldLifecycleDrainRunner({
      run: async (actionId) => {
        runs.push(actionId);
        if (runs.length === 1) await firstRun;
      },
      onIdle,
      onError,
    });

    const active = runner.drain("op_first");
    await vi.waitFor(() => expect(runs).toEqual(["op_first"]));
    const queued = runner.drain("op_second");
    rejectFirstRun?.(new Error("temporary failure"));
    await Promise.all([active, queued]);

    expect(runs).toEqual(["op_first", undefined]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("does not schedule a retry after disposal wins a pending outbox read", async () => {
    let releaseList:
      | ((actions: Awaited<ReturnType<ScaffoldLifecycleActionStore["list"]>>) => void)
      | undefined;
    const list = new Promise<Awaited<ReturnType<ScaffoldLifecycleActionStore["list"]>>>(
      (resolve) => {
        releaseList = resolve;
      },
    );
    const store: ScaffoldLifecycleActionStore = {
      list: () => list,
      put: async () => undefined,
      remove: async () => undefined,
    };
    let disposed = false;
    const retryDelay = resolveScaffoldLifecycleRetryDelay({
      store,
      isDisposed: () => disposed,
      now: () => 100,
    });

    disposed = true;
    releaseList?.([
      makeScaffoldCreateAction({
        draftId: DraftId.make("draft-disposed"),
        deployment: "production",
        sourceEnvironmentId: EnvironmentId.make("source-environment"),
        sourceProjectId: ProjectId.make("source-project"),
        create: { name: "Disposed", modelRouteId: "openai/gpt-5.6-sol", agentEffort: "high" },
        createdAt: "2026-07-29T00:00:00.000Z",
      }),
    ]);

    await expect(retryDelay).resolves.toBeNull();
  });

  it("wakes overdue lifecycle work when the page returns to the foreground", () => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal(
      "document",
      Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState }),
    );
    const listener = vi.fn();
    const unsubscribe = subscribeScaffoldLifecycleDrain(listener);

    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    window.dispatchEvent(new Event("pageshow"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("decodes structured-cloned actions and ignores malformed persisted rows", async () => {
    const action = makeScaffoldCreateAction({
      draftId: DraftId.make("draft-structured-clone"),
      deployment: "production",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      create: {
        name: "Ashler",
        modelRouteId: "scaffold-openai/gpt-5.6-sol",
        agentEffort: "high",
      },
      createdAt: "2026-07-24T20:00:00.000Z",
      uuid: vi
        .fn()
        .mockReturnValueOnce("action")
        .mockReturnValueOnce("connection")
        .mockReturnValueOnce("session"),
    });
    const { database, rows } = makeIndexedDbWithRows([
      { ...structuredClone(action), persistenceVersion: 1 },
      { actionId: "malformed", kind: "create" },
    ]);
    const store = createIndexedDbScaffoldLifecycleActionStore(async () => database);
    const attempts: Array<{ actionId: string; deployment: string | undefined }> = [];

    await expect(store.list()).resolves.toMatchObject([
      {
        actionId: "op_action",
        sessionId: "ses_session",
        kind: "create",
        deployment: "production",
        create: {
          name: "Ashler",
          modelRouteId: "scaffold-openai/gpt-5.6-sol",
          agentEffort: "high",
        },
      },
    ]);
    await drainScaffoldLifecycleActions({
      store,
      execute: async (pending) => {
        attempts.push({
          actionId: pending.actionId,
          deployment: pending.kind === "create" ? pending.deployment : undefined,
        });
        return { _tag: "acknowledged" };
      },
    });

    expect(attempts).toEqual([{ actionId: "op_action", deployment: "production" }]);
    expect(rows.has("op_action")).toBe(false);
    expect(rows.has("malformed")).toBe(true);
  });

  it("quarantines targetless legacy creates and refuses a projected-target retry", async () => {
    const actions = Array.from({ length: 4 }, (_, index) => {
      const suffix = String(index + 1);
      return makeScaffoldCreateAction({
        draftId: DraftId.make(`draft-${suffix}`),
        deployment: "production",
        sourceEnvironmentId: EnvironmentId.make("source-environment"),
        sourceProjectId: ProjectId.make("source-project"),
        create: { name: `Production ${suffix}` },
        createdAt: `2026-07-24T20:00:0${index}.000Z`,
        uuid: vi
          .fn()
          .mockReturnValueOnce(`action-${suffix}`)
          .mockReturnValueOnce(`connection-${suffix}`)
          .mockReturnValueOnce(`session-${suffix}`),
      });
    });
    const { database, rows } = makeIndexedDbWithRows(
      actions.map((action) => {
        const legacy = structuredClone(action);
        if (legacy.kind === "create") Reflect.deleteProperty(legacy, "deployment");
        return legacy;
      }),
    );
    const store = createIndexedDbScaffoldLifecycleActionStore(async () => database);
    const attempts: Array<{
      actionId: string;
      connectionId: string;
      sessionId: string;
      deployment: string | undefined;
    }> = [];
    const selected = actions[2]!;

    const quarantined = await store.list();
    expect(quarantined).toHaveLength(4);
    expect(quarantined).toMatchObject(
      actions.map((action) => ({
        actionId: action.actionId,
        sessionId: action.sessionId,
        blocked: true,
        lastErrorCode: "legacy_create_missing_authority",
      })),
    );
    await drainScaffoldLifecycleActions({
      store,
      execute: async (pending) => {
        attempts.push({
          actionId: pending.actionId,
          connectionId: pending.connectionId,
          sessionId: pending.sessionId,
          deployment: pending.kind === "create" ? pending.deployment : undefined,
        });
        return { _tag: "acknowledged" };
      },
    });
    expect(attempts).toEqual([]);

    const retryTransitions: string[] = [];
    await expect(
      retryScaffoldLifecycleAction({
        store,
        actionId: selected.actionId,
        expectedDeployment: "production",
        expectedDraftId: DraftId.make("draft-3"),
        expectedSourceEnvironmentId: EnvironmentId.make("source-environment"),
        expectedSourceProjectId: ProjectId.make("source-project"),
        expectedSessionId: selected.sessionId,
        onCreating: () => retryTransitions.push("creating"),
        onPersistenceFailure: () => retryTransitions.push("failed"),
      }),
    ).resolves.toBeUndefined();
    expect(retryTransitions).toEqual([]);
    await drainScaffoldLifecycleActions({
      store,
      actionId: selected.actionId,
      execute: async (pending) => {
        attempts.push({
          actionId: pending.actionId,
          connectionId: pending.connectionId,
          sessionId: pending.sessionId,
          deployment: pending.kind === "create" ? pending.deployment : undefined,
        });
        return { _tag: "acknowledged" };
      },
    });

    expect(attempts).toEqual([]);
    expect(rows.get(selected.actionId)).toMatchObject({
      actionId: selected.actionId,
      blocked: true,
      lastErrorCode: "legacy_create_missing_authority",
    });
    expect(rows.size).toBe(4);
  });

  it("does not retarget an existing create action during explicit retry", async () => {
    const action = makeScaffoldCreateAction({
      draftId: DraftId.make("draft-target-mismatch"),
      deployment: "staging",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      create: { name: "Staging" },
      createdAt: "2026-07-24T20:00:00.000Z",
      uuid: vi
        .fn()
        .mockReturnValueOnce("action")
        .mockReturnValueOnce("connection")
        .mockReturnValueOnce("session"),
    });
    const store = createMemoryScaffoldLifecycleActionStore([
      { ...action, blocked: true, lastErrorCode: "network" },
    ]);

    await expect(
      retryScaffoldLifecycleAction({
        store,
        actionId: action.actionId,
        expectedDeployment: "production",
        expectedDraftId: DraftId.make("draft-target-mismatch"),
        expectedSourceEnvironmentId: EnvironmentId.make("source-environment"),
        expectedSourceProjectId: ProjectId.make("source-project"),
        expectedSessionId: action.sessionId,
        onCreating: () => {
          throw new Error("must not transition a mismatched action");
        },
        onPersistenceFailure: () => {
          throw new Error("must not handle persistence for a mismatched action");
        },
      }),
    ).resolves.toBeUndefined();
    await expect(store.list()).resolves.toMatchObject([
      { actionId: action.actionId, deployment: "staging", blocked: true },
    ]);
  });

  it("refuses a contradictory UI target for an actual pre-authority create row", async () => {
    const current = makeScaffoldCreateAction({
      draftId: DraftId.make("draft-pre-authority"),
      deployment: "production",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      create: { name: "Production" },
      uuid: vi
        .fn()
        .mockReturnValueOnce("action")
        .mockReturnValueOnce("connection")
        .mockReturnValueOnce("session"),
    });
    const legacy = structuredClone(current);
    if (legacy.kind !== "create") throw new Error("expected create action");
    Reflect.deleteProperty(legacy, "deployment");
    Reflect.deleteProperty(legacy, "draftId");
    Reflect.deleteProperty(legacy, "sourceEnvironmentId");
    Reflect.deleteProperty(legacy, "sourceProjectId");
    const { database, rows } = makeIndexedDbWithRows([legacy]);
    const store = createIndexedDbScaffoldLifecycleActionStore(async () => database);
    const transitions: string[] = [];

    await expect(store.list()).resolves.toMatchObject([
      {
        actionId: current.actionId,
        blocked: true,
        lastErrorCode: "legacy_create_missing_authority",
      },
    ]);
    await expect(
      retryScaffoldLifecycleAction({
        store,
        actionId: current.actionId,
        expectedDeployment: "staging",
        expectedDraftId: DraftId.make("draft-pre-authority"),
        expectedSourceEnvironmentId: EnvironmentId.make("source-environment"),
        expectedSourceProjectId: ProjectId.make("source-project"),
        expectedSessionId: current.sessionId,
        onCreating: () => transitions.push("creating"),
        onPersistenceFailure: () => transitions.push("failed"),
      }),
    ).resolves.toBeUndefined();
    expect(transitions).toEqual([]);
    await expect(store.list()).resolves.toMatchObject([
      {
        actionId: current.actionId,
        blocked: true,
        lastErrorCode: "legacy_create_missing_authority",
      },
    ]);
    expect(rows.get(current.actionId)).toMatchObject({
      persistenceVersion: 1,
      blocked: true,
      lastErrorCode: "legacy_create_missing_authority",
    });
    expect(rows.get(current.actionId)).not.toHaveProperty("deployment");
    const migratedRow = rows.get(current.actionId);
    await expect(store.list()).resolves.toMatchObject([
      {
        actionId: current.actionId,
        blocked: true,
        lastErrorCode: "legacy_create_missing_authority",
      },
    ]);
    expect(rows.get(current.actionId)).toBe(migratedRow);
  });

  it("refuses to retry an authoritative create from mismatched UI identity", async () => {
    const current = makeScaffoldCreateAction({
      draftId: DraftId.make("draft-pre-authority-mismatch"),
      deployment: "production",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      create: { name: "Production" },
      uuid: vi
        .fn()
        .mockReturnValueOnce("action")
        .mockReturnValueOnce("connection")
        .mockReturnValueOnce("session"),
    });
    const store = createMemoryScaffoldLifecycleActionStore([
      { ...current, blocked: true, lastErrorCode: "network" },
    ]);
    const transitions: string[] = [];

    await expect(
      retryScaffoldLifecycleAction({
        store,
        actionId: current.actionId,
        expectedDeployment: "production",
        expectedDraftId: DraftId.make("different-draft"),
        expectedSourceEnvironmentId: EnvironmentId.make("source-environment"),
        expectedSourceProjectId: ProjectId.make("source-project"),
        expectedSessionId: current.sessionId,
        onCreating: () => transitions.push("creating"),
        onPersistenceFailure: () => transitions.push("failed"),
      }),
    ).resolves.toBeUndefined();
    expect(transitions).toEqual([]);
    await expect(store.list()).resolves.toMatchObject([
      {
        actionId: current.actionId,
        blocked: true,
        lastErrorCode: "network",
      },
    ]);
  });

  it("rolls the UI back to failed when an explicit retry cannot be persisted", async () => {
    const action = makeScaffoldCreateAction({
      draftId: DraftId.make("draft-persistence-failure"),
      deployment: "production",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      create: { name: "Production" },
      uuid: vi
        .fn()
        .mockReturnValueOnce("action")
        .mockReturnValueOnce("connection")
        .mockReturnValueOnce("session"),
    });
    const base = createMemoryScaffoldLifecycleActionStore([
      { ...action, blocked: true, lastErrorCode: "network" },
    ]);
    const store = {
      ...base,
      put: async () => {
        throw new Error("write failed");
      },
    };
    const transitions: string[] = [];

    await expect(
      retryScaffoldLifecycleAction({
        store,
        actionId: action.actionId,
        expectedDeployment: "production",
        expectedDraftId: DraftId.make("draft-persistence-failure"),
        expectedSourceEnvironmentId: EnvironmentId.make("source-environment"),
        expectedSourceProjectId: ProjectId.make("source-project"),
        expectedSessionId: action.sessionId,
        onCreating: () => transitions.push("creating"),
        onPersistenceFailure: () => transitions.push("failed"),
      }),
    ).rejects.toThrow("write failed");
    expect(transitions).toEqual(["creating", "failed"]);
    await expect(base.list()).resolves.toMatchObject([
      { actionId: action.actionId, blocked: true, lastErrorCode: "network" },
    ]);
  });

  it("persists the exact volatile create action when the initial enqueue left no row", async () => {
    const action = makeScaffoldCreateAction({
      draftId: DraftId.make("draft-volatile-retry"),
      deployment: "production",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      create: { name: "Production" },
      uuid: vi
        .fn()
        .mockReturnValueOnce("action")
        .mockReturnValueOnce("connection")
        .mockReturnValueOnce("session"),
    });
    const store = createMemoryScaffoldLifecycleActionStore();
    const transitions: string[] = [];

    await expect(
      retryScaffoldLifecycleAction({
        store,
        actionId: action.actionId,
        expectedDeployment: "production",
        expectedDraftId: DraftId.make("draft-volatile-retry"),
        expectedSourceEnvironmentId: EnvironmentId.make("source-environment"),
        expectedSourceProjectId: ProjectId.make("source-project"),
        expectedSessionId: action.sessionId,
        volatileCreateAction: action,
        onCreating: () => transitions.push("creating"),
        onPersistenceFailure: () => transitions.push("failed"),
      }),
    ).resolves.toMatchObject({
      actionId: action.actionId,
      deployment: "production",
      draftId: "draft-volatile-retry",
      blocked: false,
    });
    expect(transitions).toEqual(["creating"]);
    await expect(store.list()).resolves.toMatchObject([
      {
        actionId: action.actionId,
        deployment: "production",
        draftId: "draft-volatile-retry",
      },
    ]);
  });

  it("refuses a volatile create action whose stable action identity does not match", async () => {
    const action = makeScaffoldCreateAction({
      draftId: DraftId.make("draft-volatile-mismatch"),
      deployment: "staging",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      create: {},
      uuid: vi
        .fn()
        .mockReturnValueOnce("actual-action")
        .mockReturnValueOnce("connection")
        .mockReturnValueOnce("session"),
    });
    const store = createMemoryScaffoldLifecycleActionStore();

    await expect(
      retryScaffoldLifecycleAction({
        store,
        actionId: "op_different-action",
        expectedDeployment: "staging",
        expectedDraftId: DraftId.make("draft-volatile-mismatch"),
        expectedSourceEnvironmentId: EnvironmentId.make("source-environment"),
        expectedSourceProjectId: ProjectId.make("source-project"),
        expectedSessionId: action.sessionId,
        volatileCreateAction: action,
        onCreating: () => {
          throw new Error("mismatched volatile action must not become visible");
        },
        onPersistenceFailure: () => {
          throw new Error("mismatched volatile action must not be persisted");
        },
      }),
    ).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it("serializes retry publication and drain under one lifecycle lock", async () => {
    const action = makeScaffoldCreateAction({
      draftId: DraftId.make("draft-serialized-retry"),
      deployment: "production",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      create: { name: "Production" },
      uuid: vi
        .fn()
        .mockReturnValueOnce("action")
        .mockReturnValueOnce("connection")
        .mockReturnValueOnce("session"),
    });
    const base = createMemoryScaffoldLifecycleActionStore([
      { ...action, blocked: true, lastErrorCode: "network" },
    ]);
    const order: string[] = [];
    let releasePut: () => void = () => undefined;
    const putGate = new Promise<void>((resolve) => {
      releasePut = () => resolve();
    });
    let markPutStarted: () => void = () => undefined;
    const putStarted = new Promise<void>((resolve) => {
      markPutStarted = () => resolve();
    });
    const store = {
      ...base,
      put: async (pending: Parameters<typeof base.put>[0]) => {
        order.push("put:start");
        markPutStarted();
        await putGate;
        await base.put(pending);
        order.push("put:complete");
      },
    };
    const locks = makeSerializedNavigatorLocks();
    vi.stubGlobal("navigator", locks.navigator);

    const retry = retryScaffoldLifecycleAction({
      store,
      actionId: action.actionId,
      expectedDeployment: "production",
      expectedDraftId: DraftId.make("draft-serialized-retry"),
      expectedSourceEnvironmentId: EnvironmentId.make("source-environment"),
      expectedSourceProjectId: ProjectId.make("source-project"),
      expectedSessionId: action.sessionId,
      onCreating: () => order.push("ui:creating"),
      onPersistenceFailure: () => order.push("ui:failed"),
    });
    await putStarted;
    const drain = drainScaffoldLifecycleActions({
      store,
      actionId: action.actionId,
      execute: async (pending) => {
        order.push(`execute:${String(pending.blocked)}`);
        return { _tag: "acknowledged" };
      },
    });

    await Promise.resolve();
    expect(order).toEqual(["ui:creating", "put:start"]);
    releasePut();
    await Promise.all([retry, drain]);

    expect(order).toEqual(["ui:creating", "put:start", "put:complete", "execute:false"]);
    expect(locks.maxActive()).toBe(1);
  });

  it("serializes retry publication and drain when Web Locks are unavailable", async () => {
    const action = makeScaffoldCreateAction({
      draftId: DraftId.make("draft-fallback-lock"),
      deployment: "production",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      create: { name: "Production" },
      uuid: vi
        .fn()
        .mockReturnValueOnce("action")
        .mockReturnValueOnce("connection")
        .mockReturnValueOnce("session"),
    });
    const base = createMemoryScaffoldLifecycleActionStore([
      { ...action, blocked: true, lastErrorCode: "network" },
    ]);
    const order: string[] = [];
    let releasePut: () => void = () => undefined;
    const putGate = new Promise<void>((resolve) => {
      releasePut = () => resolve();
    });
    let markPutStarted: () => void = () => undefined;
    const putStarted = new Promise<void>((resolve) => {
      markPutStarted = () => resolve();
    });
    const store = {
      ...base,
      put: async (pending: Parameters<typeof base.put>[0]) => {
        order.push("put:start");
        markPutStarted();
        await putGate;
        await base.put(pending);
        order.push("put:complete");
      },
    };
    vi.stubGlobal("navigator", {});

    const retry = retryScaffoldLifecycleAction({
      store,
      actionId: action.actionId,
      expectedDeployment: "production",
      expectedDraftId: DraftId.make("draft-fallback-lock"),
      expectedSourceEnvironmentId: EnvironmentId.make("source-environment"),
      expectedSourceProjectId: ProjectId.make("source-project"),
      expectedSessionId: action.sessionId,
      onCreating: () => order.push("ui:creating"),
      onPersistenceFailure: () => order.push("ui:failed"),
    });
    await putStarted;
    const drain = drainScaffoldLifecycleActions({
      store,
      actionId: action.actionId,
      execute: async (pending) => {
        order.push(`execute:${String(pending.blocked)}`);
        return { _tag: "acknowledged" };
      },
    });

    await Promise.resolve();
    expect(order).toEqual(["ui:creating", "put:start"]);
    releasePut();
    await Promise.all([retry, drain]);
    expect(order).toEqual(["ui:creating", "put:start", "put:complete", "execute:false"]);
  });

  it("persists preallocated create identifiers before any request", async () => {
    const ids = ["action", "connection", "session"];
    const action = makeScaffoldCreateAction({
      draftId: DraftId.make("draft-1"),
      deployment: "staging",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      create: { name: "Ashler" },
      createdAt: "2026-07-24T20:00:00.000Z",
      uuid: () => ids.shift() ?? "unexpected",
    });
    const store = createMemoryScaffoldLifecycleActionStore();

    await enqueueScaffoldLifecycleAction(store, action);

    await expect(store.list()).resolves.toMatchObject([
      {
        actionId: "op_action",
        sessionId: "ses_session",
        connectionId: "scaffold-connection:connection",
        kind: "create",
        deployment: "staging",
        create: { name: "Ashler" },
      },
    ]);
    expect(JSON.stringify(action)).not.toMatch(/credential|token/i);
  });

  it("reuses the same action and session after refresh and an ambiguous network loss", async () => {
    const action = makeScaffoldCreateAction({
      draftId: DraftId.make("draft-1"),
      deployment: "production",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      create: { name: "Ashler" },
      createdAt: "2026-07-24T20:00:00.000Z",
      uuid: vi
        .fn()
        .mockReturnValueOnce("action")
        .mockReturnValueOnce("connection")
        .mockReturnValueOnce("session"),
    });
    const store = createMemoryScaffoldLifecycleActionStore();
    await enqueueScaffoldLifecycleAction(store, action);
    const attempts: Array<{ actionId: string; sessionId: string }> = [];

    await drainScaffoldLifecycleActions({
      store,
      now: () => 1_000,
      execute: async (pending) => {
        attempts.push({ actionId: pending.actionId, sessionId: pending.sessionId });
        return { _tag: "retry", retryAfterMs: 100, errorCode: "network" };
      },
    });

    // A newly mounted client drains the same durable record after its retry
    // deadline. Stable IDs make the repeated server request idempotent.
    await drainScaffoldLifecycleActions({
      store,
      now: () => 1_100,
      execute: async (pending) => {
        attempts.push({ actionId: pending.actionId, sessionId: pending.sessionId });
        return { _tag: "acknowledged" };
      },
    });

    expect(attempts).toEqual([
      { actionId: "op_action", sessionId: "ses_session" },
      { actionId: "op_action", sessionId: "ses_session" },
    ]);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("retries a pause with one stable operation id until authoritative convergence", async () => {
    const action = makeScaffoldPauseAction({
      environmentId: EnvironmentId.make("scaffold-environment"),
      sourceThreadId: ThreadId.make("thread-pause"),
      sessionId: "ses_pause",
      expectedLifecycleEpoch: 4,
      createdAt: "2026-07-29T00:00:00.000Z",
      uuid: () => "stable-pause",
    });
    const store = createMemoryScaffoldLifecycleActionStore();
    await enqueueScaffoldLifecycleAction(store, action);
    const requests: Array<{ operationId: string; sessionId: string }> = [];
    let attempt = 0;

    const execute = async (
      pending: Parameters<typeof scaffoldPauseInputFromAction>[0]["action"],
    ) => {
      const request = scaffoldPauseInputFromAction({ action: pending, deployment: "staging" });
      requests.push({ operationId: request.operationId, sessionId: request.sessionId });
      attempt += 1;
      return attempt === 1
        ? ({ _tag: "wait", retryAfterMs: 100, errorCode: "network" } as const)
        : ({ _tag: "acknowledged" } as const);
    };

    await drainScaffoldLifecycleActions({
      store,
      now: () => 1_000,
      execute: async (pending) =>
        pending.kind === "pause"
          ? execute(pending)
          : { _tag: "blocked", errorCode: "unexpected_action" },
    });
    await expect(store.list()).resolves.toMatchObject([
      { actionId: "op_stable-pause", attempt: 0, nextAttemptAt: 1_100 },
    ]);

    await drainScaffoldLifecycleActions({
      store,
      now: () => 1_100,
      execute: async (pending) =>
        pending.kind === "pause"
          ? execute(pending)
          : { _tag: "blocked", errorCode: "unexpected_action" },
    });

    expect(requests).toEqual([
      { operationId: "op_stable-pause", sessionId: "ses_pause" },
      { operationId: "op_stable-pause", sessionId: "ses_pause" },
    ]);
    await expect(store.list()).resolves.toEqual([]);
  });
});
