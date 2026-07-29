import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ScaffoldLifecycleAction } from "./model.ts";
import {
  makeScaffoldLifecycleAction,
  makeScaffoldLifecycleOutbox,
  type ScaffoldLifecycleActionStore,
} from "./outbox.ts";

function action(actionId: string, kind: "create" | "resume" | "pause" = "resume") {
  const base = {
    actionId,
    environmentId: EnvironmentId.make("env-1"),
    connectionId: "connection-1",
    sessionId: `session-${actionId}`,
    expectedLifecycleEpoch: 1,
    createdAt: `2026-07-24T19:00:0${actionId.at(-1) ?? "0"}.000Z`,
  } as const;
  return kind === "create"
    ? makeScaffoldLifecycleAction({
        ...base,
        kind,
        deployment: "staging",
        draftId: `draft-${actionId}`,
        sourceEnvironmentId: EnvironmentId.make("source-environment-1"),
        sourceProjectId: ProjectId.make("source-project-1"),
      })
    : makeScaffoldLifecycleAction({ ...base, kind });
}

function memoryStore(initial: ReadonlyArray<ScaffoldLifecycleAction> = []) {
  const values = new Map(initial.map((item) => [item.actionId, item]));
  const store: ScaffoldLifecycleActionStore = {
    list: async () => [...values.values()],
    put: async (item) => {
      values.set(item.actionId, item);
    },
    remove: async (actionId) => {
      values.delete(actionId);
    },
  };
  return { store, values };
}

describe("Scaffold lifecycle outbox", () => {
  it("schedules a wait without consuming attempt budget, then acknowledges the same action", async () => {
    const pending = action("1", "create");
    const { store, values } = memoryStore([pending]);
    const executions: Array<{ actionId: string; sessionId: string; attempt: number }> = [];
    const projectedWaits: ScaffoldLifecycleAction[] = [];
    let now = 100;
    const outbox = makeScaffoldLifecycleOutbox({
      store,
      execute: async (item) => {
        executions.push({
          actionId: item.actionId,
          sessionId: item.sessionId,
          attempt: item.attempt,
        });
        return executions.length === 1
          ? {
              _tag: "wait",
              retryAfterMs: 500,
              errorCode: "scaffold_preparation_pending",
              observation: {
                sessionId: "server-minted-session",
                lifecycleEpoch: 3,
              },
            }
          : { _tag: "acknowledged" };
      },
      now: () => now,
      maxAttempts: 1,
      onWait: (item) => projectedWaits.push(item),
    });

    await outbox.drain();

    expect(values.get(pending.actionId)).toMatchObject({
      attempt: 0,
      blocked: false,
      nextAttemptAt: 600,
      lastErrorCode: "scaffold_preparation_pending",
      actionId: pending.actionId,
      connectionId: pending.connectionId,
      environmentId: pending.environmentId,
      sessionId: "server-minted-session",
      expectedLifecycleEpoch: 3,
    });
    expect(projectedWaits).toMatchObject([
      {
        actionId: pending.actionId,
        environmentId: pending.environmentId,
        sessionId: "server-minted-session",
        expectedLifecycleEpoch: 3,
        attempt: 0,
        blocked: false,
      },
    ]);

    now = 600;
    await outbox.drain();

    expect(executions).toEqual([
      { actionId: pending.actionId, sessionId: pending.sessionId, attempt: 0 },
      { actionId: pending.actionId, sessionId: "server-minted-session", attempt: 0 },
    ]);
    expect(values.has(pending.actionId)).toBe(false);
  });

  it("does not let a retry or blocked action starve later ready actions", async () => {
    const first = action("1");
    const second = action("2");
    const third = action("3");
    const { store, values } = memoryStore([first, second, third]);
    const calls: string[] = [];
    const outbox = makeScaffoldLifecycleOutbox({
      store,
      execute: async (item) => {
        calls.push(item.actionId);
        if (item.actionId === "1") {
          return { _tag: "retry", retryAfterMs: 1_000, errorCode: "starting" };
        }
        if (item.actionId === "2") {
          return { _tag: "blocked", errorCode: "agent_turn_running" };
        }
        return { _tag: "acknowledged" };
      },
      now: () => 100,
    });

    await outbox.drain();

    expect(calls).toEqual(["1", "2", "3"]);
    expect(values.has("3")).toBe(false);
    expect(values.get("1")).toMatchObject({ blocked: false, nextAttemptAt: 1_100 });
    expect(values.get("2")).toMatchObject({ blocked: true, nextAttemptAt: null });
  });

  it("never retries terminal blocked records", async () => {
    const blocked = makeScaffoldLifecycleAction({
      actionId: "blocked",
      kind: "pause",
      environmentId: EnvironmentId.make("env-1"),
      connectionId: "connection-1",
      sessionId: "session-blocked",
      expectedLifecycleEpoch: 1,
      createdAt: "2026-07-24T19:00:00.000Z",
    });
    const terminal = { ...blocked, blocked: true } as ScaffoldLifecycleAction;
    const { store } = memoryStore([terminal]);
    let executions = 0;
    const reflected: string[] = [];
    const outbox = makeScaffoldLifecycleOutbox({
      store,
      execute: async () => {
        executions += 1;
        return { _tag: "acknowledged" };
      },
      onBlocked: (item) => reflected.push(item.actionId),
    });

    await outbox.drain();
    expect(executions).toBe(0);
    expect(reflected).toEqual(["blocked"]);
  });

  it("serializes enqueue and drain store mutations", async () => {
    const values = new Map<string, ScaffoldLifecycleAction>([["1", action("1")]]);
    let activeMutations = 0;
    let maxActiveMutations = 0;
    const mutation = async (run: () => void) => {
      activeMutations += 1;
      maxActiveMutations = Math.max(maxActiveMutations, activeMutations);
      await Promise.resolve();
      run();
      activeMutations -= 1;
    };
    const store: ScaffoldLifecycleActionStore = {
      list: async () => [...values.values()],
      put: (item) => mutation(() => values.set(item.actionId, item)),
      remove: (actionId) => mutation(() => values.delete(actionId)),
    };
    const outbox = makeScaffoldLifecycleOutbox({
      store,
      execute: async () => ({ _tag: "acknowledged" }),
    });

    await Promise.all([outbox.drain(), outbox.enqueue(action("2"))]);

    expect(maxActiveMutations).toBe(1);
    expect(values.has("2")).toBe(true);
  });
});
