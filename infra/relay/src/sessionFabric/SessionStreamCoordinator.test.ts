import {
  EnvironmentId,
  ProjectId,
  SessionFabricRunnerId,
  SessionFabricSessionId,
  ThreadId,
  type SessionFabricCapabilityClaims,
  type SessionFabricRunnerHello,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  localAuthorityViewForViewer,
  localControllerMatchesPinnedAuthority,
  localRunnerCanClaimPinnedAuthority,
  localViewerCanReadPinnedAuthority,
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
  it("pins runner actor A and accepts only controller actor A for the exact local identity", () => {
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
      location,
      pinned,
    });
    const controllerB = localControllerMatchesPinnedAuthority({
      claims: controller("actor-b"),
      sessionId,
      location,
      pinned,
    });
    const wrongThread = localControllerMatchesPinnedAuthority({
      claims: controller("actor-a"),
      sessionId,
      location: { ...location, threadId: ThreadId.make("thread-b") },
      pinned,
    });
    expect(controllerA).toBe(true);
    expect(controllerB).toBe(false);
    expect(wrongThread).toBe(false);
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
    ).toEqual({ type: "rejected", detail: "Controller capability required" });
  });

  it("returns the original terminal receipt for an accepted duplicate command", () => {
    const existing = { status: "accepted" as const, resultSequence: 42, detail: null };
    expect(decideCommandSubmit(existing)).toEqual({ type: "duplicate", existing });
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
