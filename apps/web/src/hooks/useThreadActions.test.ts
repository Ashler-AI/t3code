import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadSettlementAuthority,
  shouldSettleScaffoldThreadLocally,
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

describe("Scaffold thread settlement authority", () => {
  it.each(["available", "offline", "connecting", "reconnecting", "error"] as const)(
    "uses the local Done projection while the Scaffold connection is %s",
    (connectionPhase) => {
      expect(shouldSettleScaffoldThreadLocally({ isScaffold: true, connectionPhase })).toBe(true);
    },
  );

  it("preserves authoritative T3 settlement for connected Scaffold and local threads", () => {
    expect(
      shouldSettleScaffoldThreadLocally({ isScaffold: true, connectionPhase: "connected" }),
    ).toBe(false);
    expect(shouldSettleScaffoldThreadLocally({ isScaffold: false, connectionPhase: "error" })).toBe(
      false,
    );
  });

  it("uses the local Done projection when the Scaffold presentation is not hydrated", () => {
    expect(shouldSettleScaffoldThreadLocally({ isScaffold: true, connectionPhase: null })).toBe(
      true,
    );
  });

  it("does not require cached settlement capability for a disconnected Scaffold", () => {
    expect(
      resolveThreadSettlementAuthority({
        isScaffold: true,
        connectionPhase: "error",
        serverSupportsSettlement: false,
      }),
    ).toBe("local");
  });

  it("never treats an unsupported connected environment as local", () => {
    expect(
      resolveThreadSettlementAuthority({
        isScaffold: true,
        connectionPhase: "connected",
        serverSupportsSettlement: false,
      }),
    ).toBe("unsupported");
  });
});
