import { describe, expect, it } from "@effect/vitest";

import {
  decideAuthorizedCommandSubmit,
  decideCommandSubmit,
  decideEventAppend,
  decideRunnerGeneration,
  isCurrentRunnerAttachment,
  nextSessionFabricMaintenanceDueAt,
  offlineScaffoldCommandCanWake,
  runnerHelloMatchesLease,
  scaffoldWakeRetryDelayMs,
  scaffoldWakeKeepsCommandPending,
  scaffoldWakeFollowerStatus,
  scaffoldWakeHasAttemptsRemaining,
  scaffoldWakeRequestsAuthority,
  SESSION_FABRIC_AUTHENTICATION_CLOSE_CODE,
  SESSION_FABRIC_PERMISSION_CLOSE_CODE,
  snapshotProvesScaffoldWakeTarget,
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

  it("wakes only an authorized public Scaffold command while its runner is offline", () => {
    const candidate = {
      controllerMatchesSnapshotIdentity: true,
      runnerState: "offline",
      eligibleRunnerCount: 0,
      wakeAlreadyActive: false,
      publication: "public",
      environmentKind: "scaffold",
      scaffoldSessionId: "ses_scaffold",
      controllerLifecycleEpoch: 8,
      wakeAuthorityConfigured: true,
    } as const;
    expect(offlineScaffoldCommandCanWake(candidate)).toBe(true);
    expect(offlineScaffoldCommandCanWake({ ...candidate, environmentKind: "local" })).toBe(false);
    expect(offlineScaffoldCommandCanWake({ ...candidate, publication: "local_only" })).toBe(false);
    expect(offlineScaffoldCommandCanWake({ ...candidate, wakeAuthorityConfigured: false })).toBe(
      false,
    );
    expect(
      offlineScaffoldCommandCanWake({
        ...candidate,
        runnerState: "online",
        wakeAlreadyActive: true,
      }),
    ).toBe(true);
    expect(
      offlineScaffoldCommandCanWake({
        ...candidate,
        runnerState: "online",
        wakeAlreadyActive: false,
      }),
    ).toBe(false);
  });

  it("uses controller identity and epoch independently from a stale retained snapshot", () => {
    expect(
      offlineScaffoldCommandCanWake({
        controllerMatchesSnapshotIdentity: true,
        runnerState: "offline",
        eligibleRunnerCount: 0,
        wakeAlreadyActive: false,
        publication: "public",
        environmentKind: "scaffold",
        scaffoldSessionId: "ses_scaffold",
        controllerLifecycleEpoch: 9,
        wakeAuthorityConfigured: true,
      }),
    ).toBe(true);
  });

  it("gates resumed command delivery on an exact Scaffold snapshot and runner generation", () => {
    const target = {
      wakeFabricSessionId: "fabric-session",
      wakeScaffoldSessionId: "ses_scaffold",
      wakeTargetLifecycleEpoch: 8,
      snapshotFabricSessionId: "fabric-session",
      snapshotEnvironmentKind: "scaffold",
      snapshotScaffoldSessionId: "ses_scaffold",
      snapshotLifecycleEpoch: 8,
      runnerGeneration: 8,
    } as const;
    expect(snapshotProvesScaffoldWakeTarget(target)).toBe(true);
    expect(snapshotProvesScaffoldWakeTarget({ ...target, snapshotLifecycleEpoch: 7 })).toBe(false);
    expect(snapshotProvesScaffoldWakeTarget({ ...target, runnerGeneration: 7 })).toBe(false);
    expect(snapshotProvesScaffoldWakeTarget({ ...target, snapshotFabricSessionId: "other" })).toBe(
      false,
    );
    expect(
      snapshotProvesScaffoldWakeTarget({ ...target, snapshotScaffoldSessionId: "other" }),
    ).toBe(false);
  });

  it("bounds Scaffold wake retry backoff", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(scaffoldWakeRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  it("preserves wake-backed commands across disconnect and generation rollover", () => {
    expect(
      ["pending", "retrying", "joining", "awaiting_snapshot", "ready"].every(
        scaffoldWakeKeepsCommandPending,
      ),
    ).toBe(true);
    expect(scaffoldWakeKeepsCommandPending("failed")).toBe(false);
    expect(scaffoldWakeKeepsCommandPending("completed")).toBe(false);
  });

  it("polls only the shared wake leader through the awaiting-snapshot phase", () => {
    expect(["pending", "retrying", "awaiting_snapshot"].every(scaffoldWakeRequestsAuthority)).toBe(
      true,
    );
    expect(scaffoldWakeRequestsAuthority("joining")).toBe(false);
    expect(scaffoldWakeRequestsAuthority("ready")).toBe(false);
    expect(scaffoldWakeHasAttemptsRemaining(5)).toBe(true);
    expect(scaffoldWakeHasAttemptsRemaining(6)).toBe(false);
  });

  it("queues followers behind one wake without giving them authority polling work", () => {
    expect(
      scaffoldWakeFollowerStatus({ leaderStatus: "pending", targetLifecycleEpoch: null }),
    ).toBe("joining");
    expect(
      scaffoldWakeFollowerStatus({
        leaderStatus: "awaiting_snapshot",
        targetLifecycleEpoch: 8,
      }),
    ).toBe("awaiting_snapshot");
    expect(scaffoldWakeFollowerStatus({ leaderStatus: "ready", targetLifecycleEpoch: 8 })).toBe(
      "ready",
    );
  });

  it("shares one alarm without starving directory or wake maintenance", () => {
    expect(nextSessionFabricMaintenanceDueAt({ directoryDueAt: 8_000, wakeDueAt: 4_000 })).toBe(
      4_000,
    );
    expect(nextSessionFabricMaintenanceDueAt({ directoryDueAt: 8_000, wakeDueAt: null })).toBe(
      8_000,
    );
    expect(nextSessionFabricMaintenanceDueAt({ directoryDueAt: null, wakeDueAt: null })).toBeNull();
  });
});
