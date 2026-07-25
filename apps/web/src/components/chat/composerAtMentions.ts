import {
  EnvironmentId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export interface ComposerSessionMention {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

export function compatibleComposerSessionMentions(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly currentEnvironmentId: EnvironmentId;
  readonly currentThreadId: ThreadId | null;
  readonly selectedProvider: ProviderDriverKind;
  readonly providerByInstanceId: ReadonlyMap<ProviderInstanceId, ProviderDriverKind>;
}): ReadonlyArray<ComposerSessionMention> {
  if (input.selectedProvider !== ProviderDriverKind.make("omp")) {
    return [];
  }

  return input.threads
    .filter(
      (thread) =>
        thread.environmentId === input.currentEnvironmentId &&
        thread.id !== input.currentThreadId &&
        thread.archivedAt === null &&
        input.providerByInstanceId.get(thread.modelSelection.instanceId) === input.selectedProvider,
    )
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map((thread) => ({
      environmentId: thread.environmentId,
      threadId: thread.id,
      title: thread.title,
      worktreePath: thread.worktreePath,
      branch: thread.branch,
    }));
}
