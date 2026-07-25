import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  newThreadAttentionCandidates,
  threadAttentionCandidate,
  threadAttentionNotificationBody,
} from "./ThreadAttentionNotifications.logic";

function thread(overrides: Record<string, unknown> = {}) {
  return {
    environmentId: "env-local",
    id: "thread-1",
    title: "Fix sidebar",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: null,
    session: null,
    ...overrides,
  } as never;
}

describe("threadAttentionCandidate", () => {
  it("keys awaiting input to the active turn for deduplication", () => {
    expect(
      threadAttentionCandidate(
        thread({
          hasPendingUserInput: true,
          latestTurn: { turnId: "turn-2", completedAt: null },
        }),
        undefined,
      ),
    ).toMatchObject({ reason: "input", key: "env-local:thread-1:input:turn-2" });
  });

  it("only reports a completion newer than the local visit marker", () => {
    const completed = thread({
      latestTurn: { turnId: "turn-1", completedAt: "2026-07-24T10:00:00.000Z" },
    });
    expect(threadAttentionCandidate(completed, "2026-07-24T09:00:00.000Z")?.reason).toBe(
      "completed",
    );
    expect(threadAttentionCandidate(completed, "2026-07-24T11:00:00.000Z")).toBeNull();
  });
});

describe("newThreadAttentionCandidates", () => {
  it("does not re-notify a currently active or previously delivered event", () => {
    const one = {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("one"),
      title: "One",
      key: "one:input:turn",
      reason: "input" as const,
    };
    const two = { ...one, threadId: ThreadId.make("two"), key: "two:input:turn" };
    expect(
      newThreadAttentionCandidates({
        candidates: [one, two],
        previousKeys: new Set([one.key]),
        notifiedKeys: new Set([two.key]),
      }),
    ).toEqual([]);
  });
});

describe("threadAttentionNotificationBody", () => {
  it("describes the action the user needs to take", () => {
    expect(threadAttentionNotificationBody("input")).toContain("waiting for your input");
  });
});
