import { describe, expect, it } from "vite-plus/test";

import branchToolbarSource from "./BranchToolbar.tsx?raw";
import chatViewSource from "./ChatView.tsx?raw";
import {
  shouldIgnoreSourceEnvironmentForScaffoldDraft,
  shouldPrepareWorktreeForFirstMessage,
} from "./BranchToolbar.logic";

describe("Scaffold draft controls", () => {
  it("keeps the composer independent from sandbox startup", () => {
    expect(chatViewSource).toContain("isConnecting={composerIsConnecting}");
    expect(chatViewSource).not.toContain("isConnecting={isConnecting || scaffoldSendPending}");
  });

  it("queues the first prompt without showing the source device reconnect state", () => {
    expect(
      shouldIgnoreSourceEnvironmentForScaffoldDraft({
        scaffoldEnvironmentId: null,
        scaffoldPhase: "creating",
      }),
    ).toBe(true);
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
    expect(chatViewSource).toMatch(
      /if \(!scaffoldDraftBoundToTarget\)[\s\S]*?pendingTurnDrainKeyRef\.current = null;[\s\S]*?return;/,
    );
    expect(chatViewSource).toContain("!scaffoldDraftBoundToTarget ||");
    expect(chatViewSource).toMatch(
      /scaffoldSessionUi !== null && !scaffoldDraftBoundToTarget[\s\S]*?scaffold-pending:/,
    );
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

  it("retries only the failed draft's durable lifecycle action", () => {
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
