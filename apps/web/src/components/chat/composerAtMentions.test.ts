import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SessionFabricSessionId,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import {
  compatibleComposerSessionMentions,
  composerFabricEnvironmentId,
  composerFabricSessionId,
  loadComposerFabricSessionMentions,
} from "./composerAtMentions";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const omp = ProviderDriverKind.make("omp");
const codex = ProviderDriverKind.make("codex");
const ompInstance = ProviderInstanceId.make("omp");
const codexInstance = ProviderInstanceId.make("codex");

function thread(input: {
  id: string;
  environmentId?: EnvironmentId;
  instanceId?: ProviderInstanceId;
  archivedAt?: string | null;
  settledAt?: string | null;
}): EnvironmentThreadShell {
  const now = "2026-07-24T12:00:00.000Z";
  return {
    environmentId: input.environmentId ?? local,
    id: ThreadId.make(input.id),
    projectId: ProjectId.make("project"),
    title: input.id,
    modelSelection: ModelSelection.make({
      instanceId: input.instanceId ?? ompInstance,
      model: "x",
    }),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: `branch/${input.id}`,
    worktreePath: `/tmp/${input.id}`,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: input.archivedAt ?? null,
    settledOverride: input.settledAt ? "settled" : null,
    settledAt: input.settledAt ?? null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("compatibleComposerSessionMentions", () => {
  it("includes active and done OMP sessions in the same environment", () => {
    const current = ThreadId.make("current");
    const mentions = compatibleComposerSessionMentions({
      threads: [
        thread({ id: "current" }),
        thread({ id: "active" }),
        thread({ id: "done", settledAt: "2026-07-24T11:00:00.000Z" }),
        thread({ id: "remote", environmentId: remote }),
        thread({ id: "codex", instanceId: codexInstance }),
        thread({ id: "archived", archivedAt: "2026-07-24T11:00:00.000Z" }),
      ],
      currentEnvironmentId: local,
      currentThreadId: current,
      selectedProvider: omp,
      providerByInstanceId: new Map([
        [ompInstance, omp],
        [codexInstance, codex],
      ]),
    });

    expect(mentions.map((mention) => mention.threadId)).toEqual([
      ThreadId.make("active"),
      ThreadId.make("done"),
    ]);
  });

  it("does not expose session references to non-OMP composers", () => {
    expect(
      compatibleComposerSessionMentions({
        threads: [thread({ id: "other" })],
        currentEnvironmentId: local,
        currentThreadId: null,
        selectedProvider: codex,
        providerByInstanceId: new Map([[ompInstance, omp]]),
      }),
    ).toEqual([]);
  });
});

describe("fabric composer session mentions", () => {
  it("keeps a reversible global fabric identity instead of a local environment id", () => {
    const sessionId = SessionFabricSessionId.make("global-session-1");
    const environmentId = composerFabricEnvironmentId(sessionId);
    expect(environmentId).toBe("session-fabric:global-session-1");
    expect(composerFabricSessionId(environmentId)).toBe(sessionId);
    expect(composerFabricSessionId(EnvironmentId.make("local"))).toBeNull();
  });

  it("semantically searches the central directory and does not expose a remote worktree path", async () => {
    const sessionId = SessionFabricSessionId.make("global-session-1");
    const record = {
      sessionId,
      title: "Repair OAuth callbacks",
      publication: "public",
      runnerState: "online",
      location: {
        environmentKind: "scaffold",
        environmentId: "sandbox-environment",
        projectId: "project-remote",
        threadId: "thread-remote",
        repositoryRoot: "/workspace/repo",
        worktreePath: "/workspace/secret-worktree",
        scaffoldSessionId: "ses_scaffold",
        scaffoldSessionUrl: "https://scaffold.example/ses_scaffold",
      },
      initialPrompt: "Repair OAuth callbacks",
      searchableText: "Repair OAuth callbacks and test Claude login",
      summary: null,
      cursor: { eventSequence: 4, snapshotSequence: 7 },
      lastEventAt: "2026-07-24T20:00:00.000Z",
      createdAt: "2026-07-24T19:00:00.000Z",
      updatedAt: "2026-07-24T20:00:00.000Z",
    };
    const mentions = await loadComposerFabricSessionMentions({
      relayBaseUrl: "https://relay.example/base/",
      query: "login regression",
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://relay.example/base/v1/session-fabric/search");
        expect(JSON.parse(String(init?.body))).toEqual({ query: "login regression", limit: 10 });
        return Response.json({
          results: [{ session: record, score: 0.93, matchText: record.searchableText }],
        });
      },
    });

    expect(mentions).toEqual([
      {
        sessionId,
        environmentId: EnvironmentId.make("session-fabric:global-session-1"),
        threadId: ThreadId.make("thread-remote"),
        title: "Repair OAuth callbacks",
        worktreePath: null,
        branch: null,
        environmentKind: "scaffold",
        runnerState: "online",
        score: 0.93,
        matchText: record.searchableText,
      },
    ]);
  });
});
