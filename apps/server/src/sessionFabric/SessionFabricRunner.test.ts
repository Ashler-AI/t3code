import {
  EnvironmentId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  SessionFabricSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  buildSessionFabricContextPublication,
  buildSessionFabricSnapshot,
  makeSessionFabricWebSocketProtocols,
  makeSessionFabricWebSocketUrl,
  resolveSessionFabricRunnerConfig,
  resolveSessionFabricSessionId,
  sessionFabricCommandReceipt,
  sessionFabricCapabilityRefreshDelayMs,
} from "./SessionFabricRunner.ts";

describe("SessionFabricRunner", () => {
  it("keeps a deterministic local session id and applies a handoff override only to its thread", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const targetThreadId = ThreadId.make("thread-1");
    const otherThreadId = ThreadId.make("thread-2");
    const overrideSessionId = SessionFabricSessionId.make("global-session-1");
    expect(
      resolveSessionFabricSessionId({
        environmentId,
        threadId: targetThreadId,
        overrideSessionId,
        overrideThreadId: targetThreadId,
      }),
    ).toBe(overrideSessionId);
    expect(
      resolveSessionFabricSessionId({
        environmentId,
        threadId: otherThreadId,
        overrideSessionId,
        overrideThreadId: targetThreadId,
      }),
    ).toBe("sf:environment-1:thread-2");
  });

  it("derives Scaffold mode from the actual sandbox session and builds the DO socket URL", () => {
    const config = resolveSessionFabricRunnerConfig({
      relayUrl: Option.some(new URL("https://relay.example.test/base/")),
      environmentKind: Option.none(),
      publication: "public",
      runnerGeneration: -2,
      overrideSessionId: Option.none(),
      overrideThreadId: Option.none(),
      scaffoldSessionId: Option.some("ses_scaffold"),
      scaffoldSessionUrl: Option.none(),
      scaffoldLifecycleEpoch: Option.some(4),
      runtimeApiToken: Option.some("runtime-secret"),
      authMode: "required",
    });
    expect(config.environmentKind).toBe("scaffold");
    expect(config.runnerGeneration).toBe(0);
    expect(config.scaffoldLifecycleEpoch).toBe(4);
    expect(
      makeSessionFabricWebSocketUrl(
        config.relayUrl!,
        SessionFabricSessionId.make("global-session-1"),
      )?.toString(),
    ).toBe("wss://relay.example.test/base/v1/session-fabric/sessions/global-session-1/connect");
  });

  it("publishes a session-scoped snapshot with searchable transcript context", () => {
    const threadId = ThreadId.make("thread-1");
    const project = {
      id: "project-1",
      title: "Harness",
      workspaceRoot: "/workspace/harness",
    };
    const threadShell = {
      id: threadId,
      projectId: "project-1",
      title: "Repair the relay",
    };
    const shell = {
      snapshotSequence: 8,
      projects: [project],
      threads: [threadShell],
      updatedAt: "2026-07-24T20:00:00.000Z",
    } as unknown as OrchestrationShellSnapshot;
    const detail = {
      snapshotSequence: 8,
      thread: {
        id: threadId,
        projectId: "project-1",
        title: "Repair the relay",
        worktreePath: "/workspace/worktrees/thread-1",
        messages: [
          {
            role: "user",
            text: "Make multiplayer reliable",
          },
          {
            role: "assistant",
            text: "The stream now reconnects.",
          },
        ],
        activities: [{ summary: "Ran the focused test" }],
        proposedPlans: [],
        createdAt: "2026-07-24T19:00:00.000Z",
        updatedAt: "2026-07-24T20:00:00.000Z",
      },
    } as unknown as OrchestrationThreadDetailSnapshot;
    const snapshot = buildSessionFabricSnapshot({
      sessionId: SessionFabricSessionId.make("global-session-1"),
      environmentId: EnvironmentId.make("environment-1"),
      environmentKind: "scaffold",
      scaffoldSessionId: "ses_scaffold",
      scaffoldSessionUrl: "https://scaffold.example.test/?q=ses_scaffold",
      scaffoldLifecycleEpoch: 3,
      publication: "public",
      acknowledgedEventSequence: 5,
      shell,
      detail,
    });
    expect(snapshot?.shell.projects).toEqual([project]);
    expect(snapshot?.shell.threads).toEqual([threadShell]);
    expect(snapshot?.session.initialPrompt).toBe("Make multiplayer reliable");
    expect(snapshot?.session.searchableText).toContain("The stream now reconnects.");
    expect(snapshot?.session.searchableText).toContain("Ran the focused test");
    expect(snapshot?.session.cursor).toEqual({ eventSequence: 5, snapshotSequence: 8 });
    expect(snapshot?.session.location).toMatchObject({
      environmentKind: "scaffold",
      scaffoldSessionId: "ses_scaffold",
      scaffoldLifecycleEpoch: 3,
    });
  });

  it("authenticates the socket with an in-memory capability and refreshes before expiry", () => {
    const grant = {
      capability: "header.payload.signature",
      tokenType: "Bearer",
      role: "runner",
      scopes: ["session:publish", "session:execute"],
      expiresAt: "2026-07-24T20:15:00.000Z",
      issuer: "scaffold",
      audience: "session-fabric",
      keyId: "proof-1",
      bindings: { scaffoldSessionId: "ses_scaffold", scaffoldLifecycleEpoch: 4 },
    } as const;
    expect(makeSessionFabricWebSocketProtocols(grant)).toEqual([
      "t3.session-fabric.v1",
      "t3.session-fabric.capability.header.payload.signature",
    ]);
    expect(
      sessionFabricCapabilityRefreshDelayMs(
        grant.expiresAt,
        Date.parse("2026-07-24T20:00:00.000Z"),
      ),
    ).toBe(870_000);
    expect(JSON.stringify({ protocols: makeSessionFabricWebSocketProtocols(null) })).not.toContain(
      grant.capability,
    );
    expect(makeSessionFabricWebSocketProtocols(null)).toEqual([]);
  });

  it("rejects an auth-disabled Scaffold runner", () => {
    expect(() =>
      resolveSessionFabricRunnerConfig({
        relayUrl: Option.some(new URL("https://relay.example.test/")),
        environmentKind: Option.some("scaffold"),
        publication: "public",
        runnerGeneration: 0,
        overrideSessionId: Option.none(),
        overrideThreadId: Option.none(),
        scaffoldSessionId: Option.some("ses_scaffold"),
        scaffoldSessionUrl: Option.some("https://scaffold.example.test/?q=ses_scaffold"),
        scaffoldLifecycleEpoch: Option.some(4),
        runtimeApiToken: Option.some("runtime-secret"),
        authMode: "disabled",
      }),
    ).toThrow("only be disabled for a local runner");
  });

  it("returns the orchestration engine's original sequence on accepted duplicate dispatch", () => {
    const command = {
      sessionId: SessionFabricSessionId.make("global-session-1"),
      commandId: "command-1",
    } as never;
    expect(
      sessionFabricCommandReceipt({
        command,
        resultSequence: 17,
        accepted: true,
        updatedAt: "2026-07-24T20:00:00.000Z",
      }),
    ).toMatchObject({
      status: "accepted",
      resultSequence: 17,
    });
  });

  it("publishes an opaque fabric continuation instead of a provider-native cursor", () => {
    expect(
      buildSessionFabricContextPublication({
        sessionId: SessionFabricSessionId.make("global-session-1"),
        runnerId: "runner-1" as never,
        runnerGeneration: 2,
        codeDiff: "diff --git a/file.ts b/file.ts",
        publishedAt: "2026-07-24T20:00:00.000Z",
      }),
    ).toEqual({
      sessionId: SessionFabricSessionId.make("global-session-1"),
      runnerId: "runner-1",
      runnerGeneration: 2,
      codeDiff: "diff --git a/file.ts b/file.ts",
      continuationRef: "session-fabric:global-session-1",
      publishedAt: "2026-07-24T20:00:00.000Z",
    });
  });
});
