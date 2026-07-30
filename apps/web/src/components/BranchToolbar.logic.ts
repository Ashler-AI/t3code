import type { EnvironmentId, ProjectId, ScaffoldDeployment, VcsRef } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import * as Schema from "effect/Schema";
import { toSortableTimestamp } from "../lib/threadSort";
export {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
} from "@t3tools/shared/git";

export interface EnvironmentOption {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  label: string;
  isPrimary: boolean;
}

export const EnvMode = Schema.Literals(["local", "worktree"]);
export type EnvMode = typeof EnvMode.Type;

const GENERIC_LOCAL_ENVIRONMENT_LABELS = new Set(["local", "local environment"]);

function normalizeDisplayLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function resolveEnvironmentOptionLabel(input: {
  isPrimary: boolean;
  environmentId: EnvironmentId;
  runtimeLabel?: string | null;
  savedLabel?: string | null;
}): string {
  const runtimeLabel = normalizeDisplayLabel(input.runtimeLabel);
  const savedLabel = normalizeDisplayLabel(input.savedLabel);

  if (input.isPrimary) {
    const preferredLocalLabel = [runtimeLabel, savedLabel].find((label) => {
      if (!label) return false;
      return !GENERIC_LOCAL_ENVIRONMENT_LABELS.has(label.toLowerCase());
    });
    return preferredLocalLabel ?? "This device";
  }

  return runtimeLabel ?? savedLabel ?? input.environmentId;
}

// A remote (non-primary) environment is always surfaced, even when it is the
// only environment available: with a single connected machine there is nothing
// to pick, but the user still needs to see where the project runs.
export function shouldShowEnvironmentIndicator(input: {
  activeEnvironment: Pick<EnvironmentOption, "isPrimary"> | null;
  canPickEnvironment: boolean;
}): boolean {
  if (input.canPickEnvironment) return true;
  return input.activeEnvironment !== null && !input.activeEnvironment.isPrimary;
}

export function resolveEnvModeLabel(mode: EnvMode): string {
  return mode === "worktree" ? "New worktree" : "Current checkout";
}

export type ScaffoldDraftPhase = "creating" | "ready" | "resuming" | "paused" | "failed";

export const SCAFFOLD_UNSUPPORTED_DRAFT_MESSAGE =
  "Agent sessions are not available in this Scaffold deployment.";

export function resolveScaffoldDraftTargetPresentation(input: {
  deployment: ScaffoldDeployment;
  phase: ScaffoldDraftPhase;
  connectionPhase?: EnvironmentConnectionPhase;
  replacementRequired?: boolean;
  retryable?: boolean;
  error?: string | null;
}): {
  targetLabel: string;
  statusLabel: string;
  detailLabel: string | null;
  actionLabel: string | null;
} {
  if (input.replacementRequired) {
    return {
      targetLabel: "Scaffold",
      statusLabel: "Target not recorded",
      detailLabel: input.error?.trim() || null,
      actionLabel: "New session",
    };
  }
  const targetLabel = input.deployment === "staging" ? "Scaffold staging" : "Scaffold production";
  const statusLabel =
    input.phase === "ready" && input.connectionPhase === "error"
      ? "Unavailable"
      : input.phase === "ready" &&
          input.connectionPhase !== undefined &&
          input.connectionPhase !== "connected"
        ? "Reconnecting"
        : input.phase === "creating"
          ? "Starting"
          : input.phase === "resuming"
            ? "Resuming"
            : input.phase === "paused"
              ? "Paused"
              : input.phase === "failed"
                ? "Failed"
                : "Ready";
  return {
    targetLabel,
    statusLabel,
    detailLabel: input.phase === "failed" ? input.error?.trim() || null : null,
    actionLabel: input.phase === "failed" && input.retryable !== false ? "Retry" : null,
  };
}

export function shouldShowComposerContextStrip(input: {
  isGitRepo: boolean;
  hasActiveProject: boolean;
  hasScaffoldDraft: boolean;
}): boolean {
  return input.hasScaffoldDraft || (input.isGitRepo && input.hasActiveProject);
}

export function shouldRenderBranchToolbar(input: {
  hasActiveThread: boolean;
  hasActiveProject: boolean;
  hasScaffoldDraftTarget: boolean;
}): boolean {
  return input.hasActiveThread && (input.hasActiveProject || input.hasScaffoldDraftTarget);
}

export function shouldBlockComposerForConnection(input: {
  transportConnecting: boolean;
  scaffoldPhase: ScaffoldDraftPhase | null;
}): boolean {
  if (input.transportConnecting) return true;

  // Scaffold lifecycle work is durable in the browser outbox. It must not
  // prevent the first prompt from being queued while the sandbox starts.
  switch (input.scaffoldPhase) {
    case "creating":
    case "ready":
    case "resuming":
    case "paused":
    case "failed":
    case null:
      return false;
  }
}

export function shouldPrepareWorktreeForFirstMessage(input: {
  isFirstMessage: boolean;
  requestedEnvMode: EnvMode;
  hasWorktreePath: boolean;
  isScaffoldBacked: boolean;
}): boolean {
  return (
    input.isFirstMessage &&
    input.requestedEnvMode === "worktree" &&
    !input.hasWorktreePath &&
    !input.isScaffoldBacked
  );
}

export function shouldReleaseQueuedScaffoldDispatch(input: {
  hasScaffoldDraft: boolean;
  deliveryDeferred: boolean;
}): boolean {
  return input.hasScaffoldDraft && input.deliveryDeferred;
}

export type ScaffoldPendingTurnMode = "none" | "hydrate" | "drain";

export function resolveScaffoldPendingTurnMode(input: {
  hasScaffoldDraft: boolean;
  scaffoldPhase: ScaffoldDraftPhase | null;
  terminal?: boolean;
  boundToTarget: boolean;
  targetConnected: boolean;
}): ScaffoldPendingTurnMode {
  if (!input.hasScaffoldDraft) return "none";
  return input.terminal !== true &&
    input.scaffoldPhase === "ready" &&
    input.boundToTarget &&
    input.targetConnected
    ? "drain"
    : "hydrate";
}

export interface ScaffoldSendDecision {
  readonly blocked: boolean;
  readonly deliveryDeferred: boolean;
  readonly shouldResume: boolean;
}

export function resolveScaffoldSendDecision(input: {
  hasScaffoldSession: boolean;
  scaffoldPhase: ScaffoldDraftPhase | null;
  terminal?: boolean;
  boundToTarget: boolean;
  targetConnected: boolean;
  hasProject: boolean;
}): ScaffoldSendDecision {
  if (!input.hasScaffoldSession) {
    return { blocked: false, deliveryDeferred: false, shouldResume: false };
  }
  if (input.terminal === true) {
    return { blocked: true, deliveryDeferred: true, shouldResume: false };
  }
  return {
    blocked: false,
    deliveryDeferred:
      input.scaffoldPhase !== "ready" ||
      !input.boundToTarget ||
      !input.targetConnected ||
      !input.hasProject,
    shouldResume: input.scaffoldPhase === "paused",
  };
}

export function mergeQueuedScaffoldMessages<
  TMessage extends { readonly id: string; readonly createdAt: string },
>(input: {
  existing: ReadonlyArray<TMessage>;
  hydrated: ReadonlyArray<TMessage>;
  acknowledgedMessageIds: ReadonlySet<string>;
}): TMessage[] {
  const byId = new Map<string, TMessage>();
  for (const message of [...input.existing, ...input.hydrated]) {
    if (!input.acknowledgedMessageIds.has(message.id) && !byId.has(message.id)) {
      byId.set(message.id, message);
    }
  }
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function shouldIgnoreSourceEnvironmentForScaffoldDraft(input: {
  hasScaffoldDraft: boolean;
  boundToTarget: boolean;
}): boolean {
  return input.hasScaffoldDraft && !input.boundToTarget;
}

export function resolveCurrentWorkspaceLabel(activeWorktreePath: string | null): string {
  return activeWorktreePath ? "Current worktree" : resolveEnvModeLabel("local");
}

export function resolveLockedWorkspaceLabel(activeWorktreePath: string | null): string {
  return activeWorktreePath ? "Worktree" : "Local checkout";
}

export interface PreviousWorktreeSeed {
  branch: string | null;
  worktreePath: string;
}

// The most recently touched worktree in the project that the composer isn't
// already pointing at. Backs the "Previous worktree" entry in the workspace
// selector so a follow-up thread can hop back into the worktree you just
// worked in without hunting for its branch. Archived threads don't compete —
// the rest of the UI hides them, so their worktrees shouldn't resurface here.
export function resolvePreviousWorktreeSeed(input: {
  threads: ReadonlyArray<{
    branch: string | null;
    worktreePath: string | null;
    updatedAt: string;
    archivedAt?: string | null;
  }>;
  currentWorktreePath: string | null;
}): PreviousWorktreeSeed | null {
  let latest: { branch: string | null; worktreePath: string; updatedAt: number } | null = null;
  for (const thread of input.threads) {
    if (
      !thread.worktreePath ||
      thread.worktreePath === input.currentWorktreePath ||
      (thread.archivedAt ?? null) !== null
    ) {
      continue;
    }
    const updatedAt = toSortableTimestamp(thread.updatedAt);
    if (updatedAt === null) {
      continue;
    }
    if (latest === null || updatedAt > latest.updatedAt) {
      latest = {
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        updatedAt,
      };
    }
  }
  return latest === null ? null : { branch: latest.branch, worktreePath: latest.worktreePath };
}

export function resolvePreviousWorktreeLabel(seed: PreviousWorktreeSeed): string {
  return seed.branch ? `Previous worktree (${seed.branch})` : "Previous worktree";
}

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode } = input;
  if (!hasServerThread) {
    if (activeWorktreePath) {
      return "local";
    }
    return draftThreadEnvMode === "worktree" ? "worktree" : "local";
  }
  return activeWorktreePath ? "worktree" : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

export function resolveBranchToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): string | null {
  const { envMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (envMode === "worktree" && !activeWorktreePath) {
    return activeThreadBranch ?? currentGitBranch;
  }
  return currentGitBranch ?? activeThreadBranch;
}

export function resolveBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  resolvedActiveBranch: string | null;
  resolvedActiveBranchIsRemote: boolean | null;
  startFromOrigin: boolean;
}): string {
  const {
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
    resolvedActiveBranchIsRemote,
    startFromOrigin,
  } = input;
  if (!resolvedActiveBranch) {
    return "Select ref";
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath) {
    const baseRef =
      startFromOrigin && resolvedActiveBranchIsRemote === false
        ? `origin/${resolvedActiveBranch}`
        : resolvedActiveBranch;
    return `From ${baseRef}`;
  }
  return resolvedActiveBranch;
}

export function resolveBranchToolbarPrBranch(input: {
  activeThreadBranch: string | null;
  resolvedActiveBranch: string | null;
}): string | null {
  return input.activeThreadBranch === input.resolvedActiveBranch ? input.activeThreadBranch : null;
}

export function resolveInitialWorktreeBaseBranch(input: {
  currentGitBranch: string | null;
  defaultBranchName: string | null;
}): string | null {
  return input.currentGitBranch ?? input.defaultBranchName;
}

export function resolveLocalCheckoutBranchMismatch(input: {
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): { threadBranch: string; currentBranch: string } | null {
  const { effectiveEnvMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (effectiveEnvMode !== "local" || activeWorktreePath !== null) {
    return null;
  }
  if (!activeThreadBranch || !currentGitBranch || activeThreadBranch === currentGitBranch) {
    return null;
  }
  return { threadBranch: activeThreadBranch, currentBranch: currentGitBranch };
}

export function resolveBranchSelectionTarget(input: {
  activeProjectCwd: string;
  activeWorktreePath: string | null;
  refName: Pick<VcsRef, "isDefault" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, refName } = input;

  if (refName.worktreePath) {
    return {
      checkoutCwd: refName.worktreePath,
      nextWorktreePath: refName.worktreePath === activeProjectCwd ? null : refName.worktreePath,
      reuseExistingWorktree: true,
    };
  }

  const nextWorktreePath =
    activeWorktreePath !== null && refName.isDefault ? null : activeWorktreePath;

  return {
    checkoutCwd: nextWorktreePath ?? activeProjectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
  };
}

export function shouldIncludeBranchPickerItem(input: {
  itemValue: string;
  normalizedQuery: string;
  createBranchItemValue: string | null;
  checkoutPullRequestItemValue: string | null;
}): boolean {
  const { itemValue, normalizedQuery, createBranchItemValue, checkoutPullRequestItemValue } = input;

  if (normalizedQuery.length === 0) {
    return true;
  }

  if (createBranchItemValue && itemValue === createBranchItemValue) {
    return true;
  }

  if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
    return true;
  }

  return itemValue.toLowerCase().includes(normalizedQuery);
}
