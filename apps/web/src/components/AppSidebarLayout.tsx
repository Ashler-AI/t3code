import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ScaffoldLifecycleAction,
  ScaffoldLifecycleActionStore,
  ScaffoldOutboxExecutionResult,
} from "@t3tools/client-runtime/scaffold";
import {
  mapScaffoldLifecycleError,
  reconcileScaffoldLifecycle,
  scaffoldOutboxResultFromReconciliation,
} from "@t3tools/client-runtime/scaffold";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionTarget,
  type EnvironmentConnectionPhase,
  type ScaffoldConnectionTarget,
} from "@t3tools/client-runtime/connection";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { isElectron } from "../env";
import { getLocalStorageItem } from "../hooks/useLocalStorage";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { cn, isMacPlatform } from "../lib/utils";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../state/server";
import { useEnvironmentIdentificationMode } from "../hooks/useSettings";
import ThreadSidebar from "./Sidebar";
import ThreadSidebarV2 from "./SidebarV2";
import { useSidebarStageBackdropVariant } from "./SidebarStageBackdrop";
import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./threadSidebarWidth";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
  useSidebarVisibility,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { toastManager } from "./ui/toast";
import { ThreadAttentionNotifications } from "./ThreadAttentionNotifications";
import {
  SCAFFOLD_DEPLOYMENT_MISMATCH_MESSAGE,
  SCAFFOLD_LEGACY_CREATE_MISSING_AUTHORITY_MESSAGE,
  SCAFFOLD_SESSION_FAILED_MESSAGE,
  SCAFFOLD_SESSION_STOPPED_MESSAGE,
  scaffoldSessionUiEntryFromCreateAction,
  scaffoldSessionUiEntryMatchesCreateAction,
  scaffoldSessionUiEntryMatchesPendingCreateAction,
  scaffoldSessionForEnvironment,
  useScaffoldSessionUiStore,
} from "../scaffoldSessionUiStore";
import type { ScaffoldSessionUiEntry } from "../scaffoldSessionUiStore";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  readThreadShell,
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { threadEnvironment } from "../state/threads";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ScaffoldLifecycleError,
  ScaffoldObserveInput,
  ScaffoldRenameInput,
  type ScaffoldSessionObservation,
  type EnvironmentId,
  type ModelSelection,
  type ScopedProjectRef,
  type ServerProvider,
} from "@t3tools/contracts";
import { environmentCatalog } from "../connection/catalog";
import { environmentShell } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { connectScaffoldEnvironment } from "../connection/scaffoldOnboarding";
import { requestScaffoldSessionObservation } from "../connection/scaffold";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  browserScaffoldLifecycleActionStore,
  createScaffoldLifecycleDrainRunner,
  drainScaffoldLifecycleActions,
  LEGACY_CREATE_MISSING_AUTHORITY,
  requestScaffoldLifecycleDrain,
  resolveScaffoldLifecycleRetryDelay,
  scaffoldPauseInputFromAction,
  subscribeScaffoldLifecycleDrain,
} from "../connection/scaffoldLifecycleOutbox";
import {
  browserPendingTurnOutbox,
  createPendingTurnCoordinatorAdapter,
  discardPendingTurn,
  drainPendingTurnOutbox,
  retargetPendingTurnsForDraft,
  subscribePendingTurnDrain,
} from "../connection/pendingTurnOutbox";
import { resolveScaffoldDraftModelSelection } from "../hooks/useHandleNewThread";
import { SCAFFOLD_UNSUPPORTED_DRAFT_MESSAGE } from "./BranchToolbar.logic";
import {
  createScaffoldSessionTitleSyncRunner,
  scaffoldSessionTitleSyncTargetAvailability,
  selectScaffoldSessionTitleSyncCandidates,
} from "../connection/scaffoldSessionTitleSync";

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "90px";
const notifiedTerminalPendingTurns = new Set<string>();
const liveEnvironmentIdsAtom = Atom.make((get) =>
  [...get(environmentCatalog.catalogValueAtom).entries.keys()].filter(
    (environmentId) => get(environmentShell.stateValueAtom(environmentId)).status === "live",
  ),
).pipe(Atom.withLabel("web-pending-turn-live-environment-ids"));
const environmentProviderCatalogsAtom = Atom.make(
  (get): ReadonlyMap<EnvironmentId, ReadonlyArray<ServerProvider> | null> =>
    new Map(
      [...get(environmentCatalog.catalogValueAtom).entries.keys()].map((environmentId) => [
        environmentId,
        get(serverEnvironment.providersValueAtom(environmentId)),
      ]),
    ),
).pipe(Atom.withLabel("web-environment-provider-catalogs"));

const isConnectionBlockedError = Schema.is(ConnectionBlockedError);
const isConnectionTransientError = Schema.is(ConnectionTransientError);
const isScaffoldLifecycleError = Schema.is(ScaffoldLifecycleError);

export function classifyScaffoldCreateFailure(error: unknown): {
  readonly result:
    | { readonly _tag: "blocked"; readonly errorCode: string }
    | {
        readonly _tag: "wait";
        readonly retryAfterMs: number;
        readonly errorCode: string;
        readonly observation?: {
          readonly sessionId: string;
          readonly lifecycleEpoch: number;
        };
      }
    | { readonly _tag: "retry"; readonly retryAfterMs: number; readonly errorCode: string };
  readonly detail?: string;
  readonly terminalObservation?: {
    readonly sessionId: string;
    readonly lifecycleEpoch: number;
    readonly status: "stopped" | "failed";
  };
} {
  if (isScaffoldLifecycleError(error)) {
    if (error.code === "scaffold_preparation_pending") {
      return {
        result: {
          _tag: "wait",
          retryAfterMs: error.retryAfterMs ?? 1_000,
          errorCode: error.code,
          ...(error.observation
            ? {
                observation: {
                  sessionId: error.observation.sessionId,
                  lifecycleEpoch: error.observation.lifecycleEpoch,
                },
              }
            : {}),
        },
      };
    }
    if (
      (error.reason === "terminal" || error.reason === "not_found") &&
      (error.observation?.status === "stopped" || error.observation?.status === "failed")
    ) {
      return {
        result: { _tag: "blocked", errorCode: error.code },
        detail:
          error.observation.status === "stopped"
            ? SCAFFOLD_SESSION_STOPPED_MESSAGE
            : SCAFFOLD_SESSION_FAILED_MESSAGE,
        terminalObservation: {
          sessionId: error.observation.sessionId,
          lifecycleEpoch: error.observation.lifecycleEpoch,
          status: error.observation.status,
        },
      };
    }
    return classifyScaffoldCreateFailure(mapScaffoldLifecycleError(error));
  }
  if (isConnectionBlockedError(error)) {
    return {
      result: { _tag: "blocked", errorCode: error.reason },
      detail: error.reason === "unsupported" ? SCAFFOLD_UNSUPPORTED_DRAFT_MESSAGE : error.detail,
    };
  }
  if (isConnectionTransientError(error)) {
    return {
      result: { _tag: "wait", retryAfterMs: 1_000, errorCode: error.reason },
      detail: error.detail,
    };
  }
  return {
    result: { _tag: "retry", retryAfterMs: 1_000, errorCode: "scaffold_create_failed" },
  };
}

type ScaffoldPauseLifecycleAction = Extract<ScaffoldLifecycleAction, { readonly kind: "pause" }>;

export function authorizeScaffoldPause(input: {
  readonly action: ScaffoldPauseLifecycleAction;
  readonly threadShells: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "id" | "settledOverride">
  >;
  readonly shellsReady: boolean;
}): "execute" | "wait" | "acknowledge" {
  if (!input.shellsReady) return "wait";
  const environmentThreads = input.threadShells.filter(
    (thread) => thread.environmentId === input.action.environmentId,
  );
  // `effectiveSettled` also classifies threads from client-observed PR state
  // and elapsed inactivity. Those signals are appropriate for sidebar
  // placement, but they must not authorize a remote sandbox lifecycle
  // mutation. Pause only after every thread in the shared environment has a
  // durable, server-projected explicit settlement.
  const source = environmentThreads.find((thread) => thread.id === input.action.sourceThreadId);
  if (source?.settledOverride !== "settled") return "acknowledge";
  return environmentThreads.some(
    (thread) => thread.id !== input.action.sourceThreadId && thread.settledOverride !== "settled",
  )
    ? "acknowledge"
    : "execute";
}

export function reconcileScaffoldPauseAction(input: {
  readonly action: ScaffoldPauseLifecycleAction;
  readonly observation?: ScaffoldSessionObservation;
  readonly error?: unknown;
}): ScaffoldOutboxExecutionResult {
  const error = isScaffoldLifecycleError(input.error) ? input.error : undefined;
  const observation = input.observation ?? error?.observation;
  return scaffoldOutboxResultFromReconciliation(
    reconcileScaffoldLifecycle({
      kind: "pause",
      expectedLifecycleEpoch: input.action.expectedLifecycleEpoch,
      ...(observation ? { observation } : {}),
      ...(error
        ? {
            httpStatus: error.status,
            errorCode: error.code,
            ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
          }
        : input.error !== undefined
          ? { httpStatus: 0, errorCode: "scaffold_pause_failed" }
          : {}),
    }),
    error?.code ?? "scaffold_pause_failed",
  );
}

function blockedScaffoldCreateDetail(errorCode: string | null): string {
  switch (errorCode) {
    case "scaffold_create_deployment_mismatch":
    case "scaffold_binding_deployment_mismatch":
      return SCAFFOLD_DEPLOYMENT_MISMATCH_MESSAGE;
    case "scaffold_create_missing_deployment":
      return "This saved Scaffold session is missing its target. Start a new session.";
    case "scaffold_create_projection_mismatch":
      return "This Scaffold session request no longer matches its saved draft. Start a new session.";
    case LEGACY_CREATE_MISSING_AUTHORITY:
      return SCAFFOLD_LEGACY_CREATE_MISSING_AUTHORITY_MESSAGE;
    case "missing_scaffold_create_action":
      return "This Scaffold session request was not saved. Start a new session.";
    case "authentication":
      return "Scaffold authentication is required.";
    case "configuration":
      return "Scaffold is not configured for this environment.";
    case "permission":
      return "Scaffold access is not permitted.";
    case "unsupported":
      return SCAFFOLD_UNSUPPORTED_DRAFT_MESSAGE;
    default:
      return "Scaffold session could not be created.";
  }
}

export function shouldExecuteScaffoldCreate(
  entry: ScaffoldSessionUiEntry | undefined,
): entry is ScaffoldSessionUiEntry {
  return entry?.phase === "creating";
}

export function scaffoldRetargetProvidersAreReady(
  providers: ReadonlyArray<ServerProvider> | null,
): providers is ReadonlyArray<ServerProvider> {
  return providers !== null && resolveScaffoldDraftModelSelection(providers, null) !== null;
}

export function bindScaffoldDraftToRemote(input: {
  readonly draftId: DraftId;
  readonly acceptedTurnSelection?: ModelSelection | null;
  readonly sourceSelection: ModelSelection | null | undefined;
  readonly targetProviders: ReadonlyArray<ServerProvider>;
  readonly projectRef: ScopedProjectRef;
  readonly setModelSelection: (
    draftId: DraftId,
    selection: ModelSelection,
    options: { readonly replaceOptions: true },
  ) => void;
  readonly setDraftThreadContext: (
    draftId: DraftId,
    context: {
      readonly projectRef: ScopedProjectRef;
      readonly envMode: "local";
      readonly worktreePath: null;
    },
  ) => void;
}): boolean {
  const targetSelection = resolveScaffoldDraftModelSelection(
    input.targetProviders,
    input.acceptedTurnSelection ?? input.sourceSelection,
  );
  if (targetSelection === null) return false;

  input.setModelSelection(input.draftId, targetSelection, { replaceOptions: true });
  input.setDraftThreadContext(input.draftId, {
    projectRef: input.projectRef,
    envMode: "local",
    worktreePath: null,
  });
  return true;
}

export function scaffoldCreateConnectionRequest(
  action: ScaffoldLifecycleAction,
  entry: ScaffoldSessionUiEntry,
) {
  if (action.kind !== "create") {
    return { _tag: "blocked", errorCode: "unsupported_lifecycle_action" } as const;
  }
  if (action.deployment === undefined) {
    return { _tag: "blocked", errorCode: "scaffold_create_missing_deployment" } as const;
  }
  if (action.deployment !== entry.deployment) {
    return { _tag: "blocked", errorCode: "scaffold_create_deployment_mismatch" } as const;
  }
  if (!scaffoldSessionUiEntryMatchesPendingCreateAction(entry, action)) {
    return { _tag: "blocked", errorCode: "scaffold_create_projection_mismatch" } as const;
  }
  return {
    _tag: "ready",
    input: {
      deployment: action.deployment,
      operationId: action.actionId,
      sessionId: action.sessionId,
      create: action.create,
      label: `Scaffold ${action.deployment}`,
    },
  } as const;
}

export async function reconcileScaffoldLifecycleStartup(input: {
  readonly store: ScaffoldLifecycleActionStore;
  readonly entriesByDraftId: Readonly<Record<string, ScaffoldSessionUiEntry>>;
  readonly volatileCreateActionsByDraftId?: Readonly<
    Record<string, ScaffoldLifecycleAction | undefined>
  >;
  readonly catalogReady?: boolean;
  readonly registeredScaffoldTargets?: ReadonlyArray<ScaffoldConnectionTarget>;
  readonly recover: (entry: ScaffoldSessionUiEntry) => void;
  readonly rebind?: (entry: ScaffoldSessionUiEntry) => void;
  readonly adoptRegisteredTarget?: (
    entry: ScaffoldSessionUiEntry,
    target: ScaffoldConnectionTarget,
  ) => void;
  readonly fail: (draftId: ScaffoldSessionUiEntry["draftId"], error: string) => void;
}): Promise<void> {
  const actions = await input.store.list();
  const createActions = actions.filter((action) => action.kind === "create");
  const entriesByDraftId = { ...input.entriesByDraftId };
  const volatileCreateActionsByDraftId = input.volatileCreateActionsByDraftId ?? {};
  const catalogReady = input.catalogReady ?? true;
  const registeredScaffoldTargets = input.registeredScaffoldTargets ?? [];
  const matchingRegisteredTarget = (entry: ScaffoldSessionUiEntry) =>
    entry.sessionId === null
      ? undefined
      : registeredScaffoldTargets.find(
          (target) =>
            target.deployment === entry.deployment && target.sessionId === entry.sessionId,
        );

  for (const action of createActions) {
    const matchingEntry = Object.values(entriesByDraftId).find(
      (entry) => entry.actionId === action.actionId,
    );
    if (matchingEntry) {
      if (!scaffoldSessionUiEntryMatchesCreateAction(matchingEntry, action)) {
        input.fail(
          matchingEntry.draftId,
          blockedScaffoldCreateDetail(
            action.lastErrorCode === LEGACY_CREATE_MISSING_AUTHORITY
              ? LEGACY_CREATE_MISSING_AUTHORITY
              : "scaffold_create_projection_mismatch",
          ),
        );
      } else if (matchingEntry.environmentId !== null) {
        // connected() persists the server-owned binding before the outbox
        // action is removed. A reload in that crash window must retire the
        // create by its immutable action identity; Scaffold may have minted a
        // different session id than the provisional request used.
        await input.store.remove(action.actionId);
      } else {
        let currentEntry = matchingEntry;
        if (
          matchingEntry.sessionId !== action.sessionId ||
          matchingEntry.lifecycleEpoch !== action.expectedLifecycleEpoch
        ) {
          const rebound = scaffoldSessionUiEntryFromCreateAction(action);
          if (rebound) {
            (input.rebind ?? input.recover)(rebound);
            currentEntry = rebound;
            entriesByDraftId[rebound.draftId] = rebound;
          }
        }
        const target = matchingRegisteredTarget(currentEntry);
        if (target && input.adoptRegisteredTarget) {
          input.adoptRegisteredTarget(currentEntry, target);
          await input.store.remove(action.actionId);
        }
      }
      continue;
    }

    const recovered = scaffoldSessionUiEntryFromCreateAction(action);
    if (!recovered) continue;
    const draftCollision = entriesByDraftId[recovered.draftId];
    if (draftCollision) {
      input.fail(
        draftCollision.draftId,
        blockedScaffoldCreateDetail("scaffold_create_projection_mismatch"),
      );
      continue;
    }
    input.recover(recovered);
    entriesByDraftId[recovered.draftId] = recovered;
    const target = matchingRegisteredTarget(recovered);
    if (target && input.adoptRegisteredTarget) {
      input.adoptRegisteredTarget(recovered, target);
      await input.store.remove(action.actionId);
    }
  }

  const actionIds = new Set(createActions.map((action) => action.actionId));
  for (const entry of Object.values(entriesByDraftId)) {
    if (entry.phase === "creating" && !actionIds.has(entry.actionId)) {
      const volatileAction = volatileCreateActionsByDraftId[entry.draftId];
      if (
        volatileAction !== undefined &&
        (!scaffoldSessionUiEntryMatchesPendingCreateAction(entry, volatileAction) ||
          entry.lifecycleEpoch !== volatileAction.expectedLifecycleEpoch)
      ) {
        input.fail(
          entry.draftId,
          blockedScaffoldCreateDetail("scaffold_create_projection_mismatch"),
        );
        continue;
      }
      const target = matchingRegisteredTarget(entry);
      if (target && input.adoptRegisteredTarget) {
        input.adoptRegisteredTarget(entry, target);
      } else if (volatileAction === undefined && catalogReady) {
        input.fail(entry.draftId, blockedScaffoldCreateDetail("missing_scaffold_create_action"));
      }
    }
  }
}

export function registeredScaffoldTargets(
  environments: ReadonlyArray<{
    readonly connection: { readonly phase: EnvironmentConnectionPhase };
    readonly entry: { readonly target: ConnectionTarget };
  }>,
): ScaffoldConnectionTarget[] {
  return environments.flatMap((environment) =>
    environment.entry.target._tag === "ScaffoldConnectionTarget" ? [environment.entry.target] : [],
  );
}

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

const LEGACY_SCAFFOLD_PREPARE_FAILURE = "Scaffold session cannot be prepared.";

export function commitLegacyFailedScaffoldObservation(input: {
  readonly entry: ScaffoldSessionUiEntry | undefined;
  readonly observation: {
    readonly sessionId: string;
    readonly lifecycleEpoch: number;
    readonly status: "stopped" | "failed";
  };
  readonly terminal: (
    draftId: DraftId,
    observation: {
      readonly sessionId: string;
      readonly lifecycleEpoch: number;
      readonly status: "stopped" | "failed";
    },
  ) => void;
}): boolean {
  const entry = input.entry;
  if (
    entry === undefined ||
    entry.phase !== "failed" ||
    entry.error !== LEGACY_SCAFFOLD_PREPARE_FAILURE ||
    entry.sessionId !== input.observation.sessionId
  ) {
    return false;
  }
  input.terminal(entry.draftId, input.observation);
  return true;
}

export async function reconcileLegacyFailedScaffoldSessions(input: {
  readonly entriesByDraftId: Readonly<Record<string, ScaffoldSessionUiEntry>>;
  readonly attemptedDraftIds: Set<string>;
  readonly observe: (input: ScaffoldObserveInput) => Promise<ScaffoldSessionObservation>;
  readonly terminal: (
    draftId: DraftId,
    observation: {
      readonly sessionId: string;
      readonly lifecycleEpoch: number;
      readonly status: "stopped" | "failed";
    },
  ) => void;
}): Promise<void> {
  for (const entry of Object.values(input.entriesByDraftId)) {
    if (
      entry.phase !== "failed" ||
      entry.error !== LEGACY_SCAFFOLD_PREPARE_FAILURE ||
      entry.sessionId === null ||
      input.attemptedDraftIds.has(entry.draftId)
    ) {
      continue;
    }
    // Fence before awaiting so a concurrent hydration/render cannot schedule
    // the same draft twice during this coordinator mount.
    input.attemptedDraftIds.add(entry.draftId);
    let observation: ScaffoldSessionObservation;
    try {
      observation = await input.observe(
        new ScaffoldObserveInput({ deployment: entry.deployment, sessionId: entry.sessionId }),
      );
    } catch {
      // Observation is best-effort and read-only. Network/auth/not-found errors
      // leave the saved projection untouched for an explicit user action.
      continue;
    }
    if (observation.status !== "stopped" && observation.status !== "failed") continue;
    input.terminal(entry.draftId, {
      sessionId: observation.sessionId,
      lifecycleEpoch: observation.lifecycleEpoch,
      status: observation.status,
    });
  }
}

function ScaffoldSessionCoordinator() {
  const entriesByDraftId = useScaffoldSessionUiStore((state) => state.entriesByDraftId);
  const projects = useProjects();
  const threadShells = useThreadShells();
  const threadShellsReady = useAllEnvironmentShellsBootstrapped();
  const { environments, isReady: environmentCatalogReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providerCatalogs = useAtomValue(environmentProviderCatalogsAtom);
  const connectScaffold = useAtomCommand(connectScaffoldEnvironment, { reportFailure: false });
  const pauseScaffold = useAtomCommand(serverEnvironment.pauseScaffold, { reportFailure: false });
  const renameScaffold = useAtomCommand(serverEnvironment.renameScaffold, { reportFailure: false });
  const attemptedLegacyDraftIds = useRef(new Set<string>());
  const syncScaffoldSessionTitle = useMemo(
    () =>
      createScaffoldSessionTitleSyncRunner(async (candidate) => {
        if (primaryEnvironmentId === null) {
          throw new Error("The primary environment is not ready for Scaffold session naming.");
        }
        const result = await renameScaffold({
          environmentId: primaryEnvironmentId,
          input: new ScaffoldRenameInput(candidate),
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }),
    [primaryEnvironmentId, renameScaffold],
  );

  useEffect(() => {
    void reconcileLegacyFailedScaffoldSessions({
      entriesByDraftId,
      attemptedDraftIds: attemptedLegacyDraftIds.current,
      observe: requestScaffoldSessionObservation,
      terminal: (draftId, observation) => {
        const scaffoldUi = useScaffoldSessionUiStore.getState();
        commitLegacyFailedScaffoldObservation({
          entry: scaffoldUi.entriesByDraftId[draftId],
          observation,
          terminal: scaffoldUi.terminal,
        });
      },
    });
  }, [entriesByDraftId]);

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const runner = createScaffoldLifecycleDrainRunner({
      run: async (actionId) => {
        if (retryTimer !== undefined) {
          clearTimeout(retryTimer);
          retryTimer = undefined;
        }
        const initialUi = useScaffoldSessionUiStore.getState();
        await reconcileScaffoldLifecycleStartup({
          store: browserScaffoldLifecycleActionStore,
          entriesByDraftId: initialUi.entriesByDraftId,
          volatileCreateActionsByDraftId: initialUi.volatileCreateActionsByDraftId,
          catalogReady: environmentCatalogReady,
          registeredScaffoldTargets: registeredScaffoldTargets(environments),
          recover: (entry) => {
            initialUi.begin({
              draftId: entry.draftId,
              sourceEnvironmentId: entry.sourceEnvironmentId,
              sourceProjectId: entry.sourceProjectId,
              deployment: entry.deployment,
              actionId: entry.actionId,
              sessionId: entry.sessionId,
              createdAt: entry.createdAt,
            });
          },
          fail: initialUi.fail,
          adoptRegisteredTarget: (entry, target) => {
            initialUi.adoptRegisteredTarget(entry.draftId, target);
          },
          rebind: (entry) => {
            if (entry.sessionId === null) return;
            initialUi.rebindCreating(
              entry.draftId,
              entry.actionId,
              entry.sessionId,
              entry.lifecycleEpoch,
            );
          },
        });
        await drainScaffoldLifecycleActions({
          store: browserScaffoldLifecycleActionStore,
          ...(actionId ? { actionId } : {}),
          execute: async (action) => {
            if (action.kind === "pause") {
              const authorization = authorizeScaffoldPause({
                action,
                threadShells,
                shellsReady: threadShellsReady,
              });
              if (authorization === "acknowledge") return { _tag: "acknowledged" };
              if (authorization === "wait") {
                return {
                  _tag: "wait",
                  retryAfterMs: 1_000,
                  errorCode: "scaffold_thread_state_unavailable",
                };
              }
              const scaffoldEnvironment = environments.find(
                (environment) => environment.environmentId === action.environmentId,
              );
              if (
                primaryEnvironmentId === null ||
                scaffoldEnvironment?.entry.target._tag !== "ScaffoldConnectionTarget" ||
                scaffoldEnvironment.entry.target.sessionId !== action.sessionId
              ) {
                return {
                  _tag: "wait",
                  retryAfterMs: 1_000,
                  errorCode: "scaffold_pause_target_unavailable",
                };
              }
              const result = await pauseScaffold({
                environmentId: primaryEnvironmentId,
                input: scaffoldPauseInputFromAction({
                  action,
                  deployment: scaffoldEnvironment.entry.target.deployment,
                }),
              });
              if (result._tag === "Failure") {
                return reconcileScaffoldPauseAction({
                  action,
                  error: squashAtomCommandFailure(result),
                });
              }
              const executionResult = reconcileScaffoldPauseAction({
                action,
                observation: result.value,
              });
              if (executionResult._tag === "acknowledged") {
                const scaffoldUi = useScaffoldSessionUiStore.getState();
                const entry = scaffoldSessionForEnvironment(
                  scaffoldUi.entriesByDraftId,
                  action.environmentId,
                );
                if (entry) scaffoldUi.connected(entry.draftId, result.value);
              }
              return executionResult;
            }
            if (action.kind !== "create") {
              return { _tag: "blocked", errorCode: "unsupported_lifecycle_action" };
            }
            const scaffoldUi = useScaffoldSessionUiStore.getState();
            const entry = Object.values(scaffoldUi.entriesByDraftId).find(
              (candidate) => candidate.actionId === action.actionId,
            );
            if (!entry) return { _tag: "blocked", errorCode: "missing_scaffold_draft" };
            if (!shouldExecuteScaffoldCreate(entry)) {
              return { _tag: "blocked", errorCode: "scaffold_create_requires_explicit_retry" };
            }
            const request = scaffoldCreateConnectionRequest(action, entry);
            if (request._tag === "blocked") return request;
            const result = await connectScaffold(request.input);
            if (result._tag === "Failure") {
              const error = squashAtomCommandFailure(result);
              const failure = classifyScaffoldCreateFailure(error);
              if (failure.terminalObservation) {
                scaffoldUi.terminal(entry.draftId, failure.terminalObservation);
              } else if (failure.result._tag === "blocked" && failure.detail) {
                scaffoldUi.fail(entry.draftId, failure.detail);
              }
              return failure.result;
            }
            scaffoldUi.registered(entry.draftId, result.value.binding);
            if (result.value.binding.deployment !== request.input.deployment) {
              return { _tag: "blocked", errorCode: "scaffold_binding_deployment_mismatch" };
            }
            return { _tag: "acknowledged" };
          },
          onWait: (action) => {
            if (action.kind !== "create" || action.draftId === undefined) return;
            useScaffoldSessionUiStore
              .getState()
              .rebindCreating(
                DraftId.make(action.draftId),
                action.actionId,
                action.sessionId,
                action.expectedLifecycleEpoch,
              );
          },
          onBlocked: (action) => {
            const scaffoldUi = useScaffoldSessionUiStore.getState();
            const entry = Object.values(scaffoldUi.entriesByDraftId).find(
              (candidate) => candidate.actionId === action.actionId,
            );
            if (entry?.phase === "creating") {
              scaffoldUi.fail(entry.draftId, blockedScaffoldCreateDetail(action.lastErrorCode));
            }
          },
        });
      },
      onIdle: async () => {
        try {
          const retryDelayMs = await resolveScaffoldLifecycleRetryDelay({
            store: browserScaffoldLifecycleActionStore,
            isDisposed: () => disposed,
          });
          if (retryDelayMs !== null) {
            retryTimer = setTimeout(() => void runner.drain(), retryDelayMs);
          }
        } catch (error) {
          console.error("Could not schedule the Scaffold lifecycle retry.", error);
        }
      },
      onError: (error) => {
        console.error("Could not drain the Scaffold lifecycle outbox.", error);
      },
    });

    const unsubscribe = subscribeScaffoldLifecycleDrain((actionId) => {
      void runner.drain(actionId);
    });
    void runner.drain();
    return () => {
      disposed = true;
      runner.dispose();
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [
    connectScaffold,
    environmentCatalogReady,
    environments,
    pauseScaffold,
    primaryEnvironmentId,
    threadShells,
    threadShellsReady,
  ]);

  useEffect(() => {
    // Zustand persistence hydrates after the coordinator's first mount. Wake
    // the durable outbox once after hydration so a Scaffold create that
    // survived a reload is not left permanently in "creating". Entry updates
    // are outputs of the drain and must not recursively wake another pass.
    let disposed = false;
    let woke = false;
    const wakeAfterHydration = () => {
      if (disposed || woke) return;
      woke = true;
      requestScaffoldLifecycleDrain();
    };
    const unsubscribe = useScaffoldSessionUiStore.persist.onFinishHydration(wakeAfterHydration);
    if (useScaffoldSessionUiStore.persist.hasHydrated()) wakeAfterHydration();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const scaffoldUi = useScaffoldSessionUiStore.getState();
    for (const environment of environments) {
      const target = environment.entry.target;
      if (target._tag !== "ScaffoldConnectionTarget") continue;
      for (const entry of Object.values(scaffoldUi.entriesByDraftId)) {
        if (
          entry.deployment !== target.deployment ||
          entry.sessionId !== target.sessionId ||
          (entry.environmentId !== null && entry.environmentId !== target.environmentId)
        ) {
          continue;
        }
        scaffoldUi.syncRegisteredTarget(entry.draftId, target, environment.connection);
      }
    }
  }, [entriesByDraftId, environments]);

  useEffect(() => {
    const availability = scaffoldSessionTitleSyncTargetAvailability({
      primaryEnvironmentId,
      environments,
    });
    syncScaffoldSessionTitle.reconcileAvailability(availability);
    const candidates = selectScaffoldSessionTitleSyncCandidates({
      targets: availability.filter((entry) => entry.usable).map((entry) => entry.target),
      projects,
      threads: threadShells,
    });
    for (const candidate of candidates) {
      void syncScaffoldSessionTitle.run(candidate).catch((error: unknown) => {
        console.error("Could not synchronize the Scaffold session title.", error);
      });
    }
  }, [environments, primaryEnvironmentId, projects, syncScaffoldSessionTitle, threadShells]);

  useEffect(() => {
    let disposed = false;
    const draftStore = useComposerDraftStore.getState();
    for (const entry of Object.values(entriesByDraftId)) {
      if (entry.environmentId === null || entry.phase === "creating" || entry.phase === "failed") {
        continue;
      }
      const draft = draftStore.getDraftSession(entry.draftId);
      if (!draft) continue;
      const currentProjectExists = projects.some(
        (project) =>
          draft.environmentId === entry.environmentId &&
          project.environmentId === entry.environmentId &&
          project.id === draft.projectId,
      );
      if (currentProjectExists) continue;
      const remoteProject = projects.find(
        (project) => project.environmentId === entry.environmentId,
      );
      if (!remoteProject) continue;
      const targetProviders = providerCatalogs.get(entry.environmentId) ?? null;
      if (!scaffoldRetargetProvidersAreReady(targetProviders)) continue;
      void retargetPendingTurnsForDraft(
        browserPendingTurnOutbox,
        entry.draftId,
        remoteProject.environmentId,
        remoteProject.id,
        targetProviders,
      )
        .then((acceptedTurnSelection) => {
          if (disposed) return;
          const composerDraft = draftStore.getComposerDraft(entry.draftId);
          const sourceSelection = composerDraft?.activeProvider
            ? composerDraft.modelSelectionByProvider[composerDraft.activeProvider]
            : null;
          const bound = bindScaffoldDraftToRemote({
            draftId: entry.draftId,
            acceptedTurnSelection,
            sourceSelection,
            targetProviders,
            projectRef: scopeProjectRef(remoteProject.environmentId, remoteProject.id),
            setModelSelection: draftStore.setModelSelection,
            setDraftThreadContext: draftStore.setDraftThreadContext,
          });
          if (!bound) return;
          // A Scaffold server owns the same stable thread id in a fresh
          // environment. Record that cross-environment promotion explicitly
          // so the draft route can converge as soon as the remote shell
          // materializes instead of depending on a reload-time inference.
          draftStore.markDraftThreadPromoting(
            entry.draftId,
            scopeThreadRef(remoteProject.environmentId, draft.threadId),
          );
        })
        .catch((error: unknown) => {
          console.error("Could not route the pending turn to its Scaffold project.", error);
        });
    }
    return () => {
      disposed = true;
    };
  }, [entriesByDraftId, projects, providerCatalogs]);

  return null;
}

/** Drains accepted chat commands independently of whichever thread is visible. */
function PendingTurnCoordinator() {
  const { environments } = useEnvironments();
  const liveEnvironmentIds = useAtomValue(liveEnvironmentIdsAtom);
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const liveEnvironmentIdSet = useMemo(() => new Set(liveEnvironmentIds), [liveEnvironmentIds]);
  const connectedEnvironmentIds = useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            environment.connection.phase === "connected" &&
            liveEnvironmentIdSet.has(environment.environmentId),
        )
        .map((environment) => environment.environmentId),
    [environments, liveEnvironmentIdSet],
  );
  const coordinator = useMemo(
    () =>
      createPendingTurnCoordinatorAdapter({
        readEnvironmentShellStatus: (environmentId) =>
          appAtomRegistry.get(environmentShell.stateValueAtom(environmentId)).status,
        threadExists: (threadRef) => readThreadShell(threadRef) !== null,
        dispatch: async ({ environmentId, turn }) => {
          const result = await startThreadTurn({ environmentId, input: turn });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        },
      }),
    [startThreadTurn],
  );

  useEffect(() => {
    let disposed = false;
    let running: Promise<void> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const drain = () => {
      if (disposed || running !== null) return;
      running = (async () => {
        for (const environmentId of connectedEnvironmentIds) {
          const results = await drainPendingTurnOutbox({
            storage: browserPendingTurnOutbox,
            environmentId,
            dispatch: async (entry) => {
              if (!(await coordinator.dispatch(entry))) {
                throw new Error("Environment shell is not synchronized yet.");
              }
            },
          });
          for (const result of results) {
            if (
              result.outcome !== "terminal" ||
              notifiedTerminalPendingTurns.has(result.entry.idempotencyKey)
            ) {
              continue;
            }
            notifiedTerminalPendingTurns.add(result.entry.idempotencyKey);
            const toastId = toastManager.add({
              type: "error",
              title: "Message could not be sent",
              description: result.error ?? "The server rejected this message.",
              timeout: 0,
              actionProps: {
                children: "Discard",
                onClick: () => {
                  void discardPendingTurn(
                    browserPendingTurnOutbox,
                    result.entry.idempotencyKey,
                  ).then(() => {
                    notifiedTerminalPendingTurns.delete(result.entry.idempotencyKey);
                    toastManager.close(toastId);
                  });
                },
              },
            });
          }
        }
      })()
        .catch((error: unknown) => {
          console.error("Could not drain the pending-turn outbox.", error);
        })
        .finally(async () => {
          running = null;
          if (disposed) return;
          const entries = await browserPendingTurnOutbox.list();
          const retryable = entries.filter(
            (entry, entryIndex) =>
              entry.status !== "terminal" &&
              connectedEnvironmentIds.includes(entry.environmentId) &&
              !entries
                .slice(0, entryIndex)
                .some(
                  (candidate) =>
                    candidate.status === "terminal" &&
                    candidate.environmentId === entry.environmentId &&
                    candidate.threadId === entry.threadId,
                ),
          );
          if (retryable.length > 0) {
            const attemptCount = Math.min(...retryable.map((entry) => entry.attemptCount));
            retryTimer = setTimeout(drain, Math.min(30_000, 1_000 * 2 ** attemptCount));
          }
        });
    };

    const unsubscribe = subscribePendingTurnDrain(drain);
    drain();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [connectedEnvironmentIds, coordinator]);

  return null;
}

function readInitialThreadSidebarWidth(): number {
  try {
    return resolveInitialThreadSidebarWidth(
      getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite),
      window.innerWidth,
    );
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return resolveInitialThreadSidebarWidth(null, window.innerWidth);
  }
}

function SidebarControl() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar } = useSidebar();
  const isSidebarVisible = useSidebarVisibility();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (resolveShortcutCommand(event, keybindings) !== "sidebar.toggle") return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    // Capture before focused editors consume commands such as Mod+B for rich-text formatting.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, toggleSidebar]);

  return (
    <div
      className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 flex h-[var(--workspace-topbar-height)] items-center"
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              className={cn(
                "pointer-events-auto",
                isSidebarVisible &&
                  stageBackdropVariant &&
                  "[:hover,[data-pressed]]:bg-white/15 focus-visible:ring-white/90 focus-visible:ring-offset-blue-700 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white!",
              )}
              aria-label="Toggle main sidebar"
            />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  // Settings routes render the settings nav, which lives in the v1 component
  // and is identical for both sidebars — so v1 stays mounted there. All
  // workspace routes use v2 regardless of the legacy persisted beta setting.
  const pathname = useLocation({ select: (location) => location.pathname });
  const isOnSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const useSidebarV2 = !isOnSettings;
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  // Subscribed rather than read once: the clamp must track live window size,
  // and a clamped drag ends with an unchanged width, which skips the re-render
  // that would otherwise refresh a render-time snapshot.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(viewportWidth);
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(() => {
    const getWindowFullscreenState = window.desktopBridge?.getWindowFullscreenState;
    return isMacosDesktop && typeof getWindowFullscreenState === "function"
      ? getWindowFullscreenState()
      : false;
  });
  const sidebarProviderStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    ...(isMacosDesktop && !isWindowFullscreen
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}),
  } as CSSProperties;

  useEffect(() => {
    if (!isMacosDesktop) return;
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const { getWindowFullscreenState, onWindowFullscreenStateChange } = bridge;
    if (
      typeof getWindowFullscreenState !== "function" ||
      typeof onWindowFullscreenStateChange !== "function"
    ) {
      return;
    }

    const unsubscribe = onWindowFullscreenStateChange(setIsWindowFullscreen);
    setIsWindowFullscreen(getWindowFullscreenState());
    return unsubscribe;
  }, [isMacosDesktop]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname);
        if (!isSettingsRoute) {
          void navigate({ to: "/settings" });
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, pathname]);

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen style={sidebarProviderStyle}>
      <ThreadAttentionNotifications />
      <ScaffoldSessionCoordinator />
      <PendingTurnCoordinator />
      <Sidebar
        side="left"
        collapsible="offcanvas"
        data-app-sidebar=""
        data-sidebar-version="v2"
        className="border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
        resizable={{
          maxWidth: sidebarMaximumWidth,
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
            nextWidth <= currentWidth ||
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
          onResize: setSidebarWidth,
        }}
      >
        {useSidebarV2 ? <ThreadSidebarV2 /> : <ThreadSidebar />}
        <SidebarRail />
      </Sidebar>
      {children}
      <SidebarControl />
    </SidebarProvider>
  );
}
