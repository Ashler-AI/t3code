import { describe, expect, it } from "vite-plus/test";

import { reconcileScaffoldLifecycle } from "./reconcile.ts";

const observation = (status: "ready" | "paused" | "stopped", lifecycleEpoch: number) => ({
  sessionId: "session-1",
  status,
  lifecycleEpoch,
});

describe("reconcileScaffoldLifecycle", () => {
  it("classifies lower epochs as stale and higher epochs as superseded", () => {
    expect(
      reconcileScaffoldLifecycle({
        kind: "resume",
        expectedLifecycleEpoch: 3,
        observation: observation("ready", 2),
      })._tag,
    ).toBe("stale");
    expect(
      reconcileScaffoldLifecycle({
        kind: "resume",
        expectedLifecycleEpoch: 3,
        observation: observation("paused", 4),
      })._tag,
    ).toBe("superseded");
  });

  it("treats stopped as terminal instead of retrying create or resume", () => {
    expect(
      reconcileScaffoldLifecycle({
        kind: "create",
        expectedLifecycleEpoch: 2,
        observation: observation("stopped", 2),
      }),
    ).toMatchObject({ _tag: "blocked", reason: "session_stopped" });
    expect(
      reconcileScaffoldLifecycle({
        kind: "resume",
        expectedLifecycleEpoch: 2,
        observation: observation("stopped", 2),
      }),
    ).toMatchObject({ _tag: "blocked", reason: "session_stopped" });
    expect(
      reconcileScaffoldLifecycle({
        kind: "pause",
        expectedLifecycleEpoch: 2,
        observation: observation("stopped", 2),
      })._tag,
    ).toBe("converged");
  });

  it("retries ambiguous 409 responses when no observation is available", () => {
    expect(
      reconcileScaffoldLifecycle({
        kind: "resume",
        expectedLifecycleEpoch: 2,
        httpStatus: 409,
        errorCode: "lifecycle_conflict",
      }),
    ).toEqual({ _tag: "retry", retryAfterMs: 1_000 });
  });
});
