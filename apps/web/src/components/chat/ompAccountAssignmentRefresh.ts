import type {
  EnvironmentId,
  OrchestrationLatestTurn,
  OrchestrationSession,
  ThreadId,
} from "@t3tools/contracts";

type AssignmentSessionState = Pick<OrchestrationSession, "status" | "updatedAt">;
type AssignmentTurnState = Pick<OrchestrationLatestTurn, "turnId" | "state" | "completedAt">;

export const OMP_ACCOUNT_ASSIGNMENT_MAX_REFRESH_ATTEMPTS = 4;

/**
 * Builds the authoritative revision that should revalidate an OMP account
 * assignment. The first settled revision repairs an initial query that raced
 * provider-session restoration; later completed turns reveal the sticky
 * account selected while that turn was starting.
 */
export function ompAccountAssignmentRefreshKey(input: {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly session: AssignmentSessionState | null;
  readonly latestTurn: AssignmentTurnState | null;
}): string | null {
  if (!input.enabled) return null;
  if (input.session?.status === "starting" || input.session?.status === "running") return null;

  const sessionRevision = input.session
    ? `${input.session.status}:${input.session.updatedAt}`
    : "no-session";
  const completedTurnRevision =
    input.latestTurn?.state === "completed" && input.latestTurn.completedAt
      ? `${input.latestTurn.turnId}:${input.latestTurn.completedAt}`
      : "no-completed-turn";

  return `${input.environmentId}:${input.threadId}:${sessionRevision}:${completedTurnRevision}`;
}

/**
 * A restored browser can query before the provider session directory has
 * resumed, and a just-completed turn can briefly report no account while OMP
 * publishes its sticky assignment. Retry those misses, but keep unsupported or
 * permanently unassigned runtimes bounded.
 */
export function shouldRefreshOmpAccountAssignment(input: {
  readonly refreshKey: string | null;
  readonly refreshAttemptCount: number;
  readonly isPending: boolean;
  readonly hasAssignedAccount: boolean;
  readonly hasError: boolean;
  readonly latestTurnCompleted: boolean;
}): boolean {
  if (
    input.refreshKey === null ||
    input.isPending ||
    input.refreshAttemptCount >= OMP_ACCOUNT_ASSIGNMENT_MAX_REFRESH_ATTEMPTS
  ) {
    return false;
  }

  // Revalidate every new authoritative revision once even when SWR is showing
  // an older sticky assignment from the previous turn.
  if (input.refreshAttemptCount === 0) return true;
  if (input.hasAssignedAccount) return false;

  return input.hasError || input.latestTurnCompleted;
}
