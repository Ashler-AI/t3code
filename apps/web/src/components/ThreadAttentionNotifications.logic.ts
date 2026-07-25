import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface ThreadAttentionCandidate {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly key: string;
  readonly reason: "input" | "approval" | "completed" | "failed";
}

export function threadAttentionCandidate(
  thread: EnvironmentThreadShell,
  lastVisitedAt: string | undefined,
): ThreadAttentionCandidate | null {
  const base = {
    environmentId: thread.environmentId,
    threadId: thread.id,
    title: thread.title,
  };
  const turnKey =
    thread.latestTurn?.turnId ?? thread.session?.activeTurnId ?? thread.session?.updatedAt;

  if (thread.hasPendingApprovals) {
    return {
      ...base,
      key: `${thread.environmentId}:${thread.id}:approval:${turnKey ?? "pending"}`,
      reason: "approval",
    };
  }
  if (thread.hasPendingUserInput) {
    return {
      ...base,
      key: `${thread.environmentId}:${thread.id}:input:${turnKey ?? "pending"}`,
      reason: "input",
    };
  }
  if (thread.session?.status === "error") {
    return {
      ...base,
      key: `${thread.environmentId}:${thread.id}:failed:${thread.session.updatedAt}`,
      reason: "failed",
    };
  }

  const completedAt = thread.latestTurn?.completedAt;
  if (!completedAt || !lastVisitedAt) return null;
  const completedAtMs = Date.parse(completedAt);
  const lastVisitedAtMs = Date.parse(lastVisitedAt);
  if (!Number.isFinite(completedAtMs)) return null;
  if (Number.isFinite(lastVisitedAtMs) && completedAtMs <= lastVisitedAtMs) return null;

  return {
    ...base,
    key: `${thread.environmentId}:${thread.id}:completed:${completedAt}`,
    reason: "completed",
  };
}

export function newThreadAttentionCandidates(input: {
  readonly candidates: ReadonlyArray<ThreadAttentionCandidate>;
  readonly previousKeys: ReadonlySet<string>;
  readonly notifiedKeys: ReadonlySet<string>;
}): ThreadAttentionCandidate[] {
  return input.candidates.filter(
    (candidate) => !input.previousKeys.has(candidate.key) && !input.notifiedKeys.has(candidate.key),
  );
}

export function threadAttentionNotificationBody(
  reason: ThreadAttentionCandidate["reason"],
): string {
  switch (reason) {
    case "approval":
      return "Approval is required to continue.";
    case "input":
      return "The agent is waiting for your input.";
    case "failed":
      return "The agent turn needs attention.";
    case "completed":
      return "The agent finished its turn.";
  }
}
