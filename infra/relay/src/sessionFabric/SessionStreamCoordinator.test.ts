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
import * as NodeSqlite from "node:sqlite";
import { vi } from "vitest";

vi.mock("alchemy/Cloudflare", () => ({
  DurableObject: () => () =>
    class {
      readonly mocked = true;
    },
}));

import {
  ADVANCE_SETTLE_PAUSE_LIFECYCLE_AUTHORITY_SQL,
  ADVANCE_SNAPSHOT_LIFECYCLE_AUTHORITY_SQL,
  clientHelloShouldSynchronize,
  DELETE_REPLACEABLE_SETTLE_PAUSE_SQL,
  LEGACY_WAKE_IDENTITY_COLUMN_SQL,
  LEGACY_WAKE_IDENTITY_SELECT_SQL,
  LEGACY_WAKE_IDENTITY_UPDATE_SQL,
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

    // The paused epoch remains authoritative while the retained snapshot still describes E.
    // Only the resumed runner's E+2 snapshot advances the controller-visible authority.
    expect(
      scaffoldWakeExpectedLifecycleEpoch({
        durableLifecycleEpoch: 9,
        controllerLifecycleEpoch: 9,
        snapshotLifecycleEpoch: 9,
        settlePauseProof: undefined,
      }),
    ).toBe(9);
    expect(
      scaffoldWakeExpectedLifecycleEpoch({
        durableLifecycleEpoch: 9,
        controllerLifecycleEpoch: 7,
        snapshotLifecycleEpoch: 9,
        settlePauseProof: settledPause,
      }),
    ).toBeNull();
  });

  it("retains paused lifecycle authority for command or unsettle wake until the resumed snapshot", () => {
    const database = new NodeSqlite.DatabaseSync(":memory:");
    database.exec(
      "CREATE TABLE session_meta (id INTEGER PRIMARY KEY, runner_generation INTEGER NOT NULL, scaffold_lifecycle_authority_epoch INTEGER, runner_state TEXT NOT NULL, snapshot_json TEXT, snapshot_sequence INTEGER NOT NULL)",
    );
    database
      .prepare(
        "INSERT INTO session_meta (id, runner_generation, scaffold_lifecycle_authority_epoch, runner_state, snapshot_json, snapshot_sequence) VALUES (1, 7, 7, 'online', 'snapshot-e7', 7)",
      )
      .run();

    database
      .prepare(ADVANCE_SETTLE_PAUSE_LIFECYCLE_AUTHORITY_SQL)
      .run(8, 8, "paused-snapshot-e7", 7);
    // Runner hello E+2 advances only live runner fencing. The completed pause target E+1
    // remains the wake authority until the runner publishes its E+2 snapshot.
    database.prepare("UPDATE session_meta SET runner_generation = 9 WHERE id = 1").run();
    const beforeSnapshot = database
      .prepare(
        "SELECT runner_generation, scaffold_lifecycle_authority_epoch FROM session_meta WHERE id = 1",
      )
      .get() as { runner_generation: number; scaffold_lifecycle_authority_epoch: number };
    expect(beforeSnapshot).toEqual({
      runner_generation: 9,
      scaffold_lifecycle_authority_epoch: 8,
    });
    expect(
      scaffoldWakeExpectedLifecycleEpoch({
        durableLifecycleEpoch: beforeSnapshot.scaffold_lifecycle_authority_epoch,
        controllerLifecycleEpoch: 7,
        snapshotLifecycleEpoch: 7,
        settlePauseProof: {
          expectedLifecycleEpoch: 7,
          targetLifecycleEpoch: 8,
          status: "completed",
        },
      }),
    ).toBe(8);

    database.prepare(ADVANCE_SNAPSHOT_LIFECYCLE_AUTHORITY_SQL).run("resumed-snapshot-e9", 9, 9, 9);
    expect(
      database
        .prepare(
          "SELECT runner_generation, scaffold_lifecycle_authority_epoch FROM session_meta WHERE id = 1",
        )
        .get(),
    ).toEqual({ runner_generation: 9, scaffold_lifecycle_authority_epoch: 9 });
    database.close();
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

    const database = new NodeSqlite.DatabaseSync(":memory:");
    database.exec(
      "CREATE TABLE session_meta (id INTEGER PRIMARY KEY, snapshot_json TEXT); CREATE TABLE session_command_wakes (command_id TEXT PRIMARY KEY, scaffold_session_id TEXT NOT NULL, status TEXT NOT NULL)",
    );
    database
      .prepare("INSERT INTO session_meta (id, snapshot_json) VALUES (1, ?)")
      .run(snapshotJson);
    database
      .prepare(
        "INSERT INTO session_command_wakes (command_id, scaffold_session_id, status) VALUES (?, ?, 'pending')",
      )
      .run("command-legacy", "scaffold-a");
    for (const statement of Object.values(LEGACY_WAKE_IDENTITY_COLUMN_SQL)) {
      database.exec(statement);
    }
    const legacyRows = database.prepare(LEGACY_WAKE_IDENTITY_SELECT_SQL).all() as Array<{
      command_id: string;
      scaffold_session_id: string;
    }>;
    const retainedSnapshot = database
      .prepare("SELECT snapshot_json FROM session_meta WHERE id = 1")
      .get() as { snapshot_json: string };
    for (const wake of legacyRows) {
      const identity = legacyWakeIdentityFromStoredSnapshot({
        snapshotJson: retainedSnapshot.snapshot_json,
        scaffoldSessionId: wake.scaffold_session_id,
      });
      expect(identity).not.toBeNull();
      database
        .prepare(LEGACY_WAKE_IDENTITY_UPDATE_SQL)
        .run(identity!.environmentId, identity!.threadId, wake.command_id);
    }
    expect(
      database
        .prepare("SELECT environment_id, thread_id FROM session_command_wakes WHERE command_id = ?")
        .get("command-legacy"),
    ).toEqual({ environment_id: environmentId, thread_id: threadId });
    database.close();
  });

  it.each(["failed", "cancelled"])(
    "allows a new settle pause at the same epoch after a %s attempt",
    (terminalStatus) => {
      const database = new NodeSqlite.DatabaseSync(":memory:");
      database.exec(
        "CREATE TABLE session_settle_pauses (settlement_event_id TEXT PRIMARY KEY, fabric_session_id TEXT NOT NULL, expected_lifecycle_epoch INTEGER NOT NULL, status TEXT NOT NULL, UNIQUE(fabric_session_id, expected_lifecycle_epoch))",
      );
      database
        .prepare(
          "INSERT INTO session_settle_pauses (settlement_event_id, fabric_session_id, expected_lifecycle_epoch, status) VALUES (?, ?, ?, ?)",
        )
        .run("settlement-old", sessionId, 7, terminalStatus);

      database.prepare(DELETE_REPLACEABLE_SETTLE_PAUSE_SQL).run(sessionId, 7);
      database
        .prepare(
          "INSERT OR IGNORE INTO session_settle_pauses (settlement_event_id, fabric_session_id, expected_lifecycle_epoch, status) VALUES (?, ?, ?, 'pending')",
        )
        .run("settlement-new", sessionId, 7);

      expect(
        database
          .prepare(
            "SELECT settlement_event_id, status FROM session_settle_pauses WHERE fabric_session_id = ? AND expected_lifecycle_epoch = ?",
          )
          .get(sessionId, 7),
      ).toEqual({ settlement_event_id: "settlement-new", status: "pending" });
      database.close();
    },
  );

  it("does not replace a completed settle pause at the same epoch", () => {
    const database = new NodeSqlite.DatabaseSync(":memory:");
    database.exec(
      "CREATE TABLE session_settle_pauses (settlement_event_id TEXT PRIMARY KEY, fabric_session_id TEXT NOT NULL, expected_lifecycle_epoch INTEGER NOT NULL, status TEXT NOT NULL, UNIQUE(fabric_session_id, expected_lifecycle_epoch))",
    );
    database
      .prepare(
        "INSERT INTO session_settle_pauses (settlement_event_id, fabric_session_id, expected_lifecycle_epoch, status) VALUES (?, ?, ?, 'completed')",
      )
      .run("settlement-completed", sessionId, 7);

    database.prepare(DELETE_REPLACEABLE_SETTLE_PAUSE_SQL).run(sessionId, 7);
    database
      .prepare(
        "INSERT OR IGNORE INTO session_settle_pauses (settlement_event_id, fabric_session_id, expected_lifecycle_epoch, status) VALUES (?, ?, ?, 'pending')",
      )
      .run("settlement-new", sessionId, 7);

    expect(
      database
        .prepare(
          "SELECT settlement_event_id, status FROM session_settle_pauses WHERE fabric_session_id = ? AND expected_lifecycle_epoch = ?",
        )
        .get(sessionId, 7),
    ).toEqual({ settlement_event_id: "settlement-completed", status: "completed" });
    database.close();
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
