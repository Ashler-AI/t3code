import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { compatibleComposerSessionMentions } from "./composerAtMentions";

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
