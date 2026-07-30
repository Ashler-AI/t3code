import { ScaffoldConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ readPreparedConnection: vi.fn() }));

vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  readPreparedConnection: mocks.readPreparedConnection,
}));

import {
  currentScaffoldLifecycleEpoch,
  settleThenEnqueueScaffoldPause,
  ThreadArchiveBlockedError,
} from "./useThreadActions";

describe("ThreadArchiveBlockedError", () => {
  it("keeps the blocked thread context with the fixed message", () => {
    const error = new ThreadArchiveBlockedError({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    });

    expect(error).toMatchObject({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    expect(error.message).toBe("Cannot archive a running thread.");
  });
});

describe("settleThenEnqueueScaffoldPause", () => {
  it("does not enqueue a pause when native settlement is rejected", async () => {
    const enqueuePause = vi.fn();
    const failure = { _tag: "Failure", cause: "settle rejected" } as const;

    await expect(
      settleThenEnqueueScaffoldPause({
        settle: async () => failure,
        enqueuePause,
      }),
    ).resolves.toBe(failure);

    expect(enqueuePause).not.toHaveBeenCalled();
  });

  it("keeps successful native settlement when pause persistence fails", async () => {
    const success = { _tag: "Success", value: undefined } as const;
    const onPausePersistenceFailure = vi.fn();

    await expect(
      settleThenEnqueueScaffoldPause({
        settle: async () => success,
        enqueuePause: async () => Promise.reject(new Error("IndexedDB unavailable")),
        onPausePersistenceFailure,
      }),
    ).resolves.toBe(success);

    expect(onPausePersistenceFailure).toHaveBeenCalledOnce();
  });
});

describe("currentScaffoldLifecycleEpoch", () => {
  it("uses the prepared Scaffold target after resume advances the saved epoch", () => {
    const environmentId = EnvironmentId.make("environment-scaffold");
    mocks.readPreparedConnection.mockReturnValue({
      target: new ScaffoldConnectionTarget({
        environmentId,
        label: "Scaffold staging",
        deployment: "staging",
        sessionId: "ses_1",
        lifecycleEpoch: 7,
      }),
    });

    expect(
      currentScaffoldLifecycleEpoch({
        environmentId,
        sessionId: "ses_1",
        persistedEpoch: 3,
      }),
    ).toBe(7);
  });

  it("does not borrow an epoch from a different Scaffold session", () => {
    const environmentId = EnvironmentId.make("environment-scaffold");
    mocks.readPreparedConnection.mockReturnValue({
      target: new ScaffoldConnectionTarget({
        environmentId,
        label: "Scaffold staging",
        deployment: "staging",
        sessionId: "ses_other",
        lifecycleEpoch: 9,
      }),
    });

    expect(
      currentScaffoldLifecycleEpoch({
        environmentId,
        sessionId: "ses_1",
        persistedEpoch: 4,
      }),
    ).toBe(4);
  });
});
