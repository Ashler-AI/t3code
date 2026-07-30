import { describe, expect, it } from "vite-plus/test";

import branchToolbarSource from "./BranchToolbar.tsx?raw";
import chatViewSource from "./ChatView.tsx?raw";
import {
  shouldIgnoreSourceEnvironmentForScaffoldDraft,
  shouldPrepareWorktreeForFirstMessage,
} from "./BranchToolbar.logic";

describe("Scaffold draft controls", () => {
  it("uses the source-aware settlement capability for the open-thread banner and action", () => {
    expect(chatViewSource).toMatch(
      /const supportsSettlement =\s*activeThread != null &&\s*readEnvironmentSupportsSettlement\(activeThread\.environmentId\);/u,
    );
    expect(chatViewSource).toMatch(
      /if \(activeThreadShell === null \|\| !supportsSettlement\) return false;[\s\S]*?handleUnsettleActiveThread/u,
    );
  });

  it("keeps the composer independent from sandbox startup", () => {
    expect(chatViewSource).toContain("isConnecting={composerIsConnecting}");
    expect(chatViewSource).toContain("isSendBusy || composerIsConnecting || isRevertingCheckpoint");
    expect(chatViewSource).not.toContain("isConnecting={isConnecting || scaffoldSendPending}");
  });

  it("releases the send control after the prompt is durably queued for Scaffold", () => {
    expect(chatViewSource).toMatch(
      /shouldReleaseQueuedScaffoldDispatch\(\{[\s\S]*?hasScaffoldDraft:[\s\S]*?deliveryDeferred: scaffoldDeliveryDeferred,[\s\S]*?resetLocalDispatch\(\)/,
    );
  });

  it("durably queues a paused-session turn before starting one resume", () => {
    expect(chatViewSource).toMatch(
      /resolveScaffoldSendDecision\(\{[\s\S]*?scaffoldPhase: effectiveScaffoldSession\?\.phase[\s\S]*?sendInFlightRef\.current = true;[\s\S]*?await enqueuePendingTurn[\s\S]*?messagePersistedToOutbox = true;[\s\S]*?if \(scaffoldSendDecision\.shouldResume && activeScaffoldSession\) \{[\s\S]*?setPhase\(activeScaffoldSession\.draftId, "resuming"\);[\s\S]*?handleReconnectActiveEnvironment\(activeThread\.environmentId\)/,
    );
    expect(chatViewSource).toMatch(
      /!activeThread \|\|[\s\S]*?isSendBusy \|\|[\s\S]*?sendInFlightRef\.current/,
    );
  });

  it("blocks terminal sessions without offering an environment reconnect on send", () => {
    expect(chatViewSource).toMatch(
      /const activeEnvironmentUnavailable =[^;]*activeScaffoldSession\?\.terminal !== true;/s,
    );
    expect(chatViewSource).toMatch(
      /if \(scaffoldSendDecision\.blocked\) \{[\s\S]*?setThreadError\([\s\S]*?return;[\s\S]*?if \(scaffoldSendDecision\.shouldResume/,
    );
  });

  it("shows the send control as busy while a paused-session turn is being persisted", () => {
    expect(chatViewSource).toMatch(/beginLocalDispatch\([\s\S]*?await enqueuePendingTurn/);
    expect(chatViewSource).toContain("isSendBusy={isSendBusy}");
  });

  it("queues the first prompt without showing the source device reconnect state", () => {
    expect(
      shouldIgnoreSourceEnvironmentForScaffoldDraft({
        hasScaffoldDraft: true,
        boundToTarget: false,
      }),
    ).toBe(true);
    expect(chatViewSource).toContain("boundToTarget: scaffoldDraftBoundToTarget");
    expect(chatViewSource).toContain(
      "transportConnecting: isConnecting && !ignoreSourceEnvironmentForScaffoldDraft",
    );
    expect(chatViewSource).toMatch(
      /const activeEnvironmentUnavailable =[\s\S]*?!ignoreSourceEnvironmentForScaffoldDraft/,
    );
    expect(chatViewSource).toMatch(
      /const onSend =[\s\S]*?\(isConnecting && !ignoreSourceEnvironmentForScaffoldDraft\)/,
    );
    expect(chatViewSource).toContain("environmentUnavailable={activeEnvironmentUnavailableState}");
  });

  it("keeps a ready Scaffold draft deferred until route, thread, and project share its target", () => {
    expect(chatViewSource).toMatch(
      /function isScaffoldDraftBoundToTarget[\s\S]*?routeEnvironmentId === targetEnvironmentId[\s\S]*?threadEnvironmentId === targetEnvironmentId[\s\S]*?projectEnvironmentId === targetEnvironmentId/,
    );
    expect(chatViewSource).toContain("boundToTarget: scaffoldDraftBoundToTarget");
    expect(chatViewSource).toContain(
      "const scaffoldDeliveryDeferred = scaffoldSendDecision.deliveryDeferred",
    );
    expect(chatViewSource).toMatch(
      /effectiveScaffoldSession !== null && !scaffoldDraftBoundToTarget[\s\S]*?scaffold-pending:/,
    );
  });

  it("does not project a local environment connection onto a remote Scaffold draft", () => {
    expect(chatViewSource).toMatch(
      /session\?\.phase !== "resuming"[\s\S]*?if \(!scaffoldDraftBoundToTarget\) return;[\s\S]*?activeEnvironmentConnectionPhase === "connected"/,
    );
  });

  it("rehydrates a draft-scoped queue before binding and gates all dispatch behind drain mode", () => {
    expect(chatViewSource).toContain(
      "const effectiveScaffoldSession = scaffoldSessionUi ?? activeScaffoldSession",
    );
    expect(chatViewSource).toMatch(
      /hasScaffoldDraft: effectiveScaffoldSession !== null[\s\S]*?scaffoldPendingTurnMode === "drain"[\s\S]*?listPendingTurnsForThread[\s\S]*?: \(await browserPendingTurnOutbox\.list\(\)\)\.filter\([\s\S]*?entry\.draftId === scaffoldDraftId/,
    );
    expect(chatViewSource).toMatch(
      /mergeQueuedScaffoldMessages\(\{[\s\S]*?acknowledgedMessageIds: serverMessageIds[\s\S]*?if \(scaffoldPendingTurnMode !== "drain"\) return;[\s\S]*?drainPendingTurnOutbox/,
    );
    expect(chatViewSource).toContain("draftId: effectiveScaffoldSession?.draftId ?? draftId");
  });

  it("never prepares a local worktree for a Scaffold-backed first turn", () => {
    expect(
      shouldPrepareWorktreeForFirstMessage({
        isFirstMessage: true,
        requestedEnvMode: "worktree",
        hasWorktreePath: false,
        isScaffoldBacked: true,
      }),
    ).toBe(false);
    expect(
      shouldPrepareWorktreeForFirstMessage({
        isFirstMessage: true,
        requestedEnvMode: "worktree",
        hasWorktreePath: false,
        isScaffoldBacked: false,
      }),
    ).toBe(true);
  });

  it("reconnects an existing failed target and replays creation only while unbound", () => {
    expect(chatViewSource).toMatch(
      /resolveFailedScaffoldDraftRetryMode\(entry\)[\s\S]*?retryMode === "reconnect"[\s\S]*?\.setPhase\(entry\.draftId, "resuming"\)[\s\S]*?handleReconnectActiveEnvironment\(targetEnvironmentId\)/,
    );
    expect(chatViewSource).toMatch(
      /retryScaffoldLifecycleAction\(\{[\s\S]*?store: browserScaffoldLifecycleActionStore,[\s\S]*?actionId: entry\.actionId,[\s\S]*?expectedDeployment: entry\.deployment/,
    );
    expect(chatViewSource).toMatch(
      /onCreating: \(\) => \{[\s\S]*?\.setPhase\(entry\.draftId, "creating"\)/,
    );
    expect(chatViewSource).toMatch(
      /onPersistenceFailure: \(\) => \{[\s\S]*?\.fail\(entry\.draftId, "Scaffold retry could not be saved\. Try again\."\)/,
    );
    expect(chatViewSource).toContain("requestScaffoldLifecycleDrain(retried.actionId)");
  });

  it("shows the failed target with an explicit recovery action", () => {
    expect(branchToolbarSource).toContain('data-scaffold-draft-target="true"');
    expect(branchToolbarSource).toContain("scaffoldDraftPresentation.actionLabel");
    expect(branchToolbarSource).toContain("onClick={scaffoldDraftAction}");
    expect(chatViewSource).toContain('openCommandPalette({ open: "new-session" })');
    expect(chatViewSource).toContain("SCAFFOLD_LEGACY_CREATE_MISSING_AUTHORITY_MESSAGE");
  });
});
