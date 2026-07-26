import {
  EnvironmentId,
  ProviderDriverKind,
  SessionFabricSessionId,
  type ProviderInstanceId,
  type SessionFabricEnvironmentKind,
  type SessionFabricRunnerState,
  type ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { makeSessionFabricDirectoryClient } from "@t3tools/client-runtime/session-source";
import * as Effect from "effect/Effect";

export interface ComposerSessionMention {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

export interface ComposerFabricSessionMention extends ComposerSessionMention {
  readonly sessionId: SessionFabricSessionId;
  readonly environmentKind: SessionFabricEnvironmentKind;
  readonly runnerState: SessionFabricRunnerState;
  readonly score: number | null;
  readonly matchText: string;
}

export function composerFabricEnvironmentId(sessionId: SessionFabricSessionId): EnvironmentId {
  return EnvironmentId.make(`session-fabric:${sessionId}`);
}

export function composerFabricSessionId(
  environmentId: EnvironmentId,
): SessionFabricSessionId | null {
  const prefix = "session-fabric:";
  if (!environmentId.startsWith(prefix) || environmentId.length === prefix.length) return null;
  return SessionFabricSessionId.make(environmentId.slice(prefix.length));
}

export async function loadComposerFabricSessionMentions(input: {
  readonly relayBaseUrl: string | URL;
  readonly query: string;
  readonly limit?: number;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<ReadonlyArray<ComposerFabricSessionMention>> {
  const client = makeSessionFabricDirectoryClient({
    relayBaseUrl: input.relayBaseUrl,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const query = input.query.trim();
  const results = query
    ? (await Effect.runPromise(client.search({ query, limit: input.limit ?? 10 }))).results
    : (await Effect.runPromise(client.list())).sessions.map((session) => ({
        session,
        score: null,
        matchText: session.summary ?? session.initialPrompt ?? session.title,
      }));
  return results.map(({ session, score, matchText }) => ({
    sessionId: session.sessionId,
    environmentId: composerFabricEnvironmentId(session.sessionId),
    threadId: session.location.threadId,
    title: session.title,
    worktreePath: null,
    branch: null,
    environmentKind: session.location.environmentKind,
    runnerState: session.runnerState,
    score,
    matchText,
  }));
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
