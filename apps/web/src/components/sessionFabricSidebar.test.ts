import {
  SessionFabricSessionRecord,
  type SessionFabricSessionRecord as SessionFabricSessionRecordType,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  selectPublicLocalSidebarSessions,
  selectShadowedSessionFabricThreadKeys,
  selectVisibleSessionFabricSidebarSessions,
  startSessionFabricSidebarDiscovery,
  type SessionFabricSidebarDirectoryState,
} from "./sessionFabricSidebar";

const decodeRecord = Schema.decodeUnknownSync(SessionFabricSessionRecord);

function record(input: {
  readonly sessionId: string;
  readonly publication: "public" | "local_only";
  readonly environmentKind: "local" | "scaffold";
  readonly environmentId?: string;
  readonly projectId?: string;
  readonly threadId?: string;
}): SessionFabricSessionRecordType {
  return decodeRecord({
    sessionId: input.sessionId,
    title: input.sessionId,
    publication: input.publication,
    runnerState: "online",
    location:
      input.environmentKind === "local"
        ? {
            environmentKind: "local",
            environmentId: input.environmentId ?? "local-environment",
            projectId: input.projectId ?? "project-1",
            threadId: input.threadId ?? "thread-1",
            repositoryRoot: "/workspace/repo",
            worktreePath: "/workspace/repo",
            scaffoldSessionId: null,
            scaffoldSessionUrl: null,
            scaffoldLifecycleEpoch: null,
          }
        : {
            environmentKind: "scaffold",
            environmentId: "scaffold-environment",
            projectId: "project-1",
            threadId: "thread-1",
            repositoryRoot: "/workspace/repo",
            worktreePath: "/workspace/repo",
            scaffoldSessionId: "ses_scaffold",
            scaffoldSessionUrl: "https://scaffold.example/sessions/ses_scaffold",
            scaffoldLifecycleEpoch: 1,
          },
    initialPrompt: null,
    searchableText: input.sessionId,
    summary: null,
    cursor: { eventSequence: 0, snapshotSequence: 0 },
    lastEventAt: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  });
}

describe("session fabric sidebar", () => {
  it("shows public local sessions and excludes private or Scaffold sessions", () => {
    const sessions = selectPublicLocalSidebarSessions([
      record({ sessionId: "public-local", publication: "public", environmentKind: "local" }),
      record({
        sessionId: "private-local",
        publication: "local_only",
        environmentKind: "local",
      }),
      record({ sessionId: "public-scaffold", publication: "public", environmentKind: "scaffold" }),
    ]);

    expect(sessions).toEqual([
      {
        sessionId: "public-local",
        environmentId: "local-environment",
        projectId: "project-1",
        threadId: "thread-1",
        title: "public-local",
        runnerState: "online",
      },
    ]);
  });

  it("recovers from an initial discovery failure after auth and network changes", async () => {
    const eventTarget = new EventTarget();
    const states: SessionFabricSidebarDirectoryState[] = [];
    let calls = 0;
    const discovery = startSessionFabricSidebarDiscovery({
      eventTarget,
      load: async () => {
        calls += 1;
        if (calls === 1) throw new Error("authentication required");
        return selectPublicLocalSidebarSessions([
          record({ sessionId: "recovered", publication: "public", environmentKind: "local" }),
        ]);
      },
      onState: (state) => states.push(state),
    });

    await discovery.initialLoad;
    expect(states.at(-1)).toMatchObject({ status: "error", message: "authentication required" });

    eventTarget.dispatchEvent(new Event("focus"));
    await discovery.refresh();
    expect(states.at(-1)).toMatchObject({
      status: "ready",
      sessions: [{ sessionId: "recovered" }],
    });

    eventTarget.dispatchEvent(new Event("online"));
    await discovery.refresh();
    expect(calls).toBe(3);
    discovery.dispose();
  });

  it("does not issue timer-driven requests while idle", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const discovery = startSessionFabricSidebarDiscovery({
        load: async () => {
          calls += 1;
          return [];
        },
        onState: () => undefined,
      });

      await discovery.initialLoad;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(calls).toBe(1);
      discovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes after focus, online, and explicit refresh requests", async () => {
    const states: SessionFabricSidebarDirectoryState[] = [];
    const eventTarget = new EventTarget();
    let calls = 0;
    const discovery = startSessionFabricSidebarDiscovery({
      eventTarget,
      load: async () => {
        calls += 1;
        return calls === 1
          ? []
          : selectPublicLocalSidebarSessions([
              record({
                sessionId: "created-later",
                publication: "public",
                environmentKind: "local",
              }),
            ]);
      },
      onState: (state) => states.push(state),
    });

    await discovery.initialLoad;
    expect(states.at(-1)).toMatchObject({ status: "ready", sessions: [] });

    eventTarget.dispatchEvent(new Event("focus"));
    await discovery.refresh();
    expect(states.at(-1)).toMatchObject({
      status: "ready",
      sessions: [{ sessionId: "created-later" }],
    });

    eventTarget.dispatchEvent(new Event("online"));
    await discovery.refresh();
    await discovery.refresh();
    expect(calls).toBe(4);
    discovery.dispose();
  });

  it("coalesces concurrent event and explicit refresh requests", async () => {
    const eventTarget = new EventTarget();
    let resolveLoad: ((sessions: ReadonlyArray<never>) => void) | undefined;
    let calls = 0;
    const discovery = startSessionFabricSidebarDiscovery({
      eventTarget,
      load: async () => {
        calls += 1;
        return new Promise<ReadonlyArray<never>>((resolve) => {
          resolveLoad = resolve;
        });
      },
      onState: () => undefined,
    });

    eventTarget.dispatchEvent(new Event("focus"));
    eventTarget.dispatchEvent(new Event("online"));
    const firstRefresh = discovery.refresh();
    const secondRefresh = discovery.refresh();
    expect(firstRefresh).toBe(secondRefresh);
    expect(calls).toBe(1);

    resolveLoad?.([]);
    await discovery.initialLoad;
    const nextRefresh = discovery.refresh();
    expect(calls).toBe(2);
    resolveLoad?.([]);
    await nextRefresh;
    discovery.dispose();
  });

  it("keeps the last successful directory when a refresh fails", async () => {
    const states: SessionFabricSidebarDirectoryState[] = [];
    let calls = 0;
    const discovery = startSessionFabricSidebarDiscovery({
      load: async () => {
        calls += 1;
        if (calls > 1) throw new Error("relay unavailable");
        return selectPublicLocalSidebarSessions([
          record({ sessionId: "cached", publication: "public", environmentKind: "local" }),
        ]);
      },
      onState: (state) => states.push(state),
    });

    await discovery.initialLoad;
    await discovery.refresh();

    expect(states.at(-1)).toMatchObject({
      status: "error",
      message: "relay unavailable",
      sessions: [{ sessionId: "cached" }],
    });
    discovery.dispose();
  });

  it("times out a stuck load, clears single-flight state, and allows retry", async () => {
    const states: SessionFabricSidebarDirectoryState[] = [];
    const signals: AbortSignal[] = [];
    let timeout: (() => void) | undefined;
    let calls = 0;
    const discovery = startSessionFabricSidebarDiscovery({
      load: async (signal) => {
        calls += 1;
        signals.push(signal);
        if (calls === 1) return new Promise(() => undefined);
        return [];
      },
      onState: (state) => states.push(state),
      setTimeout: (handler) => {
        timeout = handler;
        return 2;
      },
      clearTimeout: () => undefined,
    });

    timeout?.();
    await discovery.initialLoad;
    expect(signals[0]?.aborted).toBe(true);
    expect(states.at(-1)).toMatchObject({
      status: "error",
      message: "Session discovery timed out.",
    });

    await discovery.refresh();
    expect(calls).toBe(2);
    expect(states.at(-1)).toMatchObject({ status: "ready", sessions: [] });
    discovery.dispose();
  });

  it("aborts an in-flight load, removes event listeners, and ignores refresh after disposal", async () => {
    const backingEventTarget = new EventTarget();
    const removedListeners: string[] = [];
    const eventTarget = {
      addEventListener: (type: "focus" | "online", listener: () => void) => {
        backingEventTarget.addEventListener(type, listener);
      },
      removeEventListener: (type: "focus" | "online", listener: () => void) => {
        removedListeners.push(type);
        backingEventTarget.removeEventListener(type, listener);
      },
    };
    let calls = 0;
    let signal: AbortSignal | undefined;
    const discovery = startSessionFabricSidebarDiscovery({
      eventTarget,
      load: async (nextSignal) => {
        calls += 1;
        signal = nextSignal;
        return new Promise(() => undefined);
      },
      onState: () => undefined,
      setTimeout: () => 2,
      clearTimeout: () => undefined,
    });

    discovery.dispose();
    await discovery.initialLoad;
    expect(signal?.aborted).toBe(true);
    expect(removedListeners).toEqual(["focus", "online"]);
    backingEventTarget.dispatchEvent(new Event("focus"));
    backingEventTarget.dispatchEvent(new Event("online"));
    await discovery.refresh();
    expect(calls).toBe(1);
  });

  it("deduplicates connected threads and respects All Projects or a project scope", () => {
    const sessions = selectPublicLocalSidebarSessions([
      record({
        sessionId: "connected",
        publication: "public",
        environmentKind: "local",
        environmentId: "environment-1",
        projectId: "project-1",
        threadId: "thread-connected",
      }),
      record({
        sessionId: "project-one",
        publication: "public",
        environmentKind: "local",
        environmentId: "environment-1",
        projectId: "project-1",
        threadId: "thread-1",
      }),
      record({
        sessionId: "project-two",
        publication: "public",
        environmentKind: "local",
        environmentId: "environment-1",
        projectId: "project-2",
        threadId: "thread-2",
      }),
      record({
        sessionId: "same-thread-other-environment",
        publication: "public",
        environmentKind: "local",
        environmentId: "environment-2",
        projectId: "project-1",
        threadId: "thread-connected",
      }),
    ]);
    const connectedThreadKeys = new Set(["environment-1:thread-connected"]);

    expect(
      selectVisibleSessionFabricSidebarSessions(sessions, {
        connectedThreadKeys,
        scopedProjectKeys: null,
      }).map((session) => session.sessionId),
    ).toEqual(["project-one", "project-two", "same-thread-other-environment"]);
    expect(
      selectVisibleSessionFabricSidebarSessions(sessions, {
        connectedThreadKeys,
        scopedProjectKeys: new Set(["environment-1:project-2"]),
      }).map((session) => session.sessionId),
    ).toEqual(["project-two"]);
  });

  it("hides the relay shell when its shared session is already connected directly", () => {
    const sessions = selectPublicLocalSidebarSessions([
      record({
        sessionId: "shared-session",
        publication: "public",
        environmentKind: "local",
        environmentId: "direct-environment",
        threadId: "shared-thread",
      }),
    ]);
    const connectedThreadKeys = new Set([
      "direct-environment:shared-thread",
      "session-fabric:shared-session:shared-thread",
    ]);

    expect(selectShadowedSessionFabricThreadKeys(sessions, connectedThreadKeys)).toEqual(
      new Set(["session-fabric:shared-session:shared-thread"]),
    );
    expect(
      selectVisibleSessionFabricSidebarSessions(sessions, {
        connectedThreadKeys,
        scopedProjectKeys: null,
      }),
    ).toEqual([]);
    expect(
      selectVisibleSessionFabricSidebarSessions(sessions, {
        connectedThreadKeys: new Set(["session-fabric:shared-session:shared-thread"]),
        scopedProjectKeys: null,
      }),
    ).toEqual([]);
  });
});
