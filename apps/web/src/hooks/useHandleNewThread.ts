import { useAtomValue } from "@effect/atom-react";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type ScopedProjectRef,
  type ServerProvider,
} from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { buildProviderOptionSelectionsFromDescriptors } from "@t3tools/shared/model";
import { useCallback, useMemo } from "react";
import {
  type DraftId,
  markPromotedDraftThreadByRef,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { readThreadShell, useProjects, useThread } from "../state/entities";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import { primaryServerSettingsAtom } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { selectDefaultNewThreadProject } from "../newThreadProject";
import { getDefaultProviderInstanceModel } from "../providerInstances";
import { useClientSettings } from "./useSettings";

interface DraftNavigationRequest {
  readonly draftId: DraftId;
  readonly replace: boolean;
}

interface DraftNavigationIntent {
  readonly generation: number;
  readonly request: DraftNavigationRequest;
}

type DraftNavigationCoordinator = (request: DraftNavigationRequest) => Promise<void>;

export interface LatestSingleFlightContext<T> {
  readonly latest: () => T;
  readonly observeLatest: (observer: (value: T) => void) => void;
  readonly lockLatest: () => T;
}

/**
 * Coalesces overlapping requests into one operation while allowing the caller
 * to use the newest request until it crosses its durable side-effect boundary.
 * Requests after that lock coalesce into one queued flight instead of being
 * mistaken for updates to the already-durable operation.
 */
export function createLatestSingleFlightCoordinator<T>(
  execute: (initial: T, context: LatestSingleFlightContext<T>) => Promise<void>,
): (request: T) => Promise<void> {
  interface Flight {
    initial: T;
    latest: T;
    locked: boolean;
    observer: ((value: T) => void) | null;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  }

  let active: Flight | null = null;
  let queued: Flight | null = null;

  const createFlight = (request: T): Flight => {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });
    return {
      initial: request,
      latest: request,
      locked: false,
      observer: null,
      promise,
      resolve,
      reject,
    };
  };

  const startFlight = (flight: Flight): void => {
    active = flight;
    const context: LatestSingleFlightContext<T> = {
      latest: () => flight.latest,
      observeLatest: (observer) => {
        flight.observer = observer;
        observer(flight.latest);
      },
      lockLatest: () => {
        flight.locked = true;
        return flight.latest;
      },
    };

    void Promise.resolve()
      .then(() => execute(flight.initial, context))
      .then(
        () => flight.resolve(),
        (error: unknown) => flight.reject(error),
      )
      .finally(() => {
        if (active !== flight) return;
        const next = queued;
        queued = null;
        if (next) {
          startFlight(next);
        } else {
          active = null;
        }
      });
  };

  return (request) => {
    if (active) {
      if (!active.locked) {
        active.latest = request;
        active.observer?.(request);
        return active.promise;
      }
      if (queued) {
        queued.latest = request;
        queued.observer?.(request);
        return queued.promise;
      }
      queued = createFlight(request);
      return queued.promise;
    }

    const flight = createFlight(request);
    startFlight(flight);
    return flight.promise;
  };
}

/** Scaffold images expose OMP only; local-only direct providers cannot cross the boundary. */
export function resolveScaffoldDraftModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  sourceSelection: ModelSelection | null | undefined,
): ModelSelection | null {
  const ompProvider = providers.find(
    (provider) => provider.instanceId === "omp" && provider.driver === "omp",
  );
  if (!ompProvider) return null;
  if (
    sourceSelection?.instanceId === ompProvider.instanceId &&
    ompProvider.models.some((model) => model.slug === sourceSelection.model)
  ) {
    return sourceSelection;
  }

  if (sourceSelection?.instanceId === ompProvider.instanceId) {
    const routePayload = sourceSelection.model.split("/").slice(1).join("/");
    if (routePayload.length > 0) {
      const matchingModels = ompProvider.models.filter(
        (model) => model.slug.split("/").slice(1).join("/") === routePayload,
      );
      if (matchingModels.length === 1) {
        return {
          ...sourceSelection,
          instanceId: ompProvider.instanceId,
          model: matchingModels[0]!.slug,
        };
      }
    }
  }

  const model = getDefaultProviderInstanceModel([ompProvider], ompProvider.instanceId);
  if (!model) return null;
  const selectedModel = ompProvider.models.find((candidate) => candidate.slug === model);
  const options = buildProviderOptionSelectionsFromDescriptors(
    selectedModel?.capabilities?.optionDescriptors,
  );
  return {
    instanceId: ompProvider.instanceId,
    model,
    ...(options ? { options } : {}),
  };
}

/**
 * Keeps overlapping draft navigations converged on the newest request.
 *
 * TanStack navigation promises may settle out of order while loaders prepare a
 * draft. A stale completion must not leave the UI on an older draft after the
 * user has already selected a newer session target.
 */
export function createLatestDraftNavigationCoordinator(
  navigate: (request: DraftNavigationRequest) => Promise<void>,
): DraftNavigationCoordinator {
  let generation = 0;
  let latest: DraftNavigationIntent | null = null;

  const convergeOnLatest = async (completed: DraftNavigationIntent): Promise<void> => {
    const repair: DraftNavigationIntent | null = latest;
    if (repair === null || repair === completed) return;
    await navigate({ ...repair.request, replace: true });
    await convergeOnLatest(repair);
  };

  return async (request) => {
    const intent = { generation: ++generation, request };
    latest = intent;

    let navigationFailed = false;
    let navigationError: unknown;
    try {
      await navigate(request);
    } catch (error) {
      navigationFailed = true;
      navigationError = error;
    }

    if (latest === intent) {
      if (navigationFailed) throw navigationError;
      return;
    }

    // The stale navigation may have committed after the newer one. Reassert
    // the latest destination, and keep converging if another request arrives
    // while that repair is in flight.
    await convergeOnLatest(intent);
  };
}

// The command palette unmounts as soon as an action runs. Keep the coordinator
// on the router identity so reopening the palette cannot reset ordering while
// an older navigation is still in flight.
const latestDraftNavigationByRouter = new WeakMap<object, DraftNavigationCoordinator>();

function getLatestDraftNavigationCoordinator(
  router: object,
  navigate: (request: DraftNavigationRequest) => Promise<void>,
): DraftNavigationCoordinator {
  const existing = latestDraftNavigationByRouter.get(router);
  if (existing) return existing;
  const created = createLatestDraftNavigationCoordinator(navigate);
  latestDraftNavigationByRouter.set(router, created);
  return created;
}

export function useNewThreadHandler() {
  const projects = useProjects();
  // New-thread defaults are a user preference, and the settings UI only ever
  // edits the primary environment's settings.json. Reading the target
  // environment's own settings here would silently reset remote projects to
  // the decoded defaults ("local" mode, current branch), since nothing can
  // set those values on a remote server.
  const primaryServerSettings = useAtomValue(primaryServerSettingsAtom);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const router = useRouter();
  const navigateToLatestDraft = useMemo(
    () =>
      getLatestDraftNavigationCoordinator(router, ({ draftId, replace }) =>
        router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          replace,
        }),
      ),
    [router],
  );
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    (
      projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
        startFromOrigin?: boolean;
        forceNew?: boolean;
        replace?: boolean;
        onDraftCreated?: (draftId: import("../composerDraftStore").DraftId) => void;
        prepareDraftBeforeNavigation?: (
          draftId: import("../composerDraftStore").DraftId,
        ) => Promise<void>;
      },
    ): Promise<void> => {
      const {
        getComposerDraft,
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        applyStickyState,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
        setModelSelection,
      } = useComposerDraftStore.getState();
      const currentRouteTarget = getCurrentRouteTarget();
      // A new thread carries the user's *working mode* from the thread being
      // viewed: model (including options like reasoning effort and context
      // window), permission mode, and interaction mode. Branch, worktree, and
      // env mode never carry implicitly — those come from the configured
      // defaults unless the caller passes them explicitly.
      const carrySourceShell =
        currentRouteTarget?.kind === "server"
          ? readThreadShell(currentRouteTarget.threadRef)
          : null;
      const carrySourceDraft =
        currentRouteTarget?.kind === "draft" ? getDraftSession(currentRouteTarget.draftId) : null;
      // Composer overrides win over the persisted thread state — they are
      // what the user currently sees in the composer controls.
      const carrySourceComposer = currentRouteTarget
        ? getComposerDraft(
            currentRouteTarget.kind === "server"
              ? currentRouteTarget.threadRef
              : currentRouteTarget.draftId,
          )
        : null;
      const composerActiveProvider = carrySourceComposer?.activeProvider ?? null;
      const composerModelSelection = composerActiveProvider
        ? (carrySourceComposer?.modelSelectionByProvider[composerActiveProvider] ?? null)
        : null;
      const carryModelSelection =
        composerModelSelection ?? carrySourceShell?.modelSelection ?? null;
      const carryRuntimeMode =
        carrySourceComposer?.runtimeMode ??
        carrySourceShell?.runtimeMode ??
        carrySourceDraft?.runtimeMode ??
        null;
      const carryInteractionMode =
        carrySourceComposer?.interactionMode ??
        carrySourceShell?.interactionMode ??
        carrySourceDraft?.interactionMode ??
        null;
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef);
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const hasStartFromOriginOption = options?.startFromOrigin !== undefined;
      const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      const storedDraftThreadRef = storedDraftThread
        ? scopeThreadRef(storedDraftThread.environmentId, storedDraftThread.threadId)
        : null;
      const reusableStoredDraftThread =
        storedDraftThreadRef && readThreadShell(storedDraftThreadRef) !== null
          ? null
          : storedDraftThread;
      if (storedDraftThreadRef && reusableStoredDraftThread === null) {
        markPromotedDraftThreadByRef(storedDraftThreadRef);
      }
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === "server"
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null;
      if (reusableStoredDraftThread && options?.forceNew !== true) {
        return (async () => {
          options?.onDraftCreated?.(reusableStoredDraftThread.draftId);
          const isDraftAlreadyOpen =
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === reusableStoredDraftThread.draftId;
          const hasExplicitWorkspaceOption =
            hasBranchOption ||
            hasWorktreePathOption ||
            hasEnvModeOption ||
            hasStartFromOriginOption;
          // Resurrecting a stored draft must not resurrect its stale context:
          // explicit workspace options win outright; otherwise the env context
          // resets to the configured defaults so drafts seeded before a
          // defaults change (or by the old carry-over behavior) stop landing
          // on "current checkout" branches forever. Composer text is
          // preserved. When the draft is already open and no options were
          // passed, leave it alone entirely — the user may have just picked a
          // branch in the composer.
          const defaultEnvMode = primaryServerSettings.defaultThreadEnvMode;
          const workspaceContext = hasExplicitWorkspaceOption
            ? {
                ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
                ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
                ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
                ...(hasStartFromOriginOption ? { startFromOrigin: options?.startFromOrigin } : {}),
              }
            : isDraftAlreadyOpen
              ? null
              : {
                  branch: null,
                  worktreePath: null,
                  envMode: defaultEnvMode,
                  startFromOrigin: resolveNewDraftStartFromOrigin({
                    envMode: defaultEnvMode,
                    newWorktreesStartFromOrigin: primaryServerSettings.newWorktreesStartFromOrigin,
                  }),
                };
          if (workspaceContext) {
            setDraftThreadContext(reusableStoredDraftThread.draftId, {
              ...workspaceContext,
              ...(carryRuntimeMode ? { runtimeMode: carryRuntimeMode } : {}),
              ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
            });
            if (carryModelSelection) {
              // The carried selection is a complete snapshot of the viewed
              // thread's model state: absent options mean "no options", not
              // "keep the stale draft's options".
              setModelSelection(reusableStoredDraftThread.draftId, carryModelSelection, {
                replaceOptions: true,
              });
            }
          }
          // The workspace context must also ride along here: when projectRef
          // targets a different physical member of the logical project,
          // createDraftThreadState treats the remap as a project change and
          // would otherwise wipe branch/worktree, undoing the write above.
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            reusableStoredDraftThread.draftId,
            {
              threadId: reusableStoredDraftThread.threadId,
              ...workspaceContext,
              ...(carryRuntimeMode ? { runtimeMode: carryRuntimeMode } : {}),
              ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
            },
          );
          if (
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === reusableStoredDraftThread.draftId
          ) {
            return;
          }
          await navigateToLatestDraft({
            draftId: reusableStoredDraftThread.draftId,
            replace: options?.replace ?? false,
          });
        })();
      }

      if (
        options?.forceNew !== true &&
        latestActiveDraftThread &&
        currentRouteTarget?.kind === "draft" &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.promotedTo == null
      ) {
        options?.onDraftCreated?.(currentRouteTarget.draftId);
        if (
          hasBranchOption ||
          hasWorktreePathOption ||
          hasEnvModeOption ||
          hasStartFromOriginOption
        ) {
          setDraftThreadContext(currentRouteTarget.draftId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            ...(hasStartFromOriginOption ? { startFromOrigin: options?.startFromOrigin } : {}),
          });
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
          ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
          ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
          ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          ...(hasStartFromOriginOption ? { startFromOrigin: options?.startFromOrigin } : {}),
        });
        return Promise.resolve();
      }

      const draftId = newDraftId();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const initialEnvMode = options?.envMode ?? primaryServerSettings.defaultThreadEnvMode;
      return (async () => {
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: initialEnvMode,
          startFromOrigin:
            options?.startFromOrigin ??
            resolveNewDraftStartFromOrigin({
              envMode: initialEnvMode,
              newWorktreesStartFromOrigin: primaryServerSettings.newWorktreesStartFromOrigin,
            }),
          runtimeMode: carryRuntimeMode ?? DEFAULT_RUNTIME_MODE,
          ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
        });
        applyStickyState(draftId);
        if (carryModelSelection) {
          // After sticky state so the viewed thread's exact selection
          // (model + options like effort and context window) wins over the
          // globally sticky one. replaceOptions: the carried selection is a
          // complete snapshot — absent options mean "no options", not "keep
          // whatever sticky state just wrote".
          setModelSelection(draftId, carryModelSelection, { replaceOptions: true });
        }

        options?.onDraftCreated?.(draftId);

        await options?.prepareDraftBeforeNavigation?.(draftId);

        await navigateToLatestDraft({
          draftId,
          replace: options?.replace ?? false,
        });
      })();
    },
    [
      getCurrentRouteTarget,
      navigateToLatestDraft,
      primaryServerSettings,
      projectGroupingSettings,
      projects,
    ],
  );
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useThread(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadHandler();
  const defaultProject = selectDefaultNewThreadProject(orderedProjects);

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef: defaultProject
      ? scopeProjectRef(defaultProject.environmentId, defaultProject.id)
      : null,
    handleNewThread,
    routeThreadRef,
  };
}
