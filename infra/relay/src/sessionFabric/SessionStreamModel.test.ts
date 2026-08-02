import { describe, expect, it } from "@effect/vitest";

import {
  decideAuthorizedCommandSubmit,
  decideCommandSubmit,
  decideEventAppend,
  decideRunnerGeneration,
  commandTargetsRunnerGeneration,
  commandNeedsScaffoldWakeRetry,
  isCurrentRunnerAttachment,
  runnerHelloMatchesLease,
  SESSION_FABRIC_AUTHENTICATION_CLOSE_CODE,
  SESSION_FABRIC_PERMISSION_CLOSE_CODE,
  scaffoldWakeRetryDelayMs,
  resolveScaffoldWakeActorId,
  shouldReplayCommand,
} from "./SessionStreamModel.ts";

describe("SessionStreamModel", () => {
  it("uses refreshable application close codes for auth and permission failures", () => {
    expect(SESSION_FABRIC_AUTHENTICATION_CLOSE_CODE).toBe(4401);
    expect(SESSION_FABRIC_PERMISSION_CLOSE_CODE).toBe(4403);
  });

  it("rejects a stale runner after a newer generation takes the lease", () => {
    expect(decideRunnerGeneration(4, 3)).toBe("stale");
    expect(
      decideEventAppend({
        currentRunnerGeneration: 4,
        incomingRunnerGeneration: 3,
        eventAlreadyExists: false,
      }),
    ).toBe("stale-runner");
    expect(
      isCurrentRunnerAttachment({
        attachmentGeneration: 3,
        attachmentRunnerId: "runner-old",
        currentGeneration: 4,
        currentRunnerId: "runner-current",
      }),
    ).toBe(false);
    expect(
      isCurrentRunnerAttachment({
        attachmentGeneration: 4,
        attachmentRunnerId: "runner-old",
        currentGeneration: 4,
        currentRunnerId: "runner-current",
      }),
    ).toBe(false);
    expect(
      isCurrentRunnerAttachment({
        attachmentGeneration: 4,
        attachmentRunnerId: "runner-current",
        currentGeneration: 4,
        currentRunnerId: "runner-current",
      }),
    ).toBe(true);
    expect(
      runnerHelloMatchesLease({
        currentGeneration: 4,
        currentRunnerId: "runner-current",
        incomingGeneration: 4,
        incomingRunnerId: "runner-other",
      }),
    ).toBe(false);
    expect(
      runnerHelloMatchesLease({
        currentGeneration: 4,
        currentRunnerId: "runner-current",
        incomingGeneration: 5,
        incomingRunnerId: "runner-next",
      }),
    ).toBe(true);
  });

  it("deduplicates a committed event before considering runner generation", () => {
    expect(
      decideEventAppend({
        currentRunnerGeneration: 4,
        incomingRunnerGeneration: 3,
        eventAlreadyExists: true,
      }),
    ).toBe("duplicate");
  });

  it("preserves the complete stored receipt for duplicate commands", () => {
    expect(decideCommandSubmit(undefined)).toEqual({ type: "accepted" });
    const existing = {
      status: "accepted" as const,
      resultSequence: 42,
      detail: null,
    };
    const duplicate = decideCommandSubmit(existing);
    expect(duplicate).toEqual({ type: "duplicate", existing });
    if (duplicate.type !== "duplicate") throw new Error("expected duplicate command");
    expect(duplicate.existing).toBe(existing);
    expect(duplicate.existing.resultSequence).toBe(42);
  });

  it("replays only unfinished command delivery states", () => {
    expect(shouldReplayCommand("queued")).toBe(true);
    expect(shouldReplayCommand("delivered")).toBe(true);
    expect(shouldReplayCommand("accepted")).toBe(false);
    expect(shouldReplayCommand("rejected")).toBe(false);
  });

  it("rejects viewer, stale-epoch, and offline commands without queueing", () => {
    expect(
      decideAuthorizedCommandSubmit({
        controllerMatchesSession: false,
        runnerState: "online",
        eligibleRunnerCount: 1,
        scaffoldWakeEligible: false,
      }),
    ).toEqual({ type: "rejected", detail: "Controller capability required" });
    expect(
      decideAuthorizedCommandSubmit({
        controllerMatchesSession: true,
        runnerState: "offline",
        eligibleRunnerCount: 1,
        scaffoldWakeEligible: false,
      }),
    ).toEqual({ type: "rejected", detail: "Session runner is offline" });
    expect(
      decideAuthorizedCommandSubmit({
        controllerMatchesSession: true,
        runnerState: "online",
        eligibleRunnerCount: 0,
        scaffoldWakeEligible: false,
      }),
    ).toEqual({ type: "rejected", detail: "Session runner is offline" });
  });

  it("accepts only an exact controller with a current online runner", () => {
    expect(
      decideAuthorizedCommandSubmit({
        controllerMatchesSession: true,
        runnerState: "online",
        eligibleRunnerCount: 1,
        scaffoldWakeEligible: false,
      }),
    ).toEqual({ type: "accepted", delivery: "runner" });
  });

  it("queues an offline Scaffold command for the next fenced runner generation", () => {
    expect(
      decideAuthorizedCommandSubmit({
        controllerMatchesSession: true,
        runnerState: "offline",
        eligibleRunnerCount: 0,
        scaffoldWakeEligible: true,
      }),
    ).toEqual({ type: "accepted", delivery: "scaffold-wake" });
    expect(
      commandTargetsRunnerGeneration({
        targetRunnerGeneration: 8,
        runnerGeneration: 8,
      }),
    ).toBe(true);
    expect(
      commandTargetsRunnerGeneration({
        targetRunnerGeneration: 8,
        runnerGeneration: 7,
      }),
    ).toBe(false);
  });
  it("retries only unfinished Scaffold wake commands with persisted actor identity", () => {
    expect(
      commandNeedsScaffoldWakeRetry({
        status: "queued",
        targetRunnerGeneration: 8,
        runnerGeneration: 7,
        wakeActorId: "actor-a",
      }),
    ).toBe(true);
    expect(
      commandNeedsScaffoldWakeRetry({
        status: "accepted",
        targetRunnerGeneration: 8,
        runnerGeneration: 7,
        wakeActorId: "actor-a",
      }),
    ).toBe(false);
    expect(
      commandNeedsScaffoldWakeRetry({
        status: "queued",
        targetRunnerGeneration: 7,
        runnerGeneration: 7,
        wakeActorId: "actor-a",
      }),
    ).toBe(false);
    expect(
      commandNeedsScaffoldWakeRetry({
        status: "queued",
        targetRunnerGeneration: 8,
        runnerGeneration: 7,
        wakeActorId: null,
      }),
    ).toBe(false);
  });
  it("backs off Scaffold wake retries and expires stalled commands", () => {
    const wakeStartedAt = "2026-07-28T20:00:00.000Z";
    const wakeStartedAtMs = Date.parse(wakeStartedAt);
    expect(scaffoldWakeRetryDelayMs({ wakeStartedAt, nowMs: wakeStartedAtMs })).toBe(2_000);
    expect(scaffoldWakeRetryDelayMs({ wakeStartedAt, nowMs: wakeStartedAtMs + 20_000 })).toBe(
      5_000,
    );
    expect(scaffoldWakeRetryDelayMs({ wakeStartedAt, nowMs: wakeStartedAtMs + 60_000 })).toBe(
      15_000,
    );
    expect(scaffoldWakeRetryDelayMs({ wakeStartedAt, nowMs: wakeStartedAtMs + 3 * 60_000 })).toBe(
      60_000,
    );
    expect(
      scaffoldWakeRetryDelayMs({ wakeStartedAt, nowMs: wakeStartedAtMs + 10 * 60_000 }),
    ).toBeNull();
    expect(
      scaffoldWakeRetryDelayMs({ wakeStartedAt: "invalid", nowMs: wakeStartedAtMs }),
    ).toBeNull();
  });
  it("coalesces concurrent wake commands on the first actor for one generation", () => {
    expect(
      resolveScaffoldWakeActorId({
        claimedGeneration: 8,
        claimedActorId: "actor-a",
        targetRunnerGeneration: 8,
        candidateActorId: "actor-b",
      }),
    ).toBe("actor-a");
    expect(
      resolveScaffoldWakeActorId({
        claimedGeneration: 8,
        claimedActorId: "actor-a",
        targetRunnerGeneration: 9,
        candidateActorId: "actor-b",
      }),
    ).toBe("actor-b");
  });
});
