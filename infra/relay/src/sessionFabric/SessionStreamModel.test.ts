import { describe, expect, it } from "@effect/vitest";

import {
  decideAuthorizedCommandSubmit,
  decideCommandSubmit,
  decideEventAppend,
  decideRunnerGeneration,
  isCurrentRunnerAttachment,
  runnerHelloMatchesLease,
  SESSION_FABRIC_AUTHENTICATION_CLOSE_CODE,
  SESSION_FABRIC_PERMISSION_CLOSE_CODE,
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
      }),
    ).toEqual({ type: "rejected", detail: "Controller capability required" });
    expect(
      decideAuthorizedCommandSubmit({
        controllerMatchesSession: true,
        runnerState: "offline",
        eligibleRunnerCount: 1,
      }),
    ).toEqual({ type: "rejected", detail: "Session runner is offline" });
    expect(
      decideAuthorizedCommandSubmit({
        controllerMatchesSession: true,
        runnerState: "online",
        eligibleRunnerCount: 0,
      }),
    ).toEqual({ type: "rejected", detail: "Session runner is offline" });
  });

  it("accepts only an exact controller with a current online runner", () => {
    expect(
      decideAuthorizedCommandSubmit({
        controllerMatchesSession: true,
        runnerState: "online",
        eligibleRunnerCount: 1,
      }),
    ).toEqual({ type: "accepted" });
  });
});
