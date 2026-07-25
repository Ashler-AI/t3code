import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  OMP_ACCOUNT_ASSIGNMENT_MAX_REFRESH_ATTEMPTS,
  ompAccountAssignmentRefreshKey,
  shouldRefreshOmpAccountAssignment,
} from "./ompAccountAssignmentRefresh";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-omp");

describe("ompAccountAssignmentRefreshKey", () => {
  it("revalidates once when a restored thread is visible before its session projection", () => {
    expect(
      ompAccountAssignmentRefreshKey({
        enabled: true,
        environmentId,
        threadId,
        session: null,
        latestTurn: null,
      }),
    ).toBe("environment-local:thread-omp:no-session:no-completed-turn");
  });

  it("revalidates a restored ready session after the initial assignment query settles", () => {
    expect(
      ompAccountAssignmentRefreshKey({
        enabled: true,
        environmentId,
        threadId,
        session: {
          status: "ready",
          updatedAt: "2026-07-24T18:00:00.000Z",
        },
        latestTurn: null,
      }),
    ).toBe("environment-local:thread-omp:ready:2026-07-24T18:00:00.000Z:no-completed-turn");
  });

  it("changes after a successful turn settles so a cached unassigned result is invalidated", () => {
    const before = ompAccountAssignmentRefreshKey({
      enabled: true,
      environmentId,
      threadId,
      session: {
        status: "ready",
        updatedAt: "2026-07-24T18:00:00.000Z",
      },
      latestTurn: null,
    });
    const after = ompAccountAssignmentRefreshKey({
      enabled: true,
      environmentId,
      threadId,
      session: {
        status: "ready",
        updatedAt: "2026-07-24T18:01:00.000Z",
      },
      latestTurn: {
        turnId: TurnId.make("turn-first"),
        state: "completed",
        completedAt: "2026-07-24T18:01:00.000Z",
      },
    });

    expect(after).not.toBe(before);
    expect(after).toContain("turn-first:2026-07-24T18:01:00.000Z");
  });

  it("waits for in-flight turns and disables refreshes outside an eligible OMP thread", () => {
    expect(
      ompAccountAssignmentRefreshKey({
        enabled: true,
        environmentId,
        threadId,
        session: {
          status: "running",
          updatedAt: "2026-07-24T18:00:30.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-running"),
          state: "running",
          completedAt: null,
        },
      }),
    ).toBeNull();

    expect(
      ompAccountAssignmentRefreshKey({
        enabled: false,
        environmentId,
        threadId,
        session: null,
        latestTurn: null,
      }),
    ).toBeNull();
  });
});

describe("shouldRefreshOmpAccountAssignment", () => {
  it("keeps a fresh restored client revalidating until its completed thread hydrates an assignment", () => {
    const baseInput = {
      refreshKey: "environment-local:thread-omp:ready:restored:turn-restored:completed",
      isPending: false,
      latestTurnCompleted: true,
    } as const;

    expect(
      shouldRefreshOmpAccountAssignment({
        ...baseInput,
        refreshAttemptCount: 0,
        hasAssignedAccount: false,
        hasError: true,
      }),
    ).toBe(true);

    expect(
      shouldRefreshOmpAccountAssignment({
        ...baseInput,
        refreshAttemptCount: 1,
        hasAssignedAccount: false,
        hasError: false,
      }),
    ).toBe(true);

    expect(
      shouldRefreshOmpAccountAssignment({
        ...baseInput,
        refreshAttemptCount: 2,
        hasAssignedAccount: true,
        hasError: false,
      }),
    ).toBe(false);
  });

  it("bounds retries and does not poll an unassigned thread before its first completed turn", () => {
    expect(
      shouldRefreshOmpAccountAssignment({
        refreshKey: "environment-local:thread-omp:ready:new:no-completed-turn",
        refreshAttemptCount: 1,
        isPending: false,
        hasAssignedAccount: false,
        hasError: false,
        latestTurnCompleted: false,
      }),
    ).toBe(false);

    expect(
      shouldRefreshOmpAccountAssignment({
        refreshKey: "environment-local:thread-omp:ready:restored:turn-restored:completed",
        refreshAttemptCount: OMP_ACCOUNT_ASSIGNMENT_MAX_REFRESH_ATTEMPTS,
        isPending: false,
        hasAssignedAccount: false,
        hasError: true,
        latestTurnCompleted: true,
      }),
    ).toBe(false);
  });
});
