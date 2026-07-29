"use client";

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { scaffoldCreateParametersForModelSelection } from "@t3tools/client-runtime/scaffold";
import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type DesktopWslState,
  type EnvironmentId,
  type FilesystemBrowseResult,
  type OmpAccountOverview,
  type OmpLoginChallenge,
  type ProjectId,
  type ScaffoldDeployment,
  type ScaffoldDeploymentCapabilities,
  type SourceControlDiscoveryResult,
  type SourceControlProviderKind,
  type SourceControlRepositoryInfo,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Option from "effect/Option";
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  CloudIcon,
  Clock3Icon,
  CornerLeftUpIcon,
  FileSearchIcon,
  FolderIcon,
  FolderPlusIcon,
  LinkIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  SettingsIcon,
  SquarePenIcon,
  TextSearchIcon,
  TriangleAlertIcon,
  UserRoundIcon,
  UserRoundPlusIcon,
  UserRoundXIcon,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useAtomValue } from "@effect/atom-react";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { requestScaffoldDeploymentCapabilities } from "../connection/scaffold";
import {
  browserOmpAccountOverviewCache,
  cacheOmpAccountOverview,
  mergeRefreshedOmpAccountOverview,
} from "../connection/ompAccountOverviewCache";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import {
  createLatestSingleFlightCoordinator,
  type LatestSingleFlightContext,
  resolveScaffoldDraftModelSelection,
  useHandleNewThread,
} from "../hooks/useHandleNewThread";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useScaffoldSessionUiStore } from "../scaffoldSessionUiStore";
import {
  browserScaffoldLifecycleActionStore,
  enqueueScaffoldLifecycleAction,
  makeScaffoldCreateAction,
  requestScaffoldLifecycleDrain,
} from "../connection/scaffoldLifecycleOutbox";
import { useClientSettings } from "../hooks/useSettings";
import { readLocalApi } from "../localApi";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { filesystemEnvironment } from "../state/filesystem";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { useThreadSearch } from "../state/queries";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../lib/chatThreadActions";
import type { Project } from "../types";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  getBrowseDirectoryPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "../lib/projectPaths";
import { onOpenCommandPalette } from "../commandPaletteBus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { getLatestThreadForProject, sortThreads } from "../lib/threadSort";
import { cn, isMacPlatform, isWindowsPlatform, newProjectId } from "../lib/utils";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import {
  applyWslEnvironmentConfiguration,
  parseWslUncPath,
  resolveProjectPickerTarget,
  resolveWslProjectSelection,
} from "../wslPaths";
import {
  ADDON_ICON_CLASS,
  buildAshlerRootGroups,
  buildBrowseGroups,
  buildProjectActionItems,
  buildRootGroups,
  enumerateCommandPaletteItems,
  type CommandPaletteActionItem,
  type CommandPaletteOpenIntent,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterCommandPaletteGroups,
  getScaffoldNewSessionActionPresentation,
  loadScaffoldDeploymentCapabilities,
  refreshNewSessionPaletteView,
  runScaffoldDraftLaunch,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteMode,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
  reduceCommandPaletteUiState,
  type SearchOverlayMode,
  shouldRefreshOmpOverviewOnOpen,
} from "./CommandPalette.logic";
import { orderItemsByPreferredIds, sortLogicalProjectsForSidebar } from "./Sidebar.logic";
import { resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import {
  buildOmpOverviewStatusPresentation,
  buildOmpAccountRowPresentation,
  buildOmpUsageDisplayRows,
  completeOmpLoginFlow,
  describeOmpLoginTerminalFailure,
  describeOmpLoginFailure,
  getOmpLoginActionPresentation,
  InvalidOmpAuthorizationUrlError,
  normalizeOmpAuthorizationUrl,
  observeOmpLoginBrowserWindowClose,
  ompLoginChallengeExpiryDelay,
  preserveOmpOverviewAfterRefreshFailure,
  prepareOmpLoginBrowserWindow,
  providerDisplayName,
  reconcileOmpLoginSubmitSupport,
  reserveOmpLoginFlow,
  throwOmpLoginCancelFailure,
  type ActiveOmpLoginFlow,
} from "./OmpAccountPalette.logic";
import { OmpLoginChallengePanel } from "./OmpLoginChallengePanel";
import { AzureDevOpsIcon, BitbucketIcon, GitHubIcon, GitLabIcon } from "./Icons";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProjectFilePicker } from "./files/ProjectFilePicker";
import { ProjectContentSearchDialog } from "./search/ProjectContentSearchDialog";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "./ThreadStatusIndicators";
import {
  primaryServerKeybindingsAtom,
  primaryServerProvidersAtom,
  serverEnvironment,
} from "../state/server";
import { resolveDefaultProviderModelSelection } from "../providerInstances";
import { resolveShortcutCommand, threadJumpIndexFromCommand } from "../keybindings";
import { CommandDialog, CommandDialogPopup } from "./ui/command";
import { Button } from "./ui/button";
import { Kbd, KbdGroup } from "./ui/kbd";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../logicalProject";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import {
  buildLocalSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "../sidebarProjectGrouping";
import {
  canCopySessionToScaffold,
  COPY_SESSION_SCAFFOLD_DEPLOYMENTS,
  isSessionTransferLocalConnectionTarget,
  runSessionTransferCommand,
  sessionTransferCommandTitle,
  sessionTransferKindForThread,
  type StartSessionCopy,
} from "../sessionTransferUi";
import type { ScaffoldLifecycleAction } from "@t3tools/client-runtime/scaffold";

const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];

interface ScaffoldLaunchRequest {
  readonly deployment: ScaffoldDeployment;
  readonly execute: (context: LatestSingleFlightContext<ScaffoldLaunchRequest>) => Promise<void>;
}

const runScaffoldLaunchFlight = createLatestSingleFlightCoordinator<ScaffoldLaunchRequest>(
  (initial, context) => initial.execute(context),
);

function renderProjectFavicon(project: Project): ReactNode {
  return (
    <ProjectFavicon
      environmentId={project.environmentId}
      cwd={project.workspaceRoot}
      className={ITEM_ICON_CLASS}
    />
  );
}

function getLocalFileManagerName(platform: string): string {
  if (isMacPlatform(platform)) {
    return "Finder";
  }
  if (isWindowsPlatform(platform)) {
    return "Explorer";
  }
  return "Files";
}

function getEnvironmentBrowsePlatform(os: string | null | undefined): string {
  if (os === "windows") {
    return "Win32";
  }
  if (os === "darwin") {
    return "MacIntel";
  }
  if (os === "linux") {
    return "Linux";
  }
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

interface AddProjectEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly isConnected: boolean;
  readonly status: string;
}

type AddProjectRemoteProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "bitbucket" | "azure-devops"
>;
type AddProjectRemoteSource = AddProjectRemoteProviderKind | "url";

type AddProjectCloneFlow =
  | {
      readonly step: "repository";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
    }
  | {
      readonly step: "confirm";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
      readonly repositoryInput: string;
      readonly repository: SourceControlRepositoryInfo | null;
      readonly remoteUrl: string;
    };

const REMOTE_PROJECT_SOURCES: ReadonlyArray<AddProjectRemoteSource> = [
  "url",
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
];
const REMOTE_PROJECT_PROVIDER_SOURCES: ReadonlyArray<AddProjectRemoteProviderKind> = [
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
];

function remoteProjectSourceLabel(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "bitbucket":
      return "Bitbucket";
    case "azure-devops":
      return "Azure DevOps";
    case "url":
      return "Git URL";
  }
}

function remoteProjectSourcePathHint(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "owner/repo";
    case "gitlab":
      return "group/project";
    case "bitbucket":
      return "workspace/repository";
    case "azure-devops":
      return "project/repository";
    case "url":
      return "URL";
  }
}

function remoteProjectSourceProvider(
  source: AddProjectRemoteSource,
): AddProjectRemoteProviderKind | null {
  return source === "url" ? null : source;
}

function remoteProjectSourceIcon(source: AddProjectRemoteSource, className: string): ReactNode {
  switch (source) {
    case "github":
      return <GitHubIcon className={className} />;
    case "gitlab":
      return <GitLabIcon className={className} />;
    case "bitbucket":
      return <BitbucketIcon className={className} />;
    case "azure-devops":
      return <AzureDevOpsIcon className={className} />;
    case "url":
      return <LinkIcon className={className} />;
  }
}

function remoteProjectInputPlaceholder(flow: AddProjectCloneFlow | null): string | null {
  if (!flow) return null;
  if (flow.step === "confirm") return null;
  if (flow.source === "url") {
    return "Enter Git clone URL";
  }
  return `Enter ${remoteProjectSourceLabel(flow.source)} repository (${remoteProjectSourcePathHint(flow.source)})`;
}

function sourceProviderKind(source: AddProjectRemoteSource): AddProjectRemoteProviderKind | null {
  return source === "url" ? null : source;
}

function sortAddProjectProviderSources(
  readinessBySource: AddProjectRemoteSourceReadiness,
): ReadonlyArray<AddProjectRemoteProviderKind> {
  return REMOTE_PROJECT_PROVIDER_SOURCES.toSorted((left, right) => {
    const leftReady = readinessBySource[left].ready;
    const rightReady = readinessBySource[right].ready;
    if (leftReady !== rightReady) {
      return leftReady ? -1 : 1;
    }
    return remoteProjectSourceLabel(left).localeCompare(remoteProjectSourceLabel(right));
  });
}

type AddProjectRemoteSourceReadiness = Record<
  AddProjectRemoteSource,
  { readonly ready: boolean; readonly hint: string | null }
>;

function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness {
  const unavailable = {
    ready: false,
    hint: "Provider status unavailable. Open Settings -> Source Control and rescan.",
  } as const;
  const defaultReadiness: AddProjectRemoteSourceReadiness = {
    url: { ready: true, hint: null },
    github: unavailable,
    gitlab: unavailable,
    bitbucket: unavailable,
    "azure-devops": unavailable,
  };

  if (!discovery) {
    return defaultReadiness;
  }

  const providerByKind = new Map(
    discovery.sourceControlProviders.map((provider) => [provider.kind, provider]),
  );
  const readiness = { ...defaultReadiness };

  for (const source of REMOTE_PROJECT_SOURCES) {
    const kind = sourceProviderKind(source);
    if (!kind) continue;
    const provider = providerByKind.get(kind);
    if (!provider) {
      readiness[source] = unavailable;
      continue;
    }
    if (provider.status !== "available") {
      readiness[source] = { ready: false, hint: provider.installHint };
      continue;
    }
    if (provider.auth.status === "unauthenticated") {
      readiness[source] = {
        ready: false,
        hint:
          Option.getOrNull(provider.auth.detail) ??
          `${provider.label} is not authenticated. Open Settings -> Source Control for setup guidance.`,
      };
      continue;
    }
    readiness[source] = { ready: true, hint: null };
  }

  return readiness;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "An error occurred.";
}

const OVERLAY_MODE_BY_COMMAND = {
  "commandPalette.toggle": "command",
  "filePicker.toggle": "files",
  "projectSearch.toggle": "content",
} as const satisfies Partial<Record<string, SearchOverlayMode>>;

function overlayModeForCommand(command: string | null): SearchOverlayMode | null {
  if (command === null) return null;
  return command in OVERLAY_MODE_BY_COMMAND
    ? OVERLAY_MODE_BY_COMMAND[command as keyof typeof OVERLAY_MODE_BY_COMMAND]
    : null;
}

interface OmpLoginAuthorization {
  readonly cancel: () => Promise<void>;
  readonly flowId: string;
  readonly provider: "openai" | "anthropic";
  readonly url: string;
}

export function CommandPalette({
  children,
  startSessionCopy,
}: {
  children: ReactNode;
  startSessionCopy?: StartSessionCopy;
}) {
  const [state, dispatch] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    mode: "command",
    openIntent: null,
  });
  const setOpen = useCallback((open: boolean) => dispatch({ _tag: "SetOpen", open }), []);
  const toggleMode = useCallback(
    (mode: SearchOverlayMode) => dispatch({ _tag: "ToggleMode", mode }),
    [],
  );
  const openAddProject = useCallback(() => dispatch({ _tag: "OpenAddProject" }), []);
  const openNewSession = useCallback(() => dispatch({ _tag: "OpenNewSession" }), []);
  const openNewThreadIn = useCallback(() => dispatch({ _tag: "OpenNewThreadIn" }), []);
  const clearOpenIntent = useCallback(() => dispatch({ _tag: "ClearOpenIntent" }), []);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { environments: ompLoginEnvironments } = useEnvironments();
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const [pendingOmpLoginInput, setPendingOmpLoginInput] = useState<{
    readonly challenge: OmpLoginChallenge;
    readonly resolve: (response: string | null) => void;
    timeoutId?: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [ompLoginAuthorization, setOmpLoginAuthorization] = useState<OmpLoginAuthorization | null>(
    null,
  );
  const [isOmpLoginActive, setIsOmpLoginActive] = useState(false);
  const activeOmpLoginFlowRef = useRef<ActiveOmpLoginFlow | null>(null);
  const ompLoginSubmitSupportRef = useRef(new Map<string, boolean>());
  const ompLoginSubmitSupportScopeRef = useRef(new Map<string, string>());
  const pendingOmpLoginInputRef = useRef(pendingOmpLoginInput);
  pendingOmpLoginInputRef.current = pendingOmpLoginInput;
  const requestOmpLoginInput = useCallback(
    (challenge: OmpLoginChallenge) =>
      new Promise<string | null>((resolve) => {
        const previous = pendingOmpLoginInputRef.current;
        if (previous?.timeoutId !== undefined) clearTimeout(previous.timeoutId);
        previous?.resolve(null);
        const pending: {
          readonly challenge: OmpLoginChallenge;
          readonly resolve: (response: string | null) => void;
          timeoutId?: ReturnType<typeof setTimeout>;
        } = { challenge, resolve };
        pendingOmpLoginInputRef.current = pending;
        setPendingOmpLoginInput(pending);
        const expiryDelay = ompLoginChallengeExpiryDelay(challenge);
        if (expiryDelay !== null) {
          pending.timeoutId = setTimeout(() => {
            if (pendingOmpLoginInputRef.current !== pending) return;
            pendingOmpLoginInputRef.current = null;
            setPendingOmpLoginInput(null);
            pending.resolve(null);
          }, expiryDelay);
        }
      }),
    [],
  );
  const settleOmpLoginInput = useCallback((flowId: string, response: string | null) => {
    const pending = pendingOmpLoginInputRef.current;
    if (pending === null || pending.challenge.flowId !== flowId) return;
    if (pending.timeoutId !== undefined) clearTimeout(pending.timeoutId);
    pendingOmpLoginInputRef.current = null;
    setPendingOmpLoginInput(null);
    pending.resolve(response);
  }, []);
  const acquireOmpLoginFlow = useCallback(
    (environmentId: string, provider: "openai" | "anthropic") => {
      const reservation = reserveOmpLoginFlow(activeOmpLoginFlowRef.current, {
        environmentId,
        provider,
      });
      if (!reservation.acquired) return null;
      activeOmpLoginFlowRef.current = reservation.active;
      setIsOmpLoginActive(true);
      return reservation.active;
    },
    [],
  );
  const releaseOmpLoginFlow = useCallback((flow: ActiveOmpLoginFlow) => {
    if (activeOmpLoginFlowRef.current !== flow) return;
    activeOmpLoginFlowRef.current = null;
    setIsOmpLoginActive(false);
  }, []);

  useEffect(() => {
    const reconciled = reconcileOmpLoginSubmitSupport(
      ompLoginSubmitSupportRef.current,
      ompLoginSubmitSupportScopeRef.current,
      ompLoginEnvironments.map((environment) => ({
        environmentId: environment.environmentId,
        scope: `${environment.connection.phase}:${JSON.stringify(environment.entry.target)}`,
      })),
    );
    ompLoginSubmitSupportRef.current = new Map(reconciled.supportByEnvironment);
    ompLoginSubmitSupportScopeRef.current = new Map(reconciled.scopeByEnvironment);
  }, [ompLoginEnvironments]);

  useEffect(
    () => () => {
      const pending = pendingOmpLoginInputRef.current;
      if (pending?.timeoutId !== undefined) clearTimeout(pending.timeoutId);
      pending?.resolve(null);
      pendingOmpLoginInputRef.current = null;
    },
    [],
  );
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );

  useEffect(() => {
    if (!state.open || state.mode === "command") return;
    const onEscapeKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      toggleMode("command");
    };
    window.addEventListener("keydown", onEscapeKeyDown, true);
    return () => window.removeEventListener("keydown", onEscapeKeyDown, true);
  }, [state.mode, state.open, toggleMode]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Resolve with the complete shortcut context so customized bindings
      // using any documented `when` condition (e.g. previewFocus) work.
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
        },
      });
      const mode = overlayModeForCommand(command);
      if (mode === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleMode(mode);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, previewOpen, terminalOpen, toggleMode]);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (detail.open === "new-session") {
          openNewSession();
        } else if (detail.open === "new-thread-in") {
          openNewThreadIn();
        } else if (detail.open === "add-project") {
          openAddProject();
        } else {
          setOpen(true);
        }
      }),
    [openAddProject, openNewSession, openNewThreadIn, setOpen],
  );

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            toggleMode("command");
            return;
          }
          setOpen(open);
        }}
      >
        {children}
        <CommandPaletteDialog
          open={state.open}
          mode={state.mode}
          openIntent={state.openIntent}
          setOpen={setOpen}
          openOverlayMode={toggleMode}
          clearOpenIntent={clearOpenIntent}
          acquireOmpLoginFlow={acquireOmpLoginFlow}
          dismissOmpLoginInput={(flowId) => settleOmpLoginInput(flowId, null)}
          getOmpLoginSubmitSupport={(environmentId) =>
            ompLoginSubmitSupportRef.current.get(environmentId)
          }
          isOmpLoginActive={isOmpLoginActive}
          releaseOmpLoginFlow={releaseOmpLoginFlow}
          requestOmpLoginInput={requestOmpLoginInput}
          setOmpLoginSubmitSupport={(environmentId, supported) => {
            ompLoginSubmitSupportRef.current.set(environmentId, supported);
          }}
          setOmpLoginAuthorization={setOmpLoginAuthorization}
          startSessionCopy={startSessionCopy}
        />
      </CommandDialog>
      <OmpLoginChallengePanel
        key={pendingOmpLoginInput?.challenge.flowId ?? "no-omp-login-challenge"}
        challenge={pendingOmpLoginInput?.challenge ?? null}
        authorizationFlowId={ompLoginAuthorization?.flowId ?? null}
        authorizationProvider={ompLoginAuthorization?.provider ?? null}
        authorizationUrl={ompLoginAuthorization?.url ?? null}
        onSubmit={(response) => {
          if (pendingOmpLoginInput !== null) {
            settleOmpLoginInput(pendingOmpLoginInput.challenge.flowId, response);
          }
        }}
        onCancel={(flowId) => {
          if (pendingOmpLoginInput?.challenge.flowId === flowId) {
            settleOmpLoginInput(flowId, null);
            return;
          }
          if (ompLoginAuthorization?.flowId !== flowId) return;
          setOmpLoginAuthorization((current) => (current?.flowId === flowId ? null : current));
          void ompLoginAuthorization.cancel().catch(() => undefined);
        }}
      />
    </ComposerHandleContext>
  );
}

function CommandPaletteDialog(props: {
  readonly open: boolean;
  readonly mode: SearchOverlayMode;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openOverlayMode: (mode: SearchOverlayMode) => void;
  readonly clearOpenIntent: () => void;
  readonly acquireOmpLoginFlow: (
    environmentId: string,
    provider: "openai" | "anthropic",
  ) => ActiveOmpLoginFlow | null;
  readonly dismissOmpLoginInput: (flowId: string) => void;
  readonly getOmpLoginSubmitSupport: (environmentId: string) => boolean | undefined;
  readonly isOmpLoginActive: boolean;
  readonly releaseOmpLoginFlow: (flow: ActiveOmpLoginFlow) => void;
  readonly requestOmpLoginInput: (challenge: OmpLoginChallenge) => Promise<string | null>;
  readonly setOmpLoginSubmitSupport: (environmentId: string, supported: boolean) => void;
  readonly setOmpLoginAuthorization: Dispatch<SetStateAction<OmpLoginAuthorization | null>>;
  readonly startSessionCopy: StartSessionCopy | undefined;
}) {
  const composerHandleRef = useComposerHandleContext();

  if (!props.open) {
    return null;
  }

  return (
    <CommandDialogPopup
      aria-label={
        props.mode === "files"
          ? "File picker"
          : props.mode === "content"
            ? "Search project contents"
            : "Command palette"
      }
      className={cn("overflow-hidden p-0", props.mode === "content" && "h-105")}
      data-command-palette="true"
      data-palette-mode={props.mode}
      data-testid="command-palette"
      finalFocus={() => {
        composerHandleRef?.current?.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        props.setOpen(false);
      }}
    >
      {props.mode === "files" ? (
        <ProjectFilePicker setOpen={props.setOpen} />
      ) : props.mode === "content" ? (
        <ProjectContentSearchDialog onOpenChange={props.setOpen} />
      ) : (
        <OpenCommandPaletteDialog
          openIntent={props.openIntent}
          setOpen={props.setOpen}
          openOverlayMode={props.openOverlayMode}
          clearOpenIntent={props.clearOpenIntent}
          acquireOmpLoginFlow={props.acquireOmpLoginFlow}
          dismissOmpLoginInput={props.dismissOmpLoginInput}
          getOmpLoginSubmitSupport={props.getOmpLoginSubmitSupport}
          isOmpLoginActive={props.isOmpLoginActive}
          releaseOmpLoginFlow={props.releaseOmpLoginFlow}
          requestOmpLoginInput={props.requestOmpLoginInput}
          setOmpLoginSubmitSupport={props.setOmpLoginSubmitSupport}
          setOmpLoginAuthorization={props.setOmpLoginAuthorization}
          startSessionCopy={props.startSessionCopy}
        />
      )}
    </CommandDialogPopup>
  );
}

function OpenCommandPaletteDialog(props: {
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openOverlayMode: (mode: SearchOverlayMode) => void;
  readonly clearOpenIntent: () => void;
  readonly acquireOmpLoginFlow: (
    environmentId: string,
    provider: "openai" | "anthropic",
  ) => ActiveOmpLoginFlow | null;
  readonly dismissOmpLoginInput: (flowId: string) => void;
  readonly getOmpLoginSubmitSupport: (environmentId: string) => boolean | undefined;
  readonly isOmpLoginActive: boolean;
  readonly releaseOmpLoginFlow: (flow: ActiveOmpLoginFlow) => void;
  readonly requestOmpLoginInput: (challenge: OmpLoginChallenge) => Promise<string | null>;
  readonly setOmpLoginSubmitSupport: (environmentId: string, supported: boolean) => void;
  readonly setOmpLoginAuthorization: Dispatch<SetStateAction<OmpLoginAuthorization | null>>;
  readonly startSessionCopy: StartSessionCopy | undefined;
}) {
  const navigate = useNavigate();
  const {
    acquireOmpLoginFlow,
    clearOpenIntent,
    dismissOmpLoginInput,
    getOmpLoginSubmitSupport,
    isOmpLoginActive,
    openIntent,
    openOverlayMode,
    releaseOmpLoginFlow,
    requestOmpLoginInput,
    setOmpLoginSubmitSupport,
    setOmpLoginAuthorization,
    setOpen,
    startSessionCopy,
  } = props;
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const clientSettings = useClientSettings();
  const createProject = useAtomCommand(projectEnvironment.create, {
    reportFailure: false,
  });
  const lookupRepository = useAtomQueryRunner(sourceControlEnvironment.repository, {
    reportFailure: false,
  });
  const loadBrowsePath = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
  });
  const cloneRepository = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const desktopLocalBootstraps = useDesktopLocalBootstraps();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const ompSnapshotQuery = useEnvironmentQuery<OmpAccountOverview, unknown>(
    primaryEnvironmentId === null
      ? null
      : serverEnvironment.ompAccountsSnapshot({ environmentId: primaryEnvironmentId, input: {} }),
  );
  const refreshOmpAccounts = useAtomCommand(serverEnvironment.refreshOmpAccounts, {
    reportFailure: false,
  });
  const beginOmpAccountLogin = useAtomCommand(serverEnvironment.beginOmpAccountLogin, {
    reportFailure: false,
  });
  const respondOmpAccountLogin = useAtomCommand(serverEnvironment.respondOmpAccountLogin, {
    reportFailure: false,
  });
  const submitOmpAccountLogin = useAtomCommand(serverEnvironment.submitOmpAccountLogin, {
    reportFailure: false,
  });
  const cancelOmpAccountLogin = useAtomCommand(serverEnvironment.cancelOmpAccountLogin, {
    reportFailure: false,
  });
  const removeOmpAccount = useAtomCommand(serverEnvironment.removeOmpAccount, {
    reportFailure: false,
  });
  const [ompOverview, setOmpOverview] = useState<OmpAccountOverview | null>(null);
  const [ompOverviewCachedAt, setOmpOverviewCachedAt] = useState<number | null>(null);
  const [ompRefreshWarning, setOmpRefreshWarning] = useState<string | null>(null);
  const [isOmpCacheHydrated, setIsOmpCacheHydrated] = useState(false);
  const [isRefreshingOmpAccounts, setIsRefreshingOmpAccounts] = useState(false);
  const [scaffoldDeploymentCapabilities, setScaffoldDeploymentCapabilities] =
    useState<ScaffoldDeploymentCapabilities | null>(null);
  const ompOverviewRef = useRef(ompOverview);
  const ompOverviewCachedAtRef = useRef(ompOverviewCachedAt);
  ompOverviewRef.current = ompOverview;
  ompOverviewCachedAtRef.current = ompOverviewCachedAt;
  const ompRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshOmpSnapshot = ompSnapshotQuery.refresh;

  useEffect(() => {
    // The capability endpoint belongs to the configured primary transport and
    // is usable before environment entity hydration publishes an id.
    return loadScaffoldDeploymentCapabilities({
      request: requestScaffoldDeploymentCapabilities,
      setCapabilities: setScaffoldDeploymentCapabilities,
    });
  }, [primaryEnvironmentId]);

  useEffect(() => {
    let cancelled = false;
    setOmpOverview(null);
    setOmpOverviewCachedAt(null);
    setOmpRefreshWarning(null);
    setIsOmpCacheHydrated(false);
    if (primaryEnvironmentId === null) {
      setIsOmpCacheHydrated(true);
      return () => {
        cancelled = true;
      };
    }
    void browserOmpAccountOverviewCache
      .get(primaryEnvironmentId)
      .then((cached) => {
        if (!cancelled && cached !== null) {
          setOmpOverview(cached.overview);
          setOmpOverviewCachedAt(cached.updatedAt);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setIsOmpCacheHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [primaryEnvironmentId]);

  useEffect(() => {
    if (!isOmpCacheHydrated || ompOverview !== null || ompSnapshotQuery.data === null) return;
    const cachedAt = Date.now();
    setOmpOverview(ompSnapshotQuery.data);
    setOmpOverviewCachedAt(cachedAt);
    if (primaryEnvironmentId !== null) {
      void cacheOmpAccountOverview(
        browserOmpAccountOverviewCache,
        primaryEnvironmentId,
        ompSnapshotQuery.data,
        cachedAt,
      ).catch(() => undefined);
    }
  }, [isOmpCacheHydrated, ompOverview, ompSnapshotQuery.data, primaryEnvironmentId]);

  const refreshOmpOverview = useCallback(
    async (options?: { afterInFlight?: boolean }) => {
      if (primaryEnvironmentId === null) return;
      const activeRefresh = ompRefreshInFlightRef.current;
      if (activeRefresh !== null) {
        await activeRefresh;
        if (options?.afterInFlight !== true) return;
      }

      const refresh = (async () => {
        setIsRefreshingOmpAccounts(true);
        try {
          const result = await refreshOmpAccounts({
            environmentId: primaryEnvironmentId,
            input: {},
          });
          if (result._tag === "Success") {
            const cachedAt = Date.now();
            const mergedOverview = mergeRefreshedOmpAccountOverview({
              previous: ompOverviewRef.current,
              refreshed: result.value,
            });
            setOmpOverview(mergedOverview);
            setOmpOverviewCachedAt(cachedAt);
            setOmpRefreshWarning(null);
            void cacheOmpAccountOverview(
              browserOmpAccountOverviewCache,
              primaryEnvironmentId,
              mergedOverview,
              cachedAt,
            ).catch(() => undefined);
            refreshOmpSnapshot();
            return;
          }
          if (!isAtomCommandInterrupted(result)) {
            const failureState = preserveOmpOverviewAfterRefreshFailure({
              overview: ompOverviewRef.current,
              cachedAt: ompOverviewCachedAtRef.current,
              warning: "Showing the last cached account and usage data.",
            });
            setOmpOverview(failureState.overview);
            setOmpOverviewCachedAt(failureState.cachedAt);
            setOmpRefreshWarning(failureState.refreshWarning);
            toastManager.add(
              stackedThreadToast({
                type: "warning",
                title: "Plan usage could not be refreshed",
                description: "Showing the last cached account and usage data.",
              }),
            );
          }
        } finally {
          setIsRefreshingOmpAccounts(false);
        }
      })();
      ompRefreshInFlightRef.current = refresh;
      try {
        await refresh;
      } finally {
        if (ompRefreshInFlightRef.current === refresh) ompRefreshInFlightRef.current = null;
      }
    },
    [primaryEnvironmentId, refreshOmpAccounts, refreshOmpSnapshot],
  );

  useEffect(() => {
    if (
      !shouldRefreshOmpOverviewOnOpen({
        cacheHydrated: isOmpCacheHydrated,
        hasEnvironment: primaryEnvironmentId !== null,
      })
    ) {
      return;
    }
    void refreshOmpOverview();
  }, [isOmpCacheHydrated, primaryEnvironmentId, refreshOmpOverview]);

  const runOmpAccountLogin = useCallback(
    async (provider: "openai" | "anthropic") => {
      if (primaryEnvironmentId === null) return;
      const reservation = acquireOmpLoginFlow(primaryEnvironmentId, provider);
      if (reservation === null) return;
      const loginBrowser = prepareOmpLoginBrowserWindow(
        () => window.open("", "_blank") as Window | null,
      );
      const loginBrowserMonitor = new AbortController();
      let loginBrowserWasClosed = false;
      setOmpLoginAuthorization(null);
      let authorizationFlowId: string | null = null;
      try {
        const begun = await beginOmpAccountLogin({
          environmentId: primaryEnvironmentId,
          input: { provider },
        });
        if (begun._tag === "Failure") {
          if (!isAtomCommandInterrupted(begun)) {
            const error = squashAtomCommandFailure(begun);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: `Could not add ${providerDisplayName(provider)}`,
                description: describeOmpLoginFailure(error),
              }),
            );
          }
          return;
        }

        if (begun.value.kind === "browser") {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: `Finish adding ${providerDisplayName(provider)}`,
              description: begun.value.message ?? "Complete sign-in in the browser.",
            }),
          );
        }

        let challenge: OmpLoginChallenge | null;
        try {
          challenge = await completeOmpLoginFlow(begun.value, {
            openBrowser: (url, flowId, cancel) => {
              const authorizationUrl = normalizeOmpAuthorizationUrl(url);
              if (authorizationUrl === null) {
                throw new InvalidOmpAuthorizationUrlError();
              }
              authorizationFlowId = flowId;
              setOmpLoginAuthorization({
                cancel,
                flowId,
                provider,
                url: authorizationUrl,
              });
              if (!loginBrowser.navigate(authorizationUrl)) {
                window.open(authorizationUrl, "_blank", "noopener,noreferrer");
                return;
              }
              void observeOmpLoginBrowserWindowClose(
                loginBrowser,
                loginBrowserMonitor.signal,
                () => {
                  loginBrowserWasClosed = true;
                },
              ).catch(() => undefined);
            },
            requestInput: requestOmpLoginInput,
            respond: async (flowId, response) => {
              const next = await respondOmpAccountLogin({
                environmentId: primaryEnvironmentId,
                input: { provider, flowId, response },
              });
              if (next._tag === "Failure") throw squashAtomCommandFailure(next);
              return next.value;
            },
            submit: async (flowId, response) => {
              const submitted = await submitOmpAccountLogin({
                environmentId: primaryEnvironmentId,
                input: { flowId, response },
              });
              if (submitted._tag === "Failure") throw squashAtomCommandFailure(submitted);
              return submitted.value;
            },
            getSubmitSupport: () => getOmpLoginSubmitSupport(primaryEnvironmentId),
            setSubmitSupported: (supported) => {
              setOmpLoginSubmitSupport(primaryEnvironmentId, supported);
            },
            dismissInput: dismissOmpLoginInput,
            cancel: async (flowId) => {
              const canceled = await cancelOmpAccountLogin({
                environmentId: primaryEnvironmentId,
                input: { flowId },
              });
              throwOmpLoginCancelFailure(canceled, squashAtomCommandFailure);
            },
          });
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Could not add ${providerDisplayName(provider)}`,
              description: describeOmpLoginFailure(error),
            }),
          );
          return;
        }

        if (challenge === null) return;
        if (challenge.kind !== "complete") {
          const canceled = await cancelOmpAccountLogin({
            environmentId: primaryEnvironmentId,
            input: { flowId: challenge.flowId },
          });
          throwOmpLoginCancelFailure(canceled, squashAtomCommandFailure);
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: `Could not add ${providerDisplayName(provider)}`,
              description: "The sign-in flow did not finish. Existing accounts are unchanged.",
            }),
          );
          return;
        }

        if (challenge.outcome === "failure") {
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: `${providerDisplayName(provider)} was not added`,
              description: describeOmpLoginTerminalFailure({
                message: challenge.message,
                browserWindowClosed: loginBrowserWasClosed,
              }),
            }),
          );
        }
        await refreshOmpOverview(
          challenge.outcome === "success" ? { afterInFlight: true } : undefined,
        );
      } finally {
        loginBrowserMonitor.abort();
        loginBrowser.closeIfUnused();
        releaseOmpLoginFlow(reservation);
        if (authorizationFlowId !== null) {
          setOmpLoginAuthorization((current) =>
            current?.flowId === authorizationFlowId ? null : current,
          );
        }
      }
    },
    [
      acquireOmpLoginFlow,
      beginOmpAccountLogin,
      cancelOmpAccountLogin,
      getOmpLoginSubmitSupport,
      primaryEnvironmentId,
      refreshOmpOverview,
      releaseOmpLoginFlow,
      requestOmpLoginInput,
      respondOmpAccountLogin,
      setOmpLoginAuthorization,
      dismissOmpLoginInput,
      submitOmpAccountLogin,
      setOmpLoginSubmitSupport,
    ],
  );

  const runRemoveOmpAccount = useCallback(
    async (
      accountRef: OmpAccountOverview["accounts"]["accounts"][number]["accountRef"],
      label: string,
    ) => {
      if (primaryEnvironmentId === null || !window.confirm(`Remove ${label}?`)) return;
      const result = await removeOmpAccount({
        environmentId: primaryEnvironmentId,
        input: { accountRef },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to remove account",
            description:
              error instanceof Error ? error.message : "OMP could not remove the account.",
          }),
        );
        return;
      }
      await refreshOmpOverview();
    },
    [primaryEnvironmentId, refreshOmpOverview, removeOmpAccount],
  );
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const threads = useThreadShells();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const [viewStack, setViewStack] = useState<CommandPaletteView[]>([]);
  const currentView = viewStack.at(-1) ?? null;
  const environmentIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );
  const threadSearchQuery = currentView === null && !isActionsOnly ? deferredQuery : "";
  const threadSearch = useThreadSearch(environmentIds, threadSearchQuery);
  const threadContentMatchByKey = useMemo(
    () =>
      new Map(
        threadSearch.matches.flatMap((match) =>
          match.source === "user" || match.source === "assistant"
            ? [[threadSearchMatchKey(match), match] as const]
            : [],
        ),
      ),
    [threadSearch.matches],
  );
  const [browseGeneration, setBrowseGeneration] = useState(0);
  const browseNavigationRef = useRef<ReturnType<typeof createBrowseNavigationCoordinator> | null>(
    null,
  );
  if (browseNavigationRef.current === null) {
    browseNavigationRef.current = createBrowseNavigationCoordinator();
  }
  const browseNavigation = browseNavigationRef.current;
  const [addProjectEnvironmentId, setAddProjectEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const [isPickingProjectFolder, setIsPickingProjectFolder] = useState(false);
  const [addProjectCloneFlow, setAddProjectCloneFlow] = useState<AddProjectCloneFlow | null>(null);
  const [isRemoteProjectLookingUp, setIsRemoteProjectLookingUp] = useState(false);
  const [isRemoteProjectCloning, setIsRemoteProjectCloning] = useState(false);
  const projectGroupingSettings = useMemo(
    () => selectProjectGroupingSettings(clientSettings),
    [clientSettings],
  );

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  );
  const unsortedProjectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: clientSettings.sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [
      clientSettings.sidebarProjectSortOrder,
      environmentLabelById,
      orderedProjects,
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
    ],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        unsortedProjectGroups,
        threads,
        clientSettings.sidebarProjectSortOrder,
      ),
    [clientSettings.sidebarProjectSortOrder, threads, unsortedProjectGroups],
  );
  const contextualProjectRef = useMemo(
    () =>
      resolveThreadActionProjectRef({
        activeDraftThread,
        activeThread: activeThread ?? undefined,
        defaultProjectRef,
        handleNewThread,
      }),
    [activeDraftThread, activeThread, defaultProjectRef, handleNewThread],
  );
  const scaffoldCapabilityByDeployment = useMemo(
    () =>
      new Map(
        scaffoldDeploymentCapabilities?.deployments.map((capability) => [
          capability.deployment,
          capability,
        ]) ?? [],
      ),
    [scaffoldDeploymentCapabilities],
  );
  const scaffoldNewSessionActionPresentation = useCallback(
    (deployment: ScaffoldDeployment) =>
      getScaffoldNewSessionActionPresentation({
        hasContextualProject: contextualProjectRef !== null,
        capability: scaffoldCapabilityByDeployment.get(deployment) ?? null,
      }),
    [contextualProjectRef, scaffoldCapabilityByDeployment],
  );
  const startScaffoldThread = useCallback(
    (deployment: ScaffoldDeployment) => {
      if (contextualProjectRef === null) return Promise.resolve();
      const defaultScaffoldModelSelection = resolveScaffoldDraftModelSelection(providers, null);
      if (defaultScaffoldModelSelection === null) {
        return Promise.reject(new Error("OMP models are not ready for Scaffold yet."));
      }
      const sourceProject = projects.find(
        (project) =>
          project.environmentId === contextualProjectRef.environmentId &&
          project.id === contextualProjectRef.projectId,
      );
      return runScaffoldLaunchFlight({
        deployment,
        execute: async (context) => {
          const scaffoldUi = useScaffoldSessionUiStore.getState();
          let launchModelSelection = defaultScaffoldModelSelection;
          await runScaffoldDraftLaunch<
            DraftId,
            Extract<ScaffoldLifecycleAction, { readonly kind: "create" }>
          >({
            createDraft: async (prepareDraftBeforeNavigation) => {
              await handleNewThread(contextualProjectRef, {
                envMode: "local",
                forceNew: true,
                onDraftCreated: (draftId) => {
                  const composerDrafts = useComposerDraftStore.getState();
                  const draft = composerDrafts.getComposerDraft(draftId);
                  const sourceModelSelection = draft?.activeProvider
                    ? (draft.modelSelectionByProvider[draft.activeProvider] ?? null)
                    : null;
                  launchModelSelection =
                    resolveScaffoldDraftModelSelection(providers, sourceModelSelection) ??
                    defaultScaffoldModelSelection;
                  composerDrafts.setModelSelection(draftId, launchModelSelection, {
                    replaceOptions: true,
                  });
                },
                prepareDraftBeforeNavigation,
              });
            },
            createAction: (draftId) => {
              const locked = context.lockLatest();
              const modelGrant = scaffoldCreateParametersForModelSelection(launchModelSelection);
              if (modelGrant === null) {
                throw new Error("Scaffold requires an OMP model before the session can start.");
              }
              return makeScaffoldCreateAction({
                draftId,
                deployment: locked.deployment,
                sourceEnvironmentId: contextualProjectRef.environmentId,
                sourceProjectId: contextualProjectRef.projectId,
                create: {
                  ...modelGrant,
                  ...(sourceProject?.title ? { name: sourceProject.title } : {}),
                },
              });
            },
            showCreating: (draftId, action) => {
              if (action.deployment === undefined) {
                throw new Error("Scaffold session target was not recorded.");
              }
              scaffoldUi.rememberVolatileCreateAction(action);
              scaffoldUi.begin({
                draftId,
                deployment: action.deployment,
                actionId: action.actionId,
                sourceEnvironmentId: contextualProjectRef.environmentId,
                sourceProjectId: contextualProjectRef.projectId,
                sessionId: action.sessionId,
                createdAt: action.createdAt,
              });
            },
            persistAction: (action) =>
              enqueueScaffoldLifecycleAction(browserScaffoldLifecycleActionStore, action),
            actionPersisted: (draftId) => scaffoldUi.forgetVolatileCreateAction(draftId),
            showFailure: (draftId, error) => {
              scaffoldUi.fail(
                draftId,
                error instanceof Error ? error.message : "Scaffold session could not be queued.",
              );
            },
            requestDrain: (action) => requestScaffoldLifecycleDrain(action.actionId),
          });
        },
      });
    },
    [contextualProjectRef, handleNewThread, projects, providers],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildLocalSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: contextualProjectRef,
        primaryEnvironmentId,
      }),
    [contextualProjectRef, primaryEnvironmentId, projectGroups],
  );
  const pickerProjects = useMemo(
    () =>
      projectPickerEntries.map(({ group, targetProject }) => ({
        ...targetProject,
        title: group.displayName,
      })),
    [projectPickerEntries],
  );
  const projectGroupByTargetKey = useMemo(
    () =>
      new Map(
        projectPickerEntries.map(({ group, targetProject }) => [
          `${targetProject.environmentId}:${targetProject.id}`,
          group,
        ]),
      ),
    [projectPickerEntries],
  );

  const addProjectEnvironmentOptions = useMemo(() => {
    const options = environments.map((environment): AddProjectEnvironmentOption => {
      const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
      return {
        environmentId: environment.environmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary,
          environmentId: environment.environmentId,
          runtimeLabel: environment.label,
        }),
        isPrimary,
        isConnected: canCreateProjectInEnvironment(environment.connection.phase),
        status: connectionStatusText(environment.connection),
      };
    });

    options.sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) {
        return left.isPrimary ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });

    return options;
  }, [environments]);
  const defaultAddProjectEnvironmentId =
    addProjectEnvironmentOptions.find((option) => option.isConnected)?.environmentId ?? null;
  const wslAddProjectEnvironmentOption = useMemo(
    () =>
      addProjectEnvironmentOptions.find((option) => {
        if (!option.isConnected) return false;
        const environment = environments.find(
          (candidate) => candidate.environmentId === option.environmentId,
        );
        return environment
          ? desktopLocalBackendId(environment.entry.target)?.startsWith("wsl:") === true
          : false;
      }) ?? null,
    [addProjectEnvironmentOptions, environments],
  );
  const browseEnvironmentId = addProjectEnvironmentId ?? defaultAddProjectEnvironmentId;
  const browseEnvironment =
    environments.find((environment) => environment.environmentId === browseEnvironmentId) ?? null;
  // A desktop-local secondary backend (today: the WSL backend). The picker is
  // available against these too — the desktop dispatches pickFolder into the
  // backend's filesystem when routed by its instance id.
  const browseEnvironmentIsDesktopLocal =
    browseEnvironment !== null && isDesktopLocalConnectionTarget(browseEnvironment.entry.target);
  // Map the browsed desktop-local env to its desktop pool instance id (e.g.
  // "wsl:ubuntu"). The catalog environmentId is descriptor-derived and won't
  // route on the desktop side; pickFolder only recognizes the pool id, which
  // the bootstrap list exposes. Match on backend URL, exactly as Sidebar's
  // LocalSecondaryStatus does (environment.displayUrl === bootstrap.httpBaseUrl).
  const browseDesktopInstanceId = useMemo(() => {
    if (!browseEnvironmentIsDesktopLocal || browseEnvironment === null) {
      return null;
    }
    const displayUrl = browseEnvironment.displayUrl;
    if (displayUrl === null) {
      return null;
    }
    return (
      desktopLocalBootstraps.find((bootstrap) => bootstrap.httpBaseUrl === displayUrl)?.id ?? null
    );
  }, [browseEnvironment, browseEnvironmentIsDesktopLocal, desktopLocalBootstraps]);
  const sourceControlDiscovery = useEnvironmentQuery(
    browseEnvironmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: browseEnvironmentId,
          input: {},
        }),
  );
  const browseEnvironmentPlatform = getEnvironmentBrowsePlatform(
    browseEnvironment?.serverConfig?.environment.platform.os,
  );
  const isRemoteProjectCloneFlow = addProjectCloneFlow !== null;
  const isRemoteProjectRepositoryStep = addProjectCloneFlow?.step === "repository";
  const browsePath = useMemo(
    () => getFilesystemBrowsePath(query, browseEnvironmentPlatform, !isRemoteProjectRepositoryStep),
    [browseEnvironmentPlatform, isRemoteProjectRepositoryStep, query],
  );
  const isBrowsing = browsePath.isBrowsing;
  const browseDirectoryPath = browsePath.directoryPath;
  const paletteMode = getCommandPaletteMode({ currentView, isBrowsing });
  const getAddProjectInitialQueryForEnvironment = useCallback(
    (environmentId: EnvironmentId | null): string => {
      const environment = environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      const environmentSettings = environment?.serverConfig?.settings ?? null;
      const baseDirectory = environmentSettings?.addProjectBaseDirectory?.trim() ?? "";
      if (baseDirectory.length === 0) {
        return "~/";
      }
      return ensureBrowseDirectoryPath(baseDirectory);
    },
    [environments],
  );

  const projectCwdById = useMemo(
    () =>
      new Map<ProjectId, string>(projects.map((project) => [project.id, project.workspaceRoot])),
    [projects],
  );
  const projectTitleById = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.title])),
    [projects],
  );
  const activeThreadId = activeThread?.id;
  const currentProjectEnvironmentId =
    activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null;
  const currentProjectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const currentProjectCwd = currentProjectId
    ? (projectCwdById.get(currentProjectId) ?? null)
    : null;
  const currentProjectCwdForBrowse =
    browseEnvironmentId && currentProjectEnvironmentId === browseEnvironmentId
      ? currentProjectCwd
      : null;
  const getBrowseCwdForEnvironment = useCallback(
    (environmentId: EnvironmentId | null): string | null =>
      environmentId && currentProjectEnvironmentId === environmentId ? currentProjectCwd : null,
    [currentProjectCwd, currentProjectEnvironmentId],
  );
  const relativePathNeedsActiveProject =
    isExplicitRelativeProjectPath(query.trim()) && currentProjectCwdForBrowse === null;
  const browseQuery = useEnvironmentQuery(
    isBrowsing &&
      browsePath.directoryPath.length > 0 &&
      browseEnvironmentId !== null &&
      !relativePathNeedsActiveProject
      ? filesystemEnvironment.browse({
          environmentId: browseEnvironmentId,
          input: {
            partialPath: browsePath.directoryPath,
            ...(currentProjectCwdForBrowse ? { cwd: currentProjectCwdForBrowse } : {}),
          },
        })
      : null,
  );
  const browseResult = browseQuery.data;
  const isBrowsePending = browseQuery.isPending;
  const browseEntries = browseResult?.entries ?? EMPTY_BROWSE_ENTRIES;
  const { visibleEntries: visibleBrowseEntries, exactEntry: exactBrowseEntry } = useMemo(
    () => filterFilesystemBrowseEntries(browseEntries, browsePath.filterQuery),
    [browseEntries, browsePath.filterQuery],
  );

  const prefetchBrowsePath = useCallback(
    async (
      partialPath: string,
      environmentId: EnvironmentId | null = browseEnvironmentId,
      cwd: string | null = currentProjectCwdForBrowse,
    ): Promise<void> => {
      if (!environmentId) {
        return;
      }
      const environment = environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (!canPreloadBrowsePath(environment?.connection.phase)) {
        return;
      }

      await loadBrowsePath({
        environmentId,
        input: {
          partialPath,
          ...(cwd ? { cwd } : {}),
        },
      });
    },
    [browseEnvironmentId, currentProjectCwdForBrowse, environments, loadBrowsePath],
  );

  useEffect(
    () => () => {
      browseNavigation.invalidate();
    },
    [browseNavigation],
  );

  const openProjectFromSearch = useMemo(
    () => async (project: (typeof projects)[number]) => {
      const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
      const groupedProjectKeys = group
        ? new Set(
            group.memberProjectRefs.map(
              (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
            ),
          )
        : null;
      const latestThread = groupedProjectKeys
        ? (sortThreads(
            threads.filter(
              (thread) =>
                thread.archivedAt === null &&
                groupedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
            ),
            clientSettings.sidebarThreadSortOrder,
          )[0] ?? null)
        : getLatestThreadForProject(
            threads.filter((thread) => thread.environmentId === project.environmentId),
            project.id,
            clientSettings.sidebarThreadSortOrder,
          );
      if (latestThread) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(latestThread.environmentId, latestThread.id),
          ),
        });
        return;
      }
      await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    },
    [
      clientSettings.sidebarThreadSortOrder,
      handleNewThread,
      navigate,
      projectGroupByTargetKey,
      projects,
      threads,
    ],
  );

  const projectSearchItems = useMemo(
    () =>
      buildProjectActionItems({
        projects: pickerProjects,
        valuePrefix: "project",
        searchTerms: (project) => {
          const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
          return (
            group?.memberProjects.flatMap((member) => [member.title, member.workspaceRoot]) ?? []
          );
        },
        icon: (project) => (
          <ProjectFavicon
            environmentId={project.environmentId}
            cwd={project.workspaceRoot}
            className={ITEM_ICON_CLASS}
          />
        ),
        runProject: openProjectFromSearch,
      }),
    [openProjectFromSearch, pickerProjects, projectGroupByTargetKey],
  );

  const projectThreadItems = useMemo(
    () =>
      enumerateCommandPaletteItems(
        buildProjectActionItems({
          projects: pickerProjects,
          valuePrefix: "new-thread-in",
          searchTerms: (project) => {
            const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
            return (
              group?.memberProjects.flatMap((member) => [member.title, member.workspaceRoot]) ?? []
            );
          },
          icon: renderProjectFavicon,
          runProject: async (project) => {
            await handleNewThread(scopeProjectRef(project.environmentId, project.id));
          },
        }),
      ),
    [handleNewThread, pickerProjects, projectGroupByTargetKey],
  );

  const allThreadItems = useMemo(
    () =>
      buildThreadActionItems({
        threads,
        ...(activeThreadId ? { activeThreadId } : {}),
        projectTitleById,
        sortOrder: clientSettings.sidebarThreadSortOrder,
        icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
        renderLeadingContent: (thread) => <ThreadRowLeadingStatus thread={thread} />,
        renderTrailingContent: (thread) => <ThreadRowTrailingStatus thread={thread} />,
        getContentMatch: (thread) => {
          const match = threadContentMatchByKey.get(
            threadSearchMatchKey({
              environmentId: thread.environmentId,
              threadId: thread.id,
            }),
          );
          return match && (match.source === "user" || match.source === "assistant")
            ? {
                source: match.source,
                snippet: match.snippet,
                query: threadSearchQuery,
              }
            : undefined;
        },
        runThread: async (thread) => {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
          });
        },
      }),
    [
      activeThreadId,
      clientSettings.sidebarThreadSortOrder,
      navigate,
      projectTitleById,
      threadContentMatchByKey,
      threadSearchQuery,
      threads,
    ],
  );
  const recentThreadItems = allThreadItems.slice(0, RECENT_THREAD_LIMIT);
  const newLocalSessionProjectItems = useMemo(
    () =>
      enumerateCommandPaletteItems(
        buildProjectActionItems({
          projects: pickerProjects,
          valuePrefix: "new-local-session-in",
          searchTerms: (project) => {
            const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
            return (
              group?.memberProjects.flatMap((member) => [member.title, member.workspaceRoot]) ?? []
            );
          },
          icon: renderProjectFavicon,
          runProject: async (project) => {
            await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
              forceNew: true,
            });
          },
        }),
      ),
    [handleNewThread, pickerProjects, projectGroupByTargetKey],
  );
  const pushPaletteView = useCallback(
    (view: CommandPaletteView): void => {
      browseNavigation.invalidate();
      setViewStack((previousViews) => [
        ...previousViews,
        {
          addonIcon: view.addonIcon,
          groups: view.groups,
          ...(view.initialQuery ? { initialQuery: view.initialQuery } : {}),
        },
      ]);
      setHighlightedItemValue(null);
      setQuery(view.initialQuery ?? "");
    },
    [browseNavigation],
  );

  function pushView(item: CommandPaletteSubmenuItem): void {
    pushPaletteView({
      addonIcon: item.addonIcon,
      groups: item.groups,
      ...(item.initialQuery ? { initialQuery: item.initialQuery } : {}),
    });
  }

  function popView(): void {
    browseNavigation.invalidate();
    setAddProjectCloneFlow(null);
    if (viewStack.length <= 1) {
      setAddProjectEnvironmentId(null);
    }
    setViewStack((previousViews) => previousViews.slice(0, -1));
    setHighlightedItemValue(null);
    setQuery("");
  }

  function handleQueryChange(nextQuery: string): void {
    browseNavigation.invalidate();
    setHighlightedItemValue(null);
    setQuery(nextQuery);
    if (nextQuery === "" && currentView?.initialQuery) {
      popView();
    }
  }

  const startAddProjectBrowse = useCallback(
    async (environmentId: EnvironmentId): Promise<void> => {
      const initialQuery = getAddProjectInitialQueryForEnvironment(environmentId);
      const initialBrowsePath = getBrowseDirectoryPath(initialQuery);
      const browseCwd = getBrowseCwdForEnvironment(environmentId);
      const view: CommandPaletteView = {
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: [],
        initialQuery,
      };

      await browseNavigation.run(
        () =>
          initialBrowsePath.length > 0
            ? prefetchBrowsePath(initialBrowsePath, environmentId, browseCwd)
            : Promise.resolve(),
        () => {
          setAddProjectEnvironmentId(environmentId);
          setAddProjectCloneFlow(null);
          pushPaletteView(view);
        },
      );
    },
    [
      browseNavigation,
      getAddProjectInitialQueryForEnvironment,
      getBrowseCwdForEnvironment,
      prefetchBrowsePath,
      pushPaletteView,
    ],
  );

  const startAddProjectClone = useCallback(
    (environmentId: EnvironmentId, source: AddProjectRemoteSource): void => {
      setAddProjectEnvironmentId(environmentId);
      setAddProjectCloneFlow({ step: "repository", environmentId, source });
      pushPaletteView({
        addonIcon: remoteProjectSourceIcon(source, ADDON_ICON_CLASS),
        groups: [],
        initialQuery: "",
      });
    },
    [pushPaletteView],
  );

  const openSourceControlSettings = useCallback(() => {
    setOpen(false);
    void navigate({ to: "/settings/source-control" });
  }, [navigate, setOpen]);

  const buildAddProjectSourceGroups = useCallback(
    (
      environmentId: EnvironmentId,
      readinessBySource: AddProjectRemoteSourceReadiness,
    ): CommandPaletteView["groups"] => {
      const sourceItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
        {
          kind: "action",
          value: `action:add-project:${environmentId}:local`,
          searchTerms: ["local", "folder", "directory", "browse"],
          title: "Local folder",
          description: "Browse a folder on disk",
          icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
          keepOpen: true,
          run: async () => {
            await startAddProjectBrowse(environmentId);
          },
        },
      ];

      const orderedSources: ReadonlyArray<AddProjectRemoteSource> = [
        "url",
        ...sortAddProjectProviderSources(readinessBySource),
      ];

      for (const source of orderedSources) {
        const label = remoteProjectSourceLabel(source);
        const title = source === "url" ? "Git URL" : `${label} repository`;
        const description =
          source === "url"
            ? "Clone from a remote URL"
            : `Clone ${label} ${remoteProjectSourcePathHint(source)}`;
        const readiness = readinessBySource[source];
        const disabledHint = readiness.hint;

        const titleTrailingContent = readiness.ready ? undefined : (
          <span className="ml-auto">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-5 rounded-[.25rem] px-1.5 text-[10px] text-warning-foreground"
                    onClick={() => {
                      openSourceControlSettings();
                    }}
                  >
                    Setup Required
                  </Button>
                }
              />
              <TooltipPopup align="end" side="left">
                {disabledHint ?? "Open Settings -> Source Control to configure this provider."}
              </TooltipPopup>
            </Tooltip>
          </span>
        );

        if (!readiness.ready) {
          sourceItems.push({
            kind: "action",
            value: `action:add-project:${environmentId}:${source}:not-ready`,
            searchTerms: ["clone", "remote", "repository", "repo", "git", label, "setup required"],
            title,
            description,
            disabled: true,
            icon: remoteProjectSourceIcon(source, ITEM_ICON_CLASS),
            ...(titleTrailingContent ? { titleTrailingContent } : {}),
            run: async () => {},
          });
          continue;
        }

        sourceItems.push({
          kind: "action",
          value: `action:add-project:${environmentId}:${source}`,
          searchTerms: ["clone", "remote", "repository", "repo", "git", label],
          title,
          description,
          icon: remoteProjectSourceIcon(source, ITEM_ICON_CLASS),
          ...(titleTrailingContent ? { titleTrailingContent } : {}),
          keepOpen: true,
          run: async () => {
            startAddProjectClone(environmentId, source);
          },
        });
      }

      return [{ value: `sources:${environmentId}`, label: "Sources", items: sourceItems }];
    },
    [openSourceControlSettings, startAddProjectBrowse, startAddProjectClone],
  );

  const startAddProjectSourceSelection = useCallback(
    (environmentId: EnvironmentId): void => {
      setAddProjectEnvironmentId(environmentId);
      setAddProjectCloneFlow(null);
      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: buildAddProjectSourceGroups(
          environmentId,
          buildAddProjectRemoteSourceReadiness(
            browseEnvironmentId === environmentId ? sourceControlDiscovery.data : null,
          ),
        ),
      });
    },
    [
      browseEnvironmentId,
      buildAddProjectSourceGroups,
      pushPaletteView,
      sourceControlDiscovery.data,
    ],
  );

  const addProjectEnvironmentItems: CommandPaletteActionItem[] = addProjectEnvironmentOptions.map(
    (option) => ({
      kind: "action",
      value: `action:add-project:environment:${option.environmentId}`,
      searchTerms: [option.label, option.environmentId, option.isPrimary ? "this device" : ""],
      title: option.label,
      description: option.isPrimary ? "This device" : option.environmentId,
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        startAddProjectSourceSelection(option.environmentId);
      },
    }),
  );

  const addProjectEnvironmentGroups = useMemo<CommandPaletteView["groups"]>(
    () => [
      {
        value: "environments",
        label: "Environments",
        items: addProjectEnvironmentItems,
      },
    ],
    [addProjectEnvironmentItems],
  );

  const openAddProjectFlow = useCallback(() => {
    if (addProjectEnvironmentOptions.length > 1) {
      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: addProjectEnvironmentGroups,
      });
      return;
    }

    const environmentId = defaultAddProjectEnvironmentId;
    if (!environmentId) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to browse projects",
          description: "No environment is available.",
        }),
      );
      return;
    }

    void startAddProjectSourceSelection(environmentId);
  }, [
    addProjectEnvironmentGroups,
    addProjectEnvironmentOptions.length,
    defaultAddProjectEnvironmentId,
    pushPaletteView,
    startAddProjectSourceSelection,
  ]);

  useLayoutEffect(() => {
    if (openIntent?.kind !== "add-project") {
      return;
    }
    clearOpenIntent();
    openAddProjectFlow();
  }, [clearOpenIntent, openAddProjectFlow, openIntent]);

  useLayoutEffect(() => {
    if (openIntent?.kind !== "new-thread-in" || projectThreadItems.length === 0) {
      return;
    }
    clearOpenIntent();
    browseNavigation.invalidate();
    setAddProjectCloneFlow(null);
    setViewStack([]);
    setQuery("");
    const currentPrefix =
      currentProjectEnvironmentId && currentProjectId
        ? `new-thread-in:${currentProjectEnvironmentId}:${currentProjectId}`
        : null;
    const prioritized = currentPrefix
      ? [
          ...projectThreadItems.filter((item) => item.value === currentPrefix),
          ...projectThreadItems.filter((item) => item.value !== currentPrefix),
        ]
      : projectThreadItems;
    pushPaletteView({
      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
      groups: [
        {
          value: "projects",
          label: "Projects",
          items: enumerateCommandPaletteItems(prioritized),
        },
      ],
    });
  }, [
    clearOpenIntent,
    browseNavigation,
    currentProjectEnvironmentId,
    currentProjectId,
    openIntent,
    projectThreadItems,
    pushPaletteView,
  ]);

  const newSessionGroups = useMemo<CommandPaletteView["groups"]>(() => {
    const stagingPresentation = scaffoldNewSessionActionPresentation("staging");
    const productionPresentation = scaffoldNewSessionActionPresentation("production");
    return [
      {
        value: "session-location",
        label: "Run on",
        items: [
          {
            kind: "submenu",
            value: "action:new-session:local",
            searchTerms: ["local", "worktree", "project"],
            title: "Local",
            description: "New worktree",
            icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
            addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
            disabled: projects.length === 0,
            groups: [{ value: "projects", label: "Project", items: newLocalSessionProjectItems }],
          },
          {
            kind: "action",
            value: "action:new-session:scaffold:staging",
            searchTerms: ["staging", "scaffold", "cloud"],
            title: "Scaffold staging",
            description: stagingPresentation.description,
            icon: <CloudIcon className={ITEM_ICON_CLASS} />,
            disabled: stagingPresentation.disabled,
            run: async () => startScaffoldThread("staging"),
          },
          {
            kind: "action",
            value: "action:new-session:scaffold:production",
            searchTerms: ["production", "scaffold", "cloud"],
            title: "Scaffold production",
            description: productionPresentation.description,
            icon: <CloudIcon className={ITEM_ICON_CLASS} />,
            disabled: productionPresentation.disabled,
            run: async () => startScaffoldThread("production"),
          },
        ],
      },
    ];
  }, [
    newLocalSessionProjectItems,
    projects.length,
    scaffoldNewSessionActionPresentation,
    startScaffoldThread,
  ]);
  const newSessionItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:new-session",
    searchTerms: ["new session", "local", "scaffold", "sandbox", "cloud"],
    title: "New Session",
    icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
    groups: newSessionGroups,
  };

  useEffect(() => {
    setViewStack((previousViews) => refreshNewSessionPaletteView(previousViews, newSessionGroups));
  }, [newSessionGroups]);

  useLayoutEffect(() => {
    if (openIntent?.kind !== "new-session") {
      return;
    }
    clearOpenIntent();
    setAddProjectCloneFlow(null);
    setViewStack([]);
    setQuery("");
    pushPaletteView({
      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
      groups: newSessionGroups,
    });
  }, [clearOpenIntent, newSessionGroups, openIntent]);

  const activeThreadEnvironment = activeThread
    ? environments.find((environment) => environment.environmentId === activeThread.environmentId)
    : undefined;
  const activeThreadIsLocal = Boolean(
    activeThread &&
    activeThreadEnvironment &&
    isSessionTransferLocalConnectionTarget(activeThreadEnvironment.entry.target),
  );
  const copySessionEligible = canCopySessionToScaffold({
    isLocalEnvironment: activeThreadIsLocal,
    startAvailable: startSessionCopy !== undefined,
    thread: activeThread,
  });
  const sessionTransferKind = sessionTransferKindForThread(activeThread);
  const copySessionItem: CommandPaletteSubmenuItem | undefined =
    copySessionEligible && sessionTransferKind && activeThread && startSessionCopy
      ? {
          kind: "submenu",
          value: "action:copy-to-scaffold",
          searchTerms: ["copy", "scaffold", "staging", "cloud"],
          title: sessionTransferCommandTitle(sessionTransferKind),
          icon: <CloudIcon className={ITEM_ICON_CLASS} />,
          addonIcon: <CloudIcon className={ADDON_ICON_CLASS} />,
          groups: [
            {
              value: "copy-to-scaffold-deployment",
              label: "Copy to",
              items: COPY_SESSION_SCAFFOLD_DEPLOYMENTS.map((deployment) => ({
                kind: "action" as const,
                value: `action:copy-to-scaffold:${deployment}`,
                searchTerms: [deployment, "scaffold", "cloud"],
                title: `Scaffold ${deployment}`,
                icon: <CloudIcon className={ITEM_ICON_CLASS} />,
                keepOpen: true,
                run: async () => {
                  let progressToastId: ReturnType<typeof toastManager.add> | undefined;
                  await runSessionTransferCommand({
                    deployment,
                    kind: sessionTransferKind,
                    source: {
                      environmentId: activeThread.environmentId,
                      projectId: activeThread.projectId,
                      threadId: activeThread.id,
                    },
                    start: startSessionCopy,
                    closePalette: () => setOpen(false),
                    onProgress: (title) => {
                      progressToastId = toastManager.add(
                        stackedThreadToast({ type: "loading", title, timeout: 0 }),
                      );
                    },
                    onCompleted: (title, destination) => {
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(
                          scopeThreadRef(destination.environmentId, destination.threadId),
                        ),
                      });
                      const toast = stackedThreadToast({
                        type: "success",
                        title,
                      });
                      if (progressToastId === undefined) toastManager.add(toast);
                      else toastManager.update(progressToastId, toast);
                    },
                    onFailed: (title, error) => {
                      const toast = stackedThreadToast({
                        type: "error",
                        title,
                        description: error instanceof Error ? error.message : undefined,
                      });
                      if (progressToastId === undefined) toastManager.add(toast);
                      else toastManager.update(progressToastId, toast);
                    },
                  });
                },
              })),
            },
          ],
        }
      : undefined;

  const visibleOmpOverview = ompOverview ?? ompSnapshotQuery.data;
  const hasActiveTurn = activeThread?.session?.activeTurnId != null;
  const ompLoginActionPresentation = getOmpLoginActionPresentation({
    hasEnvironment: primaryEnvironmentId !== null,
    hasActiveTurn,
    hasActiveLogin: isOmpLoginActive,
  });
  const ompAccountItems: CommandPaletteActionItem[] = [];
  if (visibleOmpOverview !== null) {
    for (const account of visibleOmpOverview.accounts.accounts) {
      const providerName = providerDisplayName(account.provider);
      const accountLabel = account.maskedEmail ?? account.displayName;
      const presentation = buildOmpAccountRowPresentation(account);
      if (!presentation.connected) {
        ompAccountItems.push({
          kind: "action",
          value: `omp-account:unavailable:${account.accountRef}`,
          searchTerms: ["reconnect", "not connected", providerName, accountLabel],
          title: presentation.title,
          description: presentation.description,
          icon: <TriangleAlertIcon className="size-4 text-amber-500" />,
          disabled: true,
          run: async () => undefined,
        });
      } else if (!visibleOmpOverview.accounts.managed) {
        ompAccountItems.push({
          kind: "action",
          value: `omp-account:remove:${account.accountRef}`,
          searchTerms: ["remove", providerName, account.displayName, account.maskedEmail ?? ""],
          title: `Remove ${presentation.title}`,
          description: presentation.description,
          icon: <UserRoundXIcon className={ITEM_ICON_CLASS} />,
          keepOpen: true,
          run: async () => runRemoveOmpAccount(account.accountRef, accountLabel),
        });
      }
    }
  }

  if (visibleOmpOverview?.accounts.managed !== true) {
    ompAccountItems.push(
      {
        kind: "action",
        value: "omp-account:add:openai",
        searchTerms: ["add", "connect", "chatgpt", "openai", "account"],
        title: "Add ChatGPT",
        description: ompLoginActionPresentation.description,
        icon: <UserRoundPlusIcon className={ITEM_ICON_CLASS} />,
        disabled: ompLoginActionPresentation.disabled,
        keepOpen: true,
        run: async () => runOmpAccountLogin("openai"),
      },
      {
        kind: "action",
        value: "omp-account:add:anthropic",
        searchTerms: ["add", "connect", "claude", "anthropic", "account"],
        title: "Add Claude",
        description: ompLoginActionPresentation.description,
        icon: <UserRoundPlusIcon className={ITEM_ICON_CLASS} />,
        disabled: ompLoginActionPresentation.disabled,
        keepOpen: true,
        run: async () => runOmpAccountLogin("anthropic"),
      },
    );
  }

  const refreshOmpUsageItem: CommandPaletteActionItem = {
    kind: "action",
    value: "omp-account:refresh",
    searchTerms: ["refresh", "usage", "plan", "account", "quota"],
    title: isRefreshingOmpAccounts ? "Refreshing accounts and plan usage..." : "Refresh plan usage",
    icon: (
      <RefreshCwIcon className={cn(ITEM_ICON_CLASS, isRefreshingOmpAccounts && "animate-spin")} />
    ),
    disabled: isRefreshingOmpAccounts,
    keepOpen: true,
    run: refreshOmpOverview,
  };

  const ompUsageItems: CommandPaletteActionItem[] =
    visibleOmpOverview === null
      ? []
      : buildOmpUsageDisplayRows(
          visibleOmpOverview.usage.reports,
          visibleOmpOverview.accounts.accounts,
        ).map((row) => ({
          kind: "action" as const,
          value: `omp-usage:${row.key}`,
          searchTerms: ["usage", "plan", "quota", row.title, row.description],
          title: row.title,
          description: row.description,
          icon: row.stale ? (
            <TriangleAlertIcon className="size-4 text-amber-500" />
          ) : (
            <UserRoundIcon className={ITEM_ICON_CLASS} />
          ),
          disabled: true,
          run: async () => undefined,
        }));
  const ompUsageStatusItems: CommandPaletteActionItem[] = [];
  if (visibleOmpOverview !== null) {
    const status = buildOmpOverviewStatusPresentation({
      overview: visibleOmpOverview,
      cachedAt: ompOverviewCachedAt,
      refreshWarning: ompRefreshWarning,
    });
    ompUsageStatusItems.push({
      kind: "action",
      value: "omp-usage:freshness",
      searchTerms: ["usage", "plan", "cached", "last refreshed", status.freshnessTitle],
      title: status.freshnessTitle,
      description: status.freshnessDescription,
      icon: <Clock3Icon className={ITEM_ICON_CLASS} />,
      disabled: true,
      run: async () => undefined,
    });
    if (status.warning) {
      ompUsageStatusItems.push({
        kind: "action",
        value: "omp-usage:warning",
        searchTerms: ["usage", "plan", "warning", "stale", status.warning],
        title: "Account and plan usage may be out of date",
        description: status.warning,
        icon: <TriangleAlertIcon className="size-4 text-amber-500" />,
        disabled: true,
        run: async () => undefined,
      });
    }
  }
  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];
  actionItems.push({
    kind: "action",
    value: "action:open-file-picker",
    searchTerms: ["go to file", "open file", "file picker", "find file", "quick open"],
    title: "Go to file",
    icon: <FileSearchIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    shortcutCommand: "filePicker.toggle",
    run: async () => {
      openOverlayMode("files");
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:search-project-contents",
    searchTerms: ["search project", "find in files", "grep", "content search", "text search"],
    title: "Search project contents",
    icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    shortcutCommand: "projectSearch.toggle",
    run: async () => {
      openOverlayMode("content");
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:add-project",
    searchTerms: [
      "add project",
      "folder",
      "directory",
      "browse",
      "clone",
      "remote",
      "repository",
      "repo",
      "git",
      "github",
      "gitlab",
      "bitbucket",
      "azure",
      "devops",
      "url",
      "environment",
    ],
    title: "Add project",
    disabled: defaultAddProjectEnvironmentId === null,
    icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    run: async () => {
      openAddProjectFlow();
    },
  });

  if (wslAddProjectEnvironmentOption) {
    actionItems.push({
      kind: "action",
      value: "action:add-project:wsl-folder",
      searchTerms: ["add project", "open", "wsl", "linux", "folder", "directory"],
      title: "Open WSL folder",
      description: wslAddProjectEnvironmentOption.label,
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => startAddProjectBrowse(wslAddProjectEnvironmentOption.environmentId),
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:settings",
    searchTerms: ["settings", "preferences", "configuration", "keybindings"],
    title: "Open settings",
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => navigate({ to: "/settings" }),
  });

  const rootGroups = [
    ...buildAshlerRootGroups({
      newSessionItem,
      ...(copySessionItem ? { copySessionItem } : {}),
      accountItems: ompAccountItems,
      planUsageItems: [refreshOmpUsageItem, ...ompUsageStatusItems, ...ompUsageItems],
    }),
    ...buildRootGroups({ actionItems, recentThreadItems }),
  ];
  const sourceSelectionViewValue =
    addProjectEnvironmentId === null ? null : `sources:${addProjectEnvironmentId}`;
  const activeGroups =
    addProjectEnvironmentId !== null &&
    currentView !== null &&
    currentView.groups[0]?.value === sourceSelectionViewValue
      ? buildAddProjectSourceGroups(
          addProjectEnvironmentId,
          buildAddProjectRemoteSourceReadiness(sourceControlDiscovery.data),
        )
      : (currentView?.groups ?? rootGroups);

  const filteredGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
    isInSubmenu: currentView !== null,
    projectSearchItems,
    threadSearchItems: allThreadItems,
  });

  const handleAddProjectForEnvironment = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly rawCwd: string;
      readonly platform: string;
      readonly currentProjectCwd: string | null;
    }) => {
      const rawCwd = input.rawCwd;

      if (isUnsupportedWindowsProjectPath(rawCwd.trim(), input.platform)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: "Windows-style paths are only supported on Windows.",
          }),
        );
        return;
      }

      if (isExplicitRelativeProjectPath(rawCwd.trim()) && !input.currentProjectCwd) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: "Relative paths require an active project.",
          }),
        );
        return;
      }

      const cwd = resolveProjectPathForDispatch(rawCwd, input.currentProjectCwd);
      if (cwd.length === 0) return;

      const existing = findProjectByPath(
        projects.filter((project) => project.environmentId === input.environmentId),
        cwd,
      );
      if (existing) {
        const latestThread = getLatestThreadForProject(
          threads.filter((thread) => thread.environmentId === existing.environmentId),
          existing.id,
          clientSettings.sidebarThreadSortOrder,
        );
        if (latestThread) {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(latestThread.environmentId, latestThread.id),
            ),
          });
        } else {
          const navigationResult = await settlePromise(() =>
            handleNewThread(scopeProjectRef(existing.environmentId, existing.id)),
          );
          if (navigationResult._tag === "Failure") {
            const error = squashAtomCommandFailure(navigationResult);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to open project",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
            return;
          }
        }
        setOpen(false);
        return;
      }

      const projectId = newProjectId();
      const targetEnvironmentProviders =
        environments.find((environment) => environment.environmentId === input.environmentId)
          ?.serverConfig?.providers ??
        (input.environmentId === primaryEnvironmentId ? providers : []);
      const createResult = await createProject({
        environmentId: input.environmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(cwd),
          workspaceRoot: cwd,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: resolveDefaultProviderModelSelection(
            targetEnvironmentProviders,
            null,
          ),
        },
      });
      if (createResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(createResult)) {
          const error = squashAtomCommandFailure(createResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to add project",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      const navigationResult = await settlePromise(() =>
        handleNewThread(scopeProjectRef(input.environmentId, projectId)),
      );
      if (navigationResult._tag === "Failure") {
        const error = squashAtomCommandFailure(navigationResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      setOpen(false);
    },
    [
      handleNewThread,
      createProject,
      environments,
      navigate,
      primaryEnvironmentId,
      projects,
      providers,
      setOpen,
      clientSettings.sidebarThreadSortOrder,
      threads,
    ],
  );

  const handleAddProject = useCallback(
    async (rawCwd: string) => {
      if (!browseEnvironmentId) return;
      await handleAddProjectForEnvironment({
        environmentId: browseEnvironmentId,
        rawCwd,
        platform: browseEnvironmentPlatform,
        currentProjectCwd: currentProjectCwdForBrowse,
      });
    },
    [
      browseEnvironmentId,
      browseEnvironmentPlatform,
      currentProjectCwdForBrowse,
      handleAddProjectForEnvironment,
    ],
  );

  function getDefaultCloneParentPath(environmentId: EnvironmentId): string {
    return getAddProjectInitialQueryForEnvironment(environmentId);
  }

  async function submitAddProjectCloneFlow(destinationPathInput?: string): Promise<void> {
    if (!addProjectCloneFlow) {
      return;
    }

    if (addProjectCloneFlow.step === "repository") {
      const rawRepository = query.trim();
      if (rawRepository.length === 0 || isRemoteProjectLookingUp) {
        return;
      }

      const provider = remoteProjectSourceProvider(addProjectCloneFlow.source);
      if (!provider) {
        const destinationPath = getDefaultCloneParentPath(addProjectCloneFlow.environmentId);
        setAddProjectCloneFlow({
          step: "confirm",
          environmentId: addProjectCloneFlow.environmentId,
          source: addProjectCloneFlow.source,
          repositoryInput: rawRepository,
          repository: null,
          remoteUrl: rawRepository,
        });
        setHighlightedItemValue(null);
        setQuery(destinationPath);
        setBrowseGeneration((generation) => generation + 1);
        return;
      }

      setIsRemoteProjectLookingUp(true);
      const lookupResult = await lookupRepository({
        environmentId: addProjectCloneFlow.environmentId,
        input: {
          provider,
          repository: rawRepository,
        },
      });
      setIsRemoteProjectLookingUp(false);
      if (lookupResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(lookupResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Repository lookup failed",
              description: errorMessage(squashAtomCommandFailure(lookupResult)),
            }),
          );
        }
        return;
      }
      const repository = lookupResult.value;
      const destinationPath = getDefaultCloneParentPath(addProjectCloneFlow.environmentId);
      setAddProjectCloneFlow({
        step: "confirm",
        environmentId: addProjectCloneFlow.environmentId,
        source: addProjectCloneFlow.source,
        repositoryInput: rawRepository,
        repository,
        remoteUrl: repository.sshUrl,
      });
      setHighlightedItemValue(null);
      setQuery(destinationPath);
      setBrowseGeneration((generation) => generation + 1);
      return;
    }

    const rawDestination = (destinationPathInput ?? query).trim();
    if (rawDestination.length === 0 || isRemoteProjectCloning) {
      return;
    }

    if (isUnsupportedWindowsProjectPath(rawDestination, browseEnvironmentPlatform)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clone failed",
          description: "Windows-style paths are only supported on Windows.",
        }),
      );
      return;
    }

    if (isExplicitRelativeProjectPath(rawDestination) && !currentProjectCwdForBrowse) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clone failed",
          description: "Relative paths require an active project.",
        }),
      );
      return;
    }

    const destinationPath = resolveProjectPathForDispatch(
      rawDestination,
      currentProjectCwdForBrowse,
    );
    if (destinationPath.length === 0) {
      return;
    }

    setIsRemoteProjectCloning(true);
    const cloneResult = await cloneRepository({
      environmentId: addProjectCloneFlow.environmentId,
      input: {
        remoteUrl: addProjectCloneFlow.remoteUrl,
        destinationPath,
      },
    });
    setIsRemoteProjectCloning(false);
    if (cloneResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(cloneResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Clone failed",
            description: errorMessage(squashAtomCommandFailure(cloneResult)),
          }),
        );
      }
      return;
    }
    await handleAddProject(cloneResult.value.cwd);
  }

  const browseTo = useCallback(
    async (name: string): Promise<void> => {
      const nextQuery = appendBrowsePathSegment(query, name);
      await browseNavigation.run(
        () => prefetchBrowsePath(getBrowseDirectoryPath(nextQuery)),
        () => {
          setHighlightedItemValue(null);
          setQuery(nextQuery);
          setBrowseGeneration((generation) => generation + 1);
        },
      );
    },
    [browseNavigation, prefetchBrowsePath, query],
  );

  const browseUp = useCallback(async (): Promise<void> => {
    const parentPath = browsePath.parentPath;
    if (parentPath === null) {
      return;
    }

    await browseNavigation.run(
      () => prefetchBrowsePath(parentPath),
      () => {
        setHighlightedItemValue(null);
        setQuery(parentPath);
        setBrowseGeneration((generation) => generation + 1);
      },
    );
  }, [browseNavigation, browsePath.parentPath, prefetchBrowsePath]);

  // Resolve the add-project path from browse data when available. When the
  // query has a trailing separator (e.g. "~/projects/foo/"), parentPath is the
  // directory itself. Otherwise the user typed a partial leaf name, so we need
  // the exact browse entry's fullPath or fall back to the raw query.
  const resolvedAddProjectPath = hasTrailingPathSeparator(query)
    ? (browseResult?.parentPath ?? query.trim())
    : (exactBrowseEntry?.fullPath ?? query.trim());

  const canBrowseUp = !relativePathNeedsActiveProject && browsePath.canBrowseUp;

  const browseGroups = buildBrowseGroups({
    browseEntries: visibleBrowseEntries,
    browseQuery: query,
    canBrowseUp,
    upIcon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
    directoryIcon: <FolderIcon className={ITEM_ICON_CLASS} />,
    browseUp,
    browseTo,
  });
  const cloneDestinationBrowseGroups = useMemo(
    () =>
      browseGroups.map((group) =>
        group.value === "directories" ? { ...group, label: "Select where to clone" } : group,
      ),
    [browseGroups],
  );

  const remoteProjectContext = useMemo(() => {
    if (addProjectCloneFlow?.step !== "confirm") {
      return null;
    }

    return {
      title: addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.repositoryInput,
      description: addProjectCloneFlow.repository?.url ?? addProjectCloneFlow.remoteUrl,
      icon: remoteProjectSourceIcon(addProjectCloneFlow.source, ITEM_ICON_CLASS),
    };
  }, [addProjectCloneFlow]);

  let displayedGroups: CommandPaletteView["groups"] = filteredGroups;
  if (addProjectCloneFlow?.step === "repository") {
    displayedGroups = [];
  } else if (addProjectCloneFlow?.step === "confirm") {
    displayedGroups = relativePathNeedsActiveProject ? [] : cloneDestinationBrowseGroups;
  } else if (isBrowsing) {
    displayedGroups = relativePathNeedsActiveProject ? [] : browseGroups;
  }

  const inputPlaceholder =
    remoteProjectInputPlaceholder(addProjectCloneFlow) ??
    getCommandPaletteInputPlaceholder(paletteMode);
  const isSubmenu = paletteMode === "submenu" || paletteMode === "submenu-browse";
  const hasHighlightedBrowseItem = highlightedItemValue?.startsWith("browse:") ?? false;
  const canSubmitBrowsePath = isBrowsing && !relativePathNeedsActiveProject;
  const willCreateProjectPath =
    canSubmitBrowsePath &&
    !isBrowsePending &&
    query.trim().length > 0 &&
    !hasHighlightedBrowseItem &&
    (hasTrailingPathSeparator(query) ? !browseResult : exactBrowseEntry === null);
  const useMetaForMod = isMacPlatform(navigator.platform);
  const submitModifierLabel = useMetaForMod ? "\u2318" : "Ctrl";
  const isCloneDestinationStep = addProjectCloneFlow?.step === "confirm";
  const submitActionLabel = isCloneDestinationStep
    ? willCreateProjectPath
      ? "Create & Clone"
      : "Clone"
    : willCreateProjectPath
      ? "Create & Add"
      : "Add";
  const addShortcutLabel = hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter";
  const remoteProjectButtonLabel = addProjectCloneFlow
    ? addProjectCloneFlow.source === "url"
      ? "Continue"
      : "Lookup"
    : null;
  const isRemoteProjectPending = isRemoteProjectLookingUp || isRemoteProjectCloning;
  const canSubmitRemoteProjectFlow =
    addProjectCloneFlow?.step === "repository" &&
    query.trim().length > 0 &&
    !isRemoteProjectPending;
  const fileManagerName = getLocalFileManagerName(navigator.platform);
  const canOpenProjectFromFileManager =
    isBrowsing &&
    browseEnvironmentId !== null &&
    // For a desktop-local (WSL) env, only offer the picker once we have resolved
    // its desktop pool instance id. Without it pickFolder can't be routed to the
    // WSL filesystem and would open the primary (Windows) picker, then add the
    // chosen Windows path against the WSL env -- a wrong-path footgun. Stay
    // hidden until the bootstrap mapping is available rather than mis-routing.
    (browseEnvironmentId === primaryEnvironmentId ||
      (browseEnvironmentIsDesktopLocal && browseDesktopInstanceId !== null)) &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined;
  const fileManagerInitialPath = useMemo(() => {
    if (!canOpenProjectFromFileManager) {
      return undefined;
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return undefined;
    }

    const initialPath = hasTrailingPathSeparator(query)
      ? (browseResult?.parentPath ?? trimmedQuery)
      : browseDirectoryPath || trimmedQuery;

    const resolvedPath = resolveProjectPathForDispatch(initialPath, currentProjectCwdForBrowse);
    return resolvedPath.length > 0 ? resolvedPath : undefined;
  }, [
    browseDirectoryPath,
    browseResult?.parentPath,
    canOpenProjectFromFileManager,
    currentProjectCwdForBrowse,
    query,
  ]);

  function isPrimaryModifierPressed(event: KeyboardEvent<HTMLInputElement>): boolean {
    return useMetaForMod ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: { modelPickerOpen: false },
    });
    if (threadJumpIndexFromCommand(command ?? "") !== null) {
      const matchingItem = displayedGroups
        .flatMap((group) => group.items)
        .find((item) => item.shortcutCommand === command);
      if (matchingItem) {
        event.preventDefault();
        event.stopPropagation();
        executeItem(matchingItem);
        return;
      }
    }

    if (addProjectCloneFlow?.step === "repository" && event.key === "Enter") {
      event.preventDefault();
      void submitAddProjectCloneFlow();
      return;
    }

    const shouldSubmitBrowsePath =
      canSubmitBrowsePath &&
      event.key === "Enter" &&
      (!hasHighlightedBrowseItem || isPrimaryModifierPressed(event));

    if (shouldSubmitBrowsePath) {
      event.preventDefault();
      if (isCloneDestinationStep) {
        void submitAddProjectCloneFlow(resolvedAddProjectPath);
      } else {
        void handleAddProject(resolvedAddProjectPath);
      }
      return;
    }

    if (event.key === "Backspace" && query === "" && isSubmenu) {
      event.preventDefault();
      popView();
    }
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.disabled) {
      return;
    }

    if (item.kind === "submenu") {
      pushView(item);
      return;
    }

    if (!item.keepOpen) {
      setOpen(false);
    }

    void item.run().catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to run command",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
  }

  const handleOpenProjectFromFileManager = useCallback(async () => {
    if (!canOpenProjectFromFileManager || isPickingProjectFolder) {
      return;
    }
    const api = readLocalApi();
    if (!api) {
      return;
    }

    setIsPickingProjectFolder(true);
    let pickedPath: string | null = null;
    let desktopWslState: DesktopWslState | null = null;
    try {
      desktopWslState =
        browseEnvironmentId === primaryEnvironmentId && browseEnvironmentPlatform === "Linux"
          ? ((await window.desktopBridge?.getWslState().catch(() => null)) ?? null)
          : null;
      // Route the picker to the browsed env's backend filesystem. The desktop
      // only resolves a "wsl:*" pool instance id, so for a desktop-local env we
      // pass the bootstrap-mapped instance id (not the catalog environmentId).
      // A WSL-only primary has no secondary bootstrap, so resolve its instance
      // id from desktop settings. Windows and combo-mode primaries still omit
      // the target to preserve the native primary picker. The desktop converts
      // a WSL UNC selection back to a Linux path before returning.
      const pickerTargetEnvironmentId = resolveProjectPickerTarget({
        browseEnvironmentId,
        primaryEnvironmentId,
        desktopInstanceId: browseDesktopInstanceId,
        wslConfiguration: desktopWslState,
      });
      const pickerOptions = {
        ...(fileManagerInitialPath ? { initialPath: fileManagerInitialPath } : {}),
        ...(pickerTargetEnvironmentId ? { targetEnvironmentId: pickerTargetEnvironmentId } : {}),
      };
      pickedPath = await api.dialogs.pickFolder(
        Object.keys(pickerOptions).length > 0 ? pickerOptions : undefined,
      );
    } catch {
      // Ignore picker failures and leave the palette open.
      setIsPickingProjectFolder(false);
      return;
    }
    setIsPickingProjectFolder(false);
    if (!pickedPath) {
      return;
    }
    if (parseWslUncPath(pickedPath)) {
      desktopWslState ??= (await window.desktopBridge?.getWslState().catch(() => null)) ?? null;
      let primaryRunningDistro: string | null = null;
      try {
        primaryRunningDistro =
          window.desktopBridge
            ?.getLocalEnvironmentBootstraps()
            .find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID)?.runningDistro ??
          null;
      } catch {
        // Keep UNC routing strict when the live primary identity cannot be read.
      }
      const selection = resolveWslProjectSelection(
        pickedPath,
        applyWslEnvironmentConfiguration(
          environments.flatMap((environment) => {
            const backendId = desktopLocalBackendId(environment.entry.target);
            if (!backendId) {
              return [];
            }

            const bootstrap = desktopLocalBootstraps.find(
              (candidate) => candidate.httpBaseUrl === environment.displayUrl,
            );
            const runningDistro = bootstrap?.runningDistro ?? null;
            return [{ environmentId: environment.environmentId, backendId, runningDistro }];
          }),
          primaryEnvironmentId,
          desktopWslState ?? null,
          primaryRunningDistro,
        ),
      );
      if (!selection) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not add WSL project",
            description: "Start the matching WSL backend, then choose the folder again.",
          }),
        );
        return;
      }
      await handleAddProjectForEnvironment({
        environmentId: selection.environmentId,
        rawCwd: selection.linuxPath,
        platform: "Linux",
        currentProjectCwd: null,
      });
      return;
    }
    await handleAddProject(pickedPath);
  }, [
    browseDesktopInstanceId,
    browseEnvironmentId,
    browseEnvironmentPlatform,
    canOpenProjectFromFileManager,
    desktopLocalBootstraps,
    environments,
    fileManagerInitialPath,
    handleAddProject,
    handleAddProjectForEnvironment,
    isPickingProjectFolder,
    primaryEnvironmentId,
  ]);

  const inputAccessory =
    addProjectCloneFlow?.step === "repository" ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="xs"
              tabIndex={-1}
              className="absolute inset-e-2.5 top-1/2 gap-1.5 pe-1 ps-2 -translate-y-1/2"
              aria-label={`${remoteProjectButtonLabel ?? "Continue"} (Enter)`}
              disabled={!canSubmitRemoteProjectFlow}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                void submitAddProjectCloneFlow();
              }}
            />
          }
        >
          <span>{isRemoteProjectPending ? "Working" : remoteProjectButtonLabel}</span>
          <KbdGroup className="pointer-events-none -me-0.5 items-center gap-1">
            <Kbd>Enter</Kbd>
          </KbdGroup>
        </TooltipTrigger>
        <TooltipPopup side="top">{remoteProjectButtonLabel ?? "Continue"} (Enter)</TooltipPopup>
      </Tooltip>
    ) : isBrowsing ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="xs"
              tabIndex={-1}
              className={cn(
                "absolute inset-e-2.5 top-1/2 pe-1 ps-2 -translate-y-1/2",
                hasHighlightedBrowseItem ? "gap-1" : "gap-1.5",
              )}
              aria-label={`${submitActionLabel} (${addShortcutLabel})`}
              disabled={
                !canCreateProjectInEnvironment(browseEnvironment?.connection.phase) ||
                relativePathNeedsActiveProject ||
                (isCloneDestinationStep && isRemoteProjectPending)
              }
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                if (relativePathNeedsActiveProject) {
                  return;
                }
                if (isCloneDestinationStep) {
                  void submitAddProjectCloneFlow(resolvedAddProjectPath);
                } else {
                  void handleAddProject(resolvedAddProjectPath);
                }
              }}
            />
          }
        >
          <span>
            {isCloneDestinationStep && isRemoteProjectPending ? "Cloning" : submitActionLabel}
          </span>
          <KbdGroup className="pointer-events-none -me-0.5 items-center gap-1">
            <Kbd>{hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter"}</Kbd>
          </KbdGroup>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {submitActionLabel} ({addShortcutLabel})
        </TooltipPopup>
      </Tooltip>
    ) : null;

  const footerActionLabel =
    addProjectCloneFlow?.step === "repository"
      ? (remoteProjectButtonLabel ?? "Continue")
      : !canSubmitBrowsePath || hasHighlightedBrowseItem
        ? "Select"
        : undefined;

  const footerTrailing = canOpenProjectFromFileManager ? (
    <Button
      variant="ghost"
      size="xs"
      className="h-auto px-2 text-muted-foreground text-xs hover:bg-transparent hover:text-foreground"
      disabled={isPickingProjectFolder}
      onClick={() => {
        void handleOpenProjectFromFileManager();
      }}
    >
      {`Open in ${fileManagerName}`}
    </Button>
  ) : null;

  return (
    <CommandPaletteContent
      key={`${viewStack.length}-${browseGeneration}-${isBrowsing}-${addProjectCloneFlow?.step ?? "none"}`}
      aria-label="Command palette"
      autoHighlight={isBrowsing || isRemoteProjectCloneFlow ? false : "always"}
      footerActionLabel={footerActionLabel}
      footerTrailing={footerTrailing}
      inputAccessory={inputAccessory}
      inputProps={{
        className:
          addProjectCloneFlow?.step === "repository"
            ? "pe-32"
            : isBrowsing
              ? willCreateProjectPath
                ? "pe-36"
                : "pe-16"
              : undefined,
        placeholder: inputPlaceholder,
        wrapperClassName: isSubmenu
          ? "[&_[data-slot=autocomplete-start-addon]]:pointer-events-auto"
          : undefined,
        ...(isSubmenu
          ? {
              startAddon: (
                <button
                  type="button"
                  className="flex cursor-pointer items-center"
                  aria-label="Back"
                  onClick={popView}
                >
                  <ArrowLeftIcon />
                </button>
              ),
            }
          : isBrowsing
            ? { startAddon: <FolderPlusIcon /> }
            : {}),
        onKeyDown: handleKeyDown,
      }}
      mode="none"
      onItemHighlighted={(value) => {
        setHighlightedItemValue(typeof value === "string" ? value : null);
      }}
      onValueChange={handleQueryChange}
      panelClassName="max-h-[min(28rem,70vh)]"
      showBackHint={isSubmenu}
      value={query}
    >
      {remoteProjectContext ? (
        <div className="p-2 pb-0">
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Repository</div>
          <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
            {remoteProjectContext.icon}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-foreground text-sm">{remoteProjectContext.title}</span>
              <span className="truncate text-muted-foreground/85 text-xs">
                {remoteProjectContext.description}
              </span>
            </span>
          </div>
        </div>
      ) : null}
      <CommandPaletteResults
        groups={displayedGroups}
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={isActionsOnly}
        keybindings={keybindings}
        onExecuteItem={executeItem}
        {...(addProjectCloneFlow?.step === "repository"
          ? {
              emptyStateMessage:
                addProjectCloneFlow.source === "url"
                  ? "Enter a Git clone URL and press Enter to continue."
                  : "Enter a repository path and press Enter to look it up.",
            }
          : addProjectCloneFlow?.step === "confirm"
            ? { emptyStateMessage: "Choose a destination path and press Enter to clone." }
            : relativePathNeedsActiveProject
              ? { emptyStateMessage: "Relative paths require an active project." }
              : willCreateProjectPath
                ? {
                    emptyStateMessage: "Press Enter to create this folder and add it as a project.",
                  }
                : threadSearch.isPending
                  ? { emptyStateMessage: "Searching thread messages…" }
                  : {})}
      />
    </CommandPaletteContent>
  );
}
