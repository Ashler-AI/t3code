import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadRouteRef, resolveThreadRouteRenderState } from "../threadRoutes";
import { resolveThreadSyncPhase } from "../threadSync";
import { SidebarInset } from "~/components/ui/sidebar";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { environmentCatalog } from "../connection/catalog";
import {
  configuredSessionFabricRelayUrl,
  shouldAwaitSessionFabricRouteRegistration,
} from "../connection/sessionFabricBootstrap";
import { readRuntimeBasePath } from "../runtimeBasePath";

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const shell = useEnvironmentQuery(
    threadRef === null ? null : environmentShell.stateAtom(threadRef.environmentId),
  );
  const environmentCatalogState = useAtomValue(environmentCatalog.catalogValueAtom);
  const platformReconciliationComplete = useAtomValue(
    environmentCatalog.platformReconciledValueAtom,
  );
  const routeEnvironmentRegistered =
    threadRef !== null && environmentCatalogState.entries.has(threadRef.environmentId);
  const routeAwaitingFabricRegistration = shouldAwaitSessionFabricRouteRegistration({
    pathname: window.location.pathname,
    runtimeBasePath: readRuntimeBasePath(),
    relayBaseUrl: configuredSessionFabricRelayUrl(
      import.meta.env.VITE_T3CODE_SESSION_FABRIC_RELAY_URL,
    ),
    routeEnvironmentRegistered,
  });
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    platformReconciliationComplete:
      platformReconciliationComplete && !routeAwaitingFabricRegistration,
    routeEnvironmentRegistered,
    serverThreadShellExists: serverThreadShell !== null,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailDeleted: serverThreadStatus === "deleted",
    draftThreadExists,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverThreadDetail !== null,
    shellExists: serverThreadShell !== null,
    status: serverThreadStatus,
  });
  const serverThreadStarted = threadHasStarted(serverThreadDetail);

  useEffect(() => {
    if (!threadRef) {
      return;
    }

    if (renderState === "missing") {
      void navigate({ to: "/", replace: true });
    }
  }, [navigate, renderState, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread, serverThreadStarted, threadRef]);

  if (!threadRef) {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      {renderState === "ready" || (renderState === "loading" && serverThreadShell !== null) ? (
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
          threadSyncPhase={threadSyncPhase}
        />
      ) : null}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: ChatThreadRouteView,
});
