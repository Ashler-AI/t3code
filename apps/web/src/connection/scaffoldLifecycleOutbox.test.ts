import { DraftId } from "../composerDraftStore";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createMemoryScaffoldLifecycleActionStore,
  drainScaffoldLifecycleActions,
  enqueueScaffoldLifecycleAction,
  makeScaffoldCreateAction,
} from "./scaffoldLifecycleOutbox";

describe("Scaffold lifecycle browser outbox", () => {
  it("persists preallocated create identifiers before any request", async () => {
    const ids = ["action", "connection", "session"];
    const action = makeScaffoldCreateAction({
      draftId: DraftId.make("draft-1"),
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
        create: { name: "Ashler" },
      },
    ]);
    expect(JSON.stringify(action)).not.toMatch(/credential|token/i);
  });

  it("reuses the same action and session after refresh and an ambiguous network loss", async () => {
    const action = makeScaffoldCreateAction({
      draftId: DraftId.make("draft-1"),
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
});
