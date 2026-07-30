import {
  EnvironmentId,
  ProviderInstanceId,
  ProjectId,
  SessionFabricRunnerId,
  SessionFabricSessionId,
  ThreadId,
  type SessionFabricCapabilityClaims,
  type SessionFabricRunnerHello,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";

vi.mock("alchemy/Cloudflare", () => ({
  DurableObject: () => () =>
    class {
      readonly mocked = true;
    },
}));

import {
  clientHelloShouldSynchronize,
  localAuthorityViewForViewer,
  localControllerMatchesPinnedAuthority,
  localRunnerCanClaimPinnedAuthority,
  localViewerCanReadPinnedAuthority,
  legacyWakeIdentityFromStoredSnapshot,
  normalizeSnapshotToRelayCursor,
  scaffoldControllerMatchesSnapshotIdentity,
  scaffoldWakeExpectedLifecycleEpoch,
  scaffoldWakeIdentityMatches,
  snapshotAuthorityCanAdvance,
  type LocalSessionFabricPinnedAuthority,
} from "./SessionStreamCoordinator.ts";
import { decideAuthorizedCommandSubmit, decideCommandSubmit } from "./SessionStreamModel.ts";

const base = {
  v: 1,
  iss: "https://scaffold.example",
  aud: "ashler-session-fabric",
  sub: "user-a",
  jti: "capability-a",
  iat: 100,
  nbf: 100,
  exp: 200,
} as const;
const sessionId = SessionFabricSessionId.make("sf:environment-a:thread-a");
const environmentId = EnvironmentId.make("environment-a");
const threadId = ThreadId.make("thread-a");
const runnerId = SessionFabricRunnerId.make("runner:environment-a");
const location = {
  environmentKind: "local",
  environmentId,
  projectId: ProjectId.make("project-a"),
  threadId,
  repositoryRoot: "/workspace/project-a",
  worktreePath: "/workspace/project-a",
  scaffoldSessionId: null,
  scaffoldSessionUrl: null,
  scaffoldLifecycleEpoch: null,
} as const;
const hello = {
  protocolVersion: 1,
  sessionId,
  runnerId,
  runnerGeneration: 0,
  location,
  publication: "public",
  lastCommittedEventSequence: 0,
  connectedAt: "2026-07-28T20:00:00.000Z",
} as const satisfies SessionFabricRunnerHello;
const runner = {
  ...base,
  role: "runner",
  scopes: ["session:publish", "session:execute"],
  fabricSessionId: sessionId,
  environmentKind: "local",
  environmentId,
  threadId,
  runnerId,
  actorId: "actor-a",
} as const satisfies SessionFabricCapabilityClaims;
const pinned = {
  sessionId,
  environmentId,
  threadId,
  runnerId,
  actorId: "actor-a",
} satisfies LocalSessionFabricPinnedAuthority;

const controller = (actorId: string): SessionFabricCapabilityClaims => ({
  ...base,
  role: "controller",
  scopes: ["session:read", "session:command"],
  fabricSessionId: sessionId,
  environmentKind: "local",
  environmentId,
  threadId,
  actorId,
});

describe("SessionStreamCoordinator local authority", () => {
  it("normalizes retained snapshots to the durable relay cursor", () => {
    const normalized = normalizeSnapshotToRelayCursor(
      {
        session: {
          sessionId,
          title: "Session",
          publication: "public",
          runnerState: "online",
          location,
          initialPrompt: null,
          searchableText: "Session",
          summary: null,
          cursor: { eventSequence: 99, snapshotSequence: 7 },
          lastEventAt: null,
          createdAt: "2026-07-24T20:00:00.000Z",
          updatedAt: "2026-07-24T20:00:00.000Z",
        },
        shell: {
          snapshotSequence: 7,
          projects: [],
          threads: [],
          updatedAt: "2026-07-24T20:00:00.000Z",
        },
        thread: {
          snapshotSequence: 7,
          thread: {
            id: threadId,
          } as never,
        },
        compactedThroughEventSequence: 99,
      },
      12,
    );

    expect(normalized.session.cursor).toEqual({ eventSequence: 12, snapshotSequence: 7 });
    expect(normalized.compactedThroughEventSequence).toBe(12);

    const interleaved = normalizeSnapshotToRelayCursor(
      {
        ...normalized,
        session: {
          ...normalized.session,
          cursor: { ...normalized.session.cursor, eventSequence: 11 },
        },
        compactedThroughEventSequence: 11,
      },
      12,
    );
    expect(interleaved.session.cursor.eventSequence).toBe(11);
    expect(interleaved.compactedThroughEventSequence).toBe(11);
  });

  it.each([
    { incomingCoverage: 3, durableEventSequence: 14, expectedCoverage: 12 },
    { incomingCoverage: 13, durableEventSequence: 14, expectedCoverage: 13 },
    { incomingCoverage: 12, durableEventSequence: 13, expectedCoverage: 12 },
  ])(
    "merges reconnect coverage monotonically (incoming $incomingCoverage, durable $durableEventSequence)",
    ({ incomingCoverage, durableEventSequence, expectedCoverage }) => {
      const storedCoverage = 12;
      const normalized = normalizeSnapshotToRelayCursor(
        {
          session: {
            sessionId,
            title: "Reconnected session",
            publication: "public",
            runnerState: "online",
            location,
            initialPrompt: null,
            searchableText: "Reconnected session",
            summary: null,
            cursor: { eventSequence: incomingCoverage, snapshotSequence: 8 },
            lastEventAt: null,
            createdAt: "2026-07-24T20:00:00.000Z",
            updatedAt: "2026-07-24T20:01:00.000Z",
          },
          shell: {
            snapshotSequence: 8,
            projects: [],
            threads: [],
            updatedAt: "2026-07-24T20:01:00.000Z",
          },
          thread: {
            snapshotSequence: 8,
            thread: {
              id: threadId,
            } as never,
          },
          compactedThroughEventSequence: incomingCoverage,
        },
        durableEventSequence,
        storedCoverage,
      );

      expect(normalized.session.cursor.eventSequence).toBe(expectedCoverage);
      expect(normalized.compactedThroughEventSequence).toBe(expectedCoverage);
    },
  );

  it("keeps synchronization backward compatible and rejects stale snapshot authority", () => {
    const baseHello = {
      protocolVersion: 1,
      sessionId,
      clientId: "client-a" as never,
      afterEventSequence: 12,
      connectedAt: "2026-07-24T20:00:00.000Z",
    } as const;

    expect(clientHelloShouldSynchronize(baseHello)).toBe(true);
    expect(clientHelloShouldSynchronize({ ...baseHello, synchronize: false })).toBe(false);
    expect(
      snapshotAuthorityCanAdvance({
        currentSnapshotSequence: 7,
        currentUpdatedAt: "2026-07-24T20:01:00.000Z",
        incomingSnapshotSequence: 6,
        incomingUpdatedAt: "2026-07-24T20:02:00.000Z",
      }),
    ).toBe(false);
    expect(
      snapshotAuthorityCanAdvance({
        currentSnapshotSequence: 7,
        currentUpdatedAt: "2026-07-24T20:01:00.000Z",
        incomingSnapshotSequence: 7,
        incomingUpdatedAt: "2026-07-24T20:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      snapshotAuthorityCanAdvance({
        currentSnapshotSequence: 7,
        currentUpdatedAt: "2026-07-24T20:01:00.000Z",
        incomingSnapshotSequence: 8,
        incomingUpdatedAt: "2026-07-24T20:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("pins runner actor A while accepting any authenticated controller for the exact public identity", () => {
    expect(
      localRunnerCanClaimPinnedAuthority({
        claims: runner,
        hello,
        pinned: null,
        sessionAlreadyClaimed: false,
      }),
    ).toBe(true);
    expect(
      localRunnerCanClaimPinnedAuthority({
        claims: { ...runner, actorId: "actor-b" },
        hello,
        pinned,
        sessionAlreadyClaimed: true,
      }),
    ).toBe(false);

    const controllerA = localControllerMatchesPinnedAuthority({
      claims: controller("actor-a"),
      sessionId,
      publication: "public",
      location,
      pinned,
    });
    const controllerB = localControllerMatchesPinnedAuthority({
      claims: controller("actor-b"),
      sessionId,
      publication: "public",
      location,
      pinned,
    });
    const wrongThread = localControllerMatchesPinnedAuthority({
      claims: controller("actor-a"),
      sessionId,
      publication: "public",
      location: { ...location, threadId: ThreadId.make("thread-b") },
      pinned,
    });
    const localOnly = localControllerMatchesPinnedAuthority({
      claims: controller("actor-b"),
      sessionId,
      publication: "local_only",
      location,
      pinned,
    });
    expect(controllerA).toBe(true);
    expect(controllerB).toBe(true);
    expect(wrongThread).toBe(false);
    expect(localOnly).toBe(false);
    expect(
      decideAuthorizedCommandSubmit({
        controllerMatchesSession: controllerA,
        runnerState: "online",
        eligibleRunnerCount: 1,
      }),
    ).toEqual({ type: "accepted" });
    expect(
      decideAuthorizedCommandSubmit({
        controllerMatchesSession: controllerB,
        runnerState: "online",
        eligibleRunnerCount: 1,
      }),
    ).toEqual({ type: "accepted" });
  });

  it("returns the original terminal receipt for an accepted duplicate command", () => {
    const existing = { status: "accepted" as const, resultSequence: 42, detail: null };
    expect(decideCommandSubmit(existing)).toEqual({ type: "duplicate", existing });
  });

  it("authorizes a Scaffold wake by stable identity without trusting a stale snapshot epoch", () => {
    const scaffoldLocation = {
      ...location,
      environmentKind: "scaffold",
      scaffoldSessionId: "scaffold-a",
      scaffoldSessionUrl: "https://scaffold.example/s/scaffold-a",
      scaffoldLifecycleEpoch: 7,
    } as const;
    const scaffoldController = {
      ...base,
      role: "controller",
      scopes: ["session:read", "session:command"],
      fabricSessionId: sessionId,
      environmentKind: "scaffold",
      environmentId,
      threadId,
      scaffoldSessionId: "scaffold-a",
      scaffoldLifecycleEpoch: 8,
      actorId: "actor-a",
    } as const satisfies SessionFabricCapabilityClaims;

    expect(
      scaffoldControllerMatchesSnapshotIdentity({
        claims: scaffoldController,
        sessionId,
        publication: "public",
        location: scaffoldLocation,
      }),
    ).toBe(true);
    expect(
      scaffoldControllerMatchesSnapshotIdentity({
        claims: { ...scaffoldController, scaffoldSessionId: "scaffold-b" },
        sessionId,
        publication: "public",
        location: scaffoldLocation,
      }),
    ).toBe(false);
    expect(
      scaffoldControllerMatchesSnapshotIdentity({
        claims: scaffoldController,
        sessionId,
        publication: "local_only",
        location: scaffoldLocation,
      }),
    ).toBe(false);
  });

  it("allows only an exact one-step settled-pause advance for a stale controller", () => {
    const settledPause = {
      expectedLifecycleEpoch: 7,
      targetLifecycleEpoch: 8,
      status: "completed",
    } as const;

    expect(
      scaffoldWakeExpectedLifecycleEpoch({
        durableLifecycleEpoch: 8,
        controllerLifecycleEpoch: 7,
        snapshotLifecycleEpoch: 7,
        settlePauseProof: settledPause,
      }),
    ).toBe(8);
    expect(
      scaffoldWakeExpectedLifecycleEpoch({
        durableLifecycleEpoch: 8,
        controllerLifecycleEpoch: 7,
        snapshotLifecycleEpoch: 7,
        settlePauseProof: undefined,
      }),
    ).toBeNull();
    expect(
      scaffoldWakeExpectedLifecycleEpoch({
        durableLifecycleEpoch: 9,
        controllerLifecycleEpoch: 7,
        snapshotLifecycleEpoch: 7,
        settlePauseProof: settledPause,
      }),
    ).toBeNull();
  });

  it("backfills legacy wake identity only from a matching trusted retained snapshot", () => {
    const snapshotJson = JSON.stringify({
      session: {
        sessionId,
        title: "Session",
        publication: "public",
        runnerState: "offline",
        location: {
          ...location,
          environmentKind: "scaffold",
          scaffoldSessionId: "scaffold-a",
          scaffoldSessionUrl: "https://scaffold.example/s/scaffold-a",
          scaffoldLifecycleEpoch: 7,
        },
        initialPrompt: null,
        searchableText: "Session",
        summary: null,
        cursor: { eventSequence: 0, snapshotSequence: 1 },
        lastEventAt: null,
        createdAt: "2026-07-24T20:00:00.000Z",
        updatedAt: "2026-07-24T20:00:00.000Z",
      },
      shell: {
        snapshotSequence: 1,
        projects: [],
        threads: [],
        updatedAt: "2026-07-24T20:00:00.000Z",
      },
      thread: {
        snapshotSequence: 1,
        thread: {
          id: threadId,
          projectId: ProjectId.make("project-a"),
          title: "Session",
          modelSelection: {
            instanceId: ProviderInstanceId.make("omp"),
            model: "gpt-5.6-terra",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: "/workspace/project-a",
          latestTurn: null,
          createdAt: "2026-07-24T20:00:00.000Z",
          updatedAt: "2026-07-24T20:00:00.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      },
      compactedThroughEventSequence: 0,
    });

    expect(
      legacyWakeIdentityFromStoredSnapshot({ snapshotJson, scaffoldSessionId: "scaffold-a" }),
    ).toEqual({ environmentId, threadId });
    expect(
      legacyWakeIdentityFromStoredSnapshot({ snapshotJson, scaffoldSessionId: "scaffold-b" }),
    ).toBeNull();
    expect(
      legacyWakeIdentityFromStoredSnapshot({
        snapshotJson: "not-json",
        scaffoldSessionId: "scaffold-a",
      }),
    ).toBeNull();
  });

  it.each([
    {
      name: "another environment",
      wakeEnvironmentId: "environment-b",
      wakeThreadId: "thread-a",
    },
    {
      name: "another thread",
      wakeEnvironmentId: "environment-a",
      wakeThreadId: "thread-b",
    },
    {
      name: "a legacy null environment",
      wakeEnvironmentId: null,
      wakeThreadId: "thread-a",
    },
    {
      name: "a legacy null thread",
      wakeEnvironmentId: "environment-a",
      wakeThreadId: null,
    },
  ])("does not share a Scaffold wake with $name at the same session and epoch", (wake) => {
    expect(
      scaffoldWakeIdentityMatches({
        ...wake,
        wakeScaffoldSessionId: "scaffold-a",
        wakeExpectedLifecycleEpoch: 7,
        environmentId: "environment-a",
        threadId: "thread-a",
        scaffoldSessionId: "scaffold-a",
        expectedLifecycleEpoch: 7,
      }),
    ).toBe(false);
  });

  it("shares a Scaffold wake only for the exact non-null identity", () => {
    expect(
      scaffoldWakeIdentityMatches({
        wakeEnvironmentId: "environment-a",
        wakeThreadId: "thread-a",
        wakeScaffoldSessionId: "scaffold-a",
        wakeExpectedLifecycleEpoch: 7,
        environmentId: "environment-a",
        threadId: "thread-a",
        scaffoldSessionId: "scaffold-a",
        expectedLifecycleEpoch: 7,
      }),
    ).toBe(true);
  });

  it("reveals pinned local authority only to the same authenticated viewer actor", () => {
    const viewer = (actorId: string): SessionFabricCapabilityClaims => ({
      ...base,
      role: "viewer",
      scopes: ["directory:read", "session:read"],
      actorId,
    });

    expect(localAuthorityViewForViewer({ claims: viewer("actor-a"), sessionId, pinned })).toEqual({
      fabricSessionId: sessionId,
      environmentKind: "local",
      environmentId,
      threadId,
      actorId: "actor-a",
    });
    expect(
      localAuthorityViewForViewer({ claims: viewer("actor-b"), sessionId, pinned }),
    ).toBeNull();
    expect(
      localAuthorityViewForViewer({
        claims: viewer("actor-a"),
        sessionId: SessionFabricSessionId.make("sf:environment-a:thread-b"),
        pinned,
      }),
    ).toBeNull();
    expect(
      localViewerCanReadPinnedAuthority({ claims: viewer("actor-a"), sessionId, pinned }),
    ).toBe(true);
  });
});
