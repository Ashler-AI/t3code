import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { isElectron } from "../env";
import { getLocalStorageItem } from "../hooks/useLocalStorage";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { cn, isMacPlatform } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useClientSettings } from "../hooks/useSettings";
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
import { ThreadAttentionNotifications } from "./ThreadAttentionNotifications";
import { useScaffoldSessionUiStore } from "../scaffoldSessionUiStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useProjects } from "../state/entities";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useAtomCommand } from "../state/use-atom-command";
import { connectScaffoldEnvironment } from "../connection/scaffoldOnboarding";
import {
  browserScaffoldLifecycleActionStore,
  drainScaffoldLifecycleActions,
  subscribeScaffoldLifecycleDrain,
} from "../connection/scaffoldLifecycleOutbox";

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "90px";

function ScaffoldSessionCoordinator() {
  const entriesByDraftId = useScaffoldSessionUiStore((state) => state.entriesByDraftId);
  const projects = useProjects();
  const connectScaffold = useAtomCommand(connectScaffoldEnvironment, { reportFailure: false });

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> | null = null;

    const drain = () => {
      if (disposed || running !== null) return;
      running = drainScaffoldLifecycleActions({
        store: browserScaffoldLifecycleActionStore,
        execute: async (action) => {
          if (action.kind !== "create") {
            return { _tag: "blocked", errorCode: "unsupported_lifecycle_action" };
          }
          const scaffoldUi = useScaffoldSessionUiStore.getState();
          const entry = Object.values(scaffoldUi.entriesByDraftId).find(
            (candidate) => candidate.actionId === action.actionId,
          );
          if (!entry) return { _tag: "blocked", errorCode: "missing_scaffold_draft" };
          const result = await connectScaffold({
            deployment: entry.deployment,
            operationId: action.actionId,
            sessionId: action.sessionId,
            create: action.create,
            label: `Scaffold ${entry.deployment}`,
          });
          if (result._tag === "Failure") {
            const error = squashAtomCommandFailure(result);
            return {
              _tag: "retry",
              retryAfterMs: 1_000,
              errorCode:
                error instanceof Error
                  ? error.name || "scaffold_create_failed"
                  : "scaffold_create_failed",
            };
          }
          scaffoldUi.connected(entry.draftId, result.value.binding);
          useComposerDraftStore.getState().setDraftThreadContext(entry.draftId, {
            projectRef: scopeProjectRef(result.value.target.environmentId, entry.sourceProjectId),
            envMode: "local",
            worktreePath: null,
          });
          return { _tag: "acknowledged" };
        },
        onBlocked: (action) => {
          const scaffoldUi = useScaffoldSessionUiStore.getState();
          const entry = Object.values(scaffoldUi.entriesByDraftId).find(
            (candidate) => candidate.actionId === action.actionId,
          );
          if (entry) scaffoldUi.fail(entry.draftId, "Scaffold session could not be created.");
        },
      })
        .catch((error: unknown) => {
          console.error("Could not drain the Scaffold lifecycle outbox.", error);
        })
        .finally(async () => {
          running = null;
          if (disposed) return;
          try {
            const pending = await browserScaffoldLifecycleActionStore.list();
            const readyAt = pending
              .filter((action) => !action.blocked)
              .map((action) => action.nextAttemptAt ?? Date.now())
              .sort((left, right) => left - right)[0];
            if (readyAt !== undefined) {
              retryTimer = setTimeout(drain, Math.max(0, readyAt - Date.now()));
            }
          } catch (error) {
            console.error("Could not schedule the Scaffold lifecycle retry.", error);
          }
        });
    };

    const unsubscribe = subscribeScaffoldLifecycleDrain(drain);
    drain();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [connectScaffold]);

  useEffect(() => {
    const draftStore = useComposerDraftStore.getState();
    for (const entry of Object.values(entriesByDraftId)) {
      if (entry.environmentId === null || entry.phase === "creating" || entry.phase === "failed") {
        continue;
      }
      const draft = draftStore.getDraftSession(entry.draftId);
      if (!draft) continue;
      const currentProjectExists = projects.some(
        (project) =>
          project.environmentId === draft.environmentId && project.id === draft.projectId,
      );
      if (currentProjectExists) continue;
      const remoteProject = projects.find(
        (project) => project.environmentId === entry.environmentId,
      );
      if (!remoteProject) continue;
      draftStore.setDraftThreadContext(entry.draftId, {
        projectRef: scopeProjectRef(remoteProject.environmentId, remoteProject.id),
        envMode: "local",
        worktreePath: null,
      });
    }
  }, [entriesByDraftId, projects]);

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
  const stageBackdropVariant = useSidebarStageBackdropVariant();
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
  const sidebarV2Enabled = useClientSettings((settings) => settings.sidebarV2Enabled);
  // Settings routes render the settings nav, which lives in the v1 component
  // and is identical for both sidebars — so v1 stays mounted there.
  const pathname = useLocation({ select: (location) => location.pathname });
  const isOnSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const useSidebarV2 = sidebarV2Enabled && !isOnSettings;
  const useSidebarV2Theme = useSidebarV2 || isOnSettings;
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(window.innerWidth);
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
      <Sidebar
        side="left"
        collapsible="offcanvas"
        data-app-sidebar=""
        data-sidebar-version={useSidebarV2Theme ? "v2" : "v1"}
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
