import type { SessionFabricRunnerState, SessionFabricSessionRecord } from "@t3tools/contracts";

export interface SessionFabricSidebarSession {
  readonly sessionId: string;
  readonly environmentKind: "local" | "scaffold";
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly title: string;
  readonly runnerState: SessionFabricRunnerState;
  readonly scaffoldSessionId: string | null;
  readonly scaffoldSessionUrl: string | null;
  readonly scaffoldSessionDetailUrl: string | null;
}

export interface SessionFabricScaffoldLinks {
  readonly sessionUrl: string | null;
  readonly agentUrl: string | null;
  readonly webUrl: string | null;
  readonly tiltUrl: string | null;
}

export type SessionFabricSidebarDirectoryState =
  | {
      readonly status: "loading";
      readonly sessions: ReadonlyArray<SessionFabricSidebarSession>;
    }
  | {
      readonly status: "ready" | "refreshing";
      readonly sessions: ReadonlyArray<SessionFabricSidebarSession>;
    }
  | {
      readonly status: "error";
      readonly sessions: ReadonlyArray<SessionFabricSidebarSession>;
      readonly message: string;
    };

interface SessionFabricSidebarDiscoveryEventTarget {
  addEventListener(type: "focus" | "online", listener: () => void): void;
  removeEventListener(type: "focus" | "online", listener: () => void): void;
}

export const SESSION_FABRIC_SIDEBAR_REQUEST_TIMEOUT_MS = 10_000;

export function startSessionFabricSidebarDiscovery(options: {
  readonly load: (signal: AbortSignal) => Promise<ReadonlyArray<SessionFabricSidebarSession>>;
  readonly onState: (state: SessionFabricSidebarDirectoryState) => void;
  readonly eventTarget?: SessionFabricSidebarDiscoveryEventTarget;
  readonly setTimeout?: (handler: () => void, timeoutMs: number) => number;
  readonly clearTimeout?: (timeoutId: number) => void;
  readonly requestTimeoutMs?: number;
}): {
  readonly initialLoad: Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly dispose: () => void;
} {
  let disposed = false;
  let sessions: ReadonlyArray<SessionFabricSidebarSession> = [];
  let inFlight: Promise<void> | null = null;
  let activeController: AbortController | null = null;

  const setTimeoutImplementation =
    options.setTimeout ??
    ((handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs) as unknown as number);
  const clearTimeoutImplementation =
    options.clearTimeout ??
    ((timeoutId) => globalThis.clearTimeout(timeoutId as unknown as ReturnType<typeof setTimeout>));

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inFlight !== null) return inFlight;

    options.onState({ status: sessions.length === 0 ? "loading" : "refreshing", sessions });
    const controller = new AbortController();
    activeController = controller;
    const timeoutId = setTimeoutImplementation(() => {
      controller.abort(new Error("Session discovery timed out."));
    }, options.requestTimeoutMs ?? SESSION_FABRIC_SIDEBAR_REQUEST_TIMEOUT_MS);
    const load = new Promise<ReadonlyArray<SessionFabricSidebarSession>>((resolve, reject) => {
      const handleAbort = () => {
        reject(controller.signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      controller.signal.addEventListener("abort", handleAbort, { once: true });
      void options
        .load(controller.signal)
        .then(resolve, reject)
        .finally(() => {
          controller.signal.removeEventListener("abort", handleAbort);
        });
    });
    inFlight = load
      .then((nextSessions) => {
        if (disposed) return;
        sessions = nextSessions;
        options.onState({ status: "ready", sessions });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        options.onState({
          status: "error",
          sessions,
          message: error instanceof Error ? error.message : "Session discovery failed.",
        });
      })
      .finally(() => {
        clearTimeoutImplementation(timeoutId);
        if (activeController === controller) activeController = null;
        inFlight = null;
      });
    return inFlight;
  };

  const eventTarget = options.eventTarget;
  const refreshAfterConnectivityChange = () => {
    void refresh();
  };
  eventTarget?.addEventListener("focus", refreshAfterConnectivityChange);
  eventTarget?.addEventListener("online", refreshAfterConnectivityChange);

  const initialLoad = refresh();

  return {
    initialLoad,
    refresh,
    dispose: () => {
      disposed = true;
      activeController?.abort(new DOMException("Discovery disposed.", "AbortError"));
      eventTarget?.removeEventListener("focus", refreshAfterConnectivityChange);
      eventTarget?.removeEventListener("online", refreshAfterConnectivityChange);
    },
  };
}

export function sessionFabricRunnerStateLabel(state: SessionFabricRunnerState): string {
  return `${state.slice(0, 1).toUpperCase()}${state.slice(1)}`;
}

export function selectPublicLocalSidebarSessions(
  sessions: ReadonlyArray<SessionFabricSessionRecord>,
): ReadonlyArray<SessionFabricSidebarSession> {
  return (
    sessions
      .filter((session) => session.publication === "public")
      // Opening or attaching to a session advances updatedAt. Ordering by that
      // activity timestamp made the selected row jump through the sidebar on
      // navigation. Match native thread rows: creation order is stable for the
      // lifetime of the session, with the id as a deterministic tie-breaker.
      .toSorted(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          left.sessionId.localeCompare(right.sessionId),
      )
      .map((session) => ({
        sessionId: session.sessionId,
        environmentKind: session.location.environmentKind,
        environmentId: session.location.environmentId,
        projectId: session.location.projectId,
        threadId: session.location.threadId,
        title: session.title,
        runnerState: session.runnerState,
        scaffoldSessionId: session.location.scaffoldSessionId,
        scaffoldSessionUrl: session.location.scaffoldSessionUrl,
        scaffoldSessionDetailUrl: session.location.scaffoldSessionDetailUrl ?? null,
      }))
  );
}

export function sessionFabricScaffoldLinks(
  session: SessionFabricSidebarSession,
): SessionFabricScaffoldLinks | null {
  if (
    session.environmentKind !== "scaffold" ||
    session.scaffoldSessionId === null ||
    !/^ses_[A-Za-z0-9_-]+$/u.test(session.scaffoldSessionId)
  ) {
    return null;
  }

  const validHttpUrl = (value: string): URL | null => {
    try {
      const url = new URL(value);
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username !== "" ||
        url.password !== "" ||
        url.hash !== ""
      ) {
        return null;
      }
      return url;
    } catch {
      return null;
    }
  };
  const encodedSessionId = encodeURIComponent(session.scaffoldSessionId);
  const authoritativeAgentPath = `/sessions/${encodedSessionId}/agent`;
  const directUrl =
    session.scaffoldSessionUrl === null ? null : validHttpUrl(session.scaffoldSessionUrl);
  const directUrlIsAuthoritative =
    directUrl !== null &&
    directUrl.search === "" &&
    (directUrl.pathname === authoritativeAgentPath ||
      directUrl.pathname === `${authoritativeAgentPath}/`);
  const detailUrl =
    session.scaffoldSessionDetailUrl === null
      ? null
      : validHttpUrl(session.scaffoldSessionDetailUrl);
  const detailUrlIsAuthoritative =
    detailUrl !== null &&
    detailUrl.pathname === "/" &&
    [...detailUrl.searchParams.keys()].length === 1 &&
    detailUrl.searchParams.getAll("q").length === 1 &&
    detailUrl.searchParams.get("q") === session.scaffoldSessionId;

  if (!directUrlIsAuthoritative && !detailUrlIsAuthoritative) return null;

  return {
    sessionUrl: detailUrlIsAuthoritative ? detailUrl.toString() : null,
    agentUrl: directUrlIsAuthoritative
      ? new URL(authoritativeAgentPath, directUrl.origin).toString()
      : null,
    webUrl: directUrlIsAuthoritative
      ? new URL(`/sessions/${encodedSessionId}/web`, directUrl.origin).toString()
      : null,
    tiltUrl: directUrlIsAuthoritative
      ? new URL(`/sessions/${encodedSessionId}/tilt`, directUrl.origin).toString()
      : null,
  };
}

export function selectVisibleSessionFabricSidebarSessions(
  sessions: ReadonlyArray<SessionFabricSidebarSession>,
  options: {
    readonly connectedThreadKeys: ReadonlySet<string>;
    readonly scopedProjectKeys: ReadonlySet<string> | null;
  },
): ReadonlyArray<SessionFabricSidebarSession> {
  return sessions.filter(
    (session) =>
      !options.connectedThreadKeys.has(`${session.environmentId}:${session.threadId}`) &&
      (options.scopedProjectKeys === null ||
        options.scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)),
  );
}

export function selectShadowedSessionFabricThreadKeys(
  sessions: ReadonlyArray<SessionFabricSidebarSession>,
  connectedThreadKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(
    sessions.flatMap((session) =>
      connectedThreadKeys.has(`session-fabric:${session.sessionId}:${session.threadId}`)
        ? [`session-fabric:${session.sessionId}:${session.threadId}`]
        : [],
    ),
  );
}
