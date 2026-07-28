import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { Thread } from "../types";
import {
  buildBrowseGroups,
  buildAshlerRootGroups,
  buildThreadActionItems,
  enumerateCommandPaletteItems,
  filterCommandPaletteGroups,
  reduceCommandPaletteUiState,
  getCommandPaletteInputPlaceholder,
  getScaffoldNewSessionActionPresentation,
  persistScaffoldDraftAction,
  runScaffoldDraftLaunch,
  shouldRefreshOmpOverviewOnOpen,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";

describe("reduceCommandPaletteUiState", () => {
  const closedState = { open: false, mode: "command", openIntent: null } as const;

  it("toggles each overlay mode open and closed", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(filesOpen).toEqual({ open: true, mode: "files", openIntent: null });

    const contentOpen = reduceCommandPaletteUiState(filesOpen, {
      _tag: "ToggleMode",
      mode: "content",
    });
    expect(contentOpen).toEqual({ open: true, mode: "content", openIntent: null });

    expect(
      reduceCommandPaletteUiState(contentOpen, { _tag: "ToggleMode", mode: "content" }),
    ).toEqual({ open: false, mode: "command", openIntent: null });
  });

  it("switches between open modes without closing", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "ToggleMode", mode: "command" })).toEqual(
      {
        open: true,
        mode: "command",
        openIntent: null,
      },
    );
  });

  it("routes open intents to command mode", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "OpenAddProject" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "add-project" },
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "OpenNewThreadIn" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "new-thread-in" },
    });
  });

  it("resets to command mode for dialog-driven opens and closes", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });

    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: false })).toEqual({
      open: false,
      mode: "command",
      openIntent: null,
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: true })).toEqual({
      open: true,
      mode: "command",
      openIntent: null,
    });
  });
});

describe("enumerateCommandPaletteItems", () => {
  it("assigns positional jump shortcuts to the first nine displayed items", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      kind: "action" as const,
      value: `project-${index + 1}`,
      searchTerms: [],
      title: `Project ${index + 1}`,
      icon: null,
      shortcutCommand: "chat.new" as const,
      run: async () => undefined,
    }));

    expect(enumerateCommandPaletteItems(items).map((item) => item.shortcutCommand)).toEqual([
      "thread.jump.1",
      "thread.jump.2",
      "thread.jump.3",
      "thread.jump.4",
      "thread.jump.5",
      "thread.jump.6",
      "thread.jump.7",
      "thread.jump.8",
      "thread.jump.9",
      undefined,
    ]);
  });
});

describe("Ashler command palette root", () => {
  const action = (value: string, title: string): CommandPaletteActionItem => ({
    kind: "action",
    value,
    searchTerms: [title],
    title,
    icon: null,
    run: async () => undefined,
  });

  it("contains only session creation, account actions, and plan usage", () => {
    const newSessionItem: CommandPaletteSubmenuItem = {
      kind: "submenu",
      value: "action:new-session",
      searchTerms: ["new session"],
      title: "New Session",
      icon: null,
      addonIcon: null,
      groups: [],
    };
    const groups = buildAshlerRootGroups({
      newSessionItem,
      accountItems: [action("account:add", "Add ChatGPT"), action("account:remove", "Remove A")],
      planUsageItems: [
        action("usage:refresh", "Refresh plan usage"),
        action("usage:cached", "ChatGPT · 7-day quota"),
      ],
    });

    expect(groups.map((group) => group.value)).toEqual([
      "sessions",
      "omp-accounts",
      "omp-plan-usage",
    ]);
    expect(groups.flatMap((group) => group.items.map((item) => item.value))).toEqual([
      "action:new-session",
      "account:add",
      "account:remove",
      "usage:refresh",
      "usage:cached",
    ]);
    expect(JSON.stringify(groups)).not.toMatch(/settings|recent|project:add|thread:/i);
    expect(getCommandPaletteInputPlaceholder("root")).toBe("Search commands...");
  });

  it("adds an eligible copy command to the sessions group", () => {
    const newSessionItem: CommandPaletteSubmenuItem = {
      kind: "submenu",
      value: "action:new-session",
      searchTerms: ["new session"],
      title: "New Session",
      icon: null,
      addonIcon: null,
      groups: [],
    };
    const copySessionItem: CommandPaletteSubmenuItem = {
      kind: "submenu",
      value: "action:copy-to-scaffold",
      searchTerms: ["copy to scaffold"],
      title: "Copy to Scaffold",
      icon: null,
      addonIcon: null,
      groups: [],
    };

    const groups = buildAshlerRootGroups({
      newSessionItem,
      copySessionItem,
      accountItems: [],
      planUsageItems: [],
    });

    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "action:new-session",
      "action:copy-to-scaffold",
    ]);
  });

  it("waits for cached usage before starting the synchronous refresh", () => {
    expect(shouldRefreshOmpOverviewOnOpen({ cacheHydrated: false, hasEnvironment: true })).toBe(
      false,
    );
    expect(shouldRefreshOmpOverviewOnOpen({ cacheHydrated: true, hasEnvironment: true })).toBe(
      true,
    );
    expect(shouldRefreshOmpOverviewOnOpen({ cacheHydrated: true, hasEnvironment: false })).toBe(
      false,
    );
  });

  it("requires a contextual project before offering Scaffold session creation", () => {
    expect(getScaffoldNewSessionActionPresentation({ hasContextualProject: false })).toEqual({
      disabled: true,
      description: "Add or open a local project first",
    });
    expect(getScaffoldNewSessionActionPresentation({ hasContextualProject: true })).toEqual({
      disabled: false,
      description: "New Scaffold sandbox",
    });
  });
});

describe("runScaffoldDraftLaunch", () => {
  it("opens the target-labelled draft without waiting for lifecycle persistence", async () => {
    const events: string[] = [];
    let releasePersistence: (() => void) | undefined;
    const persistenceBlocked = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    await runScaffoldDraftLaunch({
      createDraft: async (prepareBeforeNavigation) => {
        events.push("draft:created");
        await prepareBeforeNavigation("draft-production");
        events.push("draft:navigated");
      },
      createAction: (draftId) => ({ draftId, deployment: "production" as const }),
      showCreating: (_draftId, action) => events.push(`ui:${action.deployment}:creating`),
      persistAction: async (action) => {
        events.push(`outbox:${action.deployment}:persisting`);
        await persistenceBlocked;
        events.push(`outbox:${action.deployment}:persisted`);
      },
      actionPersisted: () => events.push("ui:volatile-cleared"),
      showFailure: () => events.push("ui:failed"),
      requestDrain: (action) => events.push(`outbox:${action.deployment}:drain`),
    });

    expect(events).toEqual([
      "draft:created",
      "ui:production:creating",
      "outbox:production:persisting",
      "draft:navigated",
    ]);

    releasePersistence?.();
    await vi.waitFor(() => {
      expect(events).toEqual([
        "draft:created",
        "ui:production:creating",
        "outbox:production:persisting",
        "draft:navigated",
        "outbox:production:persisted",
        "ui:volatile-cleared",
        "outbox:production:drain",
      ]);
    });
  });

  it("keeps the failed target visible when the first durable write fails", async () => {
    const events: string[] = [];
    await runScaffoldDraftLaunch({
      createDraft: async (prepareBeforeNavigation) => {
        events.push("draft:created");
        await prepareBeforeNavigation("draft-staging");
        events.push("draft:navigated");
      },
      createAction: (draftId) => ({ draftId, deployment: "staging" as const }),
      showCreating: (_draftId, action) => events.push(`ui:${action.deployment}:creating`),
      persistAction: async () => {
        events.push("outbox:write-failed");
        throw new Error("IndexedDB unavailable");
      },
      actionPersisted: () => events.push("ui:volatile-cleared"),
      showFailure: (_draftId, error) =>
        events.push(`ui:staging:failed:${error instanceof Error ? error.message : "unknown"}`),
      requestDrain: () => events.push("outbox:drain"),
    });

    await vi.waitFor(() => {
      expect(events).toEqual([
        "draft:created",
        "ui:staging:creating",
        "outbox:write-failed",
        "ui:staging:failed:IndexedDB unavailable",
        "draft:navigated",
      ]);
    });
  });

  it("terminates detached durable-write failure even when failure reporting throws", async () => {
    const durableError = new Error("IndexedDB unavailable");
    const reportingError = new Error("failure UI unavailable");
    const terminalErrors: unknown[] = [];

    await expect(
      persistScaffoldDraftAction({
        draftId: "draft-production",
        action: { deployment: "production" as const },
        persistAction: async () => Promise.reject(durableError),
        showFailure: (_draftId, error) => {
          expect(error).toBe(durableError);
          throw reportingError;
        },
        actionPersisted: () => {
          throw new Error("must not mark a failed write as persisted");
        },
        requestDrain: () => {
          throw new Error("must not drain a failed write");
        },
        reportDetachedError: (error) => terminalErrors.push(error),
      }),
    ).resolves.toBeUndefined();
    expect(terminalErrors).toEqual([reportingError]);
  });

  it("reports post-persist callback failures without misclassifying the durable write", async () => {
    const persistedCallbackError = new Error("volatile UI cleanup failed");
    const drainCallbackError = new Error("drain notification failed");
    const terminalErrors: unknown[] = [];
    let failureShown = false;

    await expect(
      persistScaffoldDraftAction({
        draftId: "draft-staging",
        action: { deployment: "staging" as const },
        persistAction: async () => undefined,
        showFailure: () => {
          failureShown = true;
        },
        actionPersisted: () => {
          throw persistedCallbackError;
        },
        requestDrain: () => {
          throw drainCallbackError;
        },
        reportDetachedError: (error) => {
          terminalErrors.push(error);
          throw new Error("terminal sink failed");
        },
      }),
    ).resolves.toBeUndefined();
    expect(failureShown).toBe(false);
    expect(terminalErrors).toEqual([persistedCallbackError, drainCallbackError]);
  });
});

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    checkpoints: [],
    activities: [],
    ...overrides,
  };
}

describe("buildThreadActionItems", () => {
  it("orders threads by most recent activity and formats timestamps from updatedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00.000Z"));

    try {
      const items = buildThreadActionItems({
        threads: [
          makeThread({
            id: ThreadId.make("thread-older"),
            title: "Older thread",
            updatedAt: "2026-03-24T12:00:00.000Z",
          }),
          makeThread({
            id: ThreadId.make("thread-newer"),
            title: "Newer thread",
            createdAt: "2026-03-20T00:00:00.000Z",
            updatedAt: "2026-03-20T00:00:00.000Z",
          }),
        ],
        projectTitleById: new Map([[PROJECT_ID, "Project"]]),
        sortOrder: "updated_at",
        icon: null,
        runThread: async (_thread) => undefined,
      });

      expect(items.map((item) => item.value)).toEqual([
        "thread:thread-older",
        "thread:thread-newer",
      ]);
      expect(items[0]?.timestamp).toBe("1d ago");
      expect(items[1]?.timestamp).toBe("5d ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ranks thread title matches ahead of contextual project-name matches", () => {
    const threadItems = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-context-match"),
          title: "Fix navbar spacing",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-title-match"),
          title: "Project kickoff notes",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: threadItems,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("threads-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:thread-title-match",
      "thread:thread-context-match",
    ]);
  });

  it("preserves thread project-name matches when there is no stronger title match", () => {
    const group: CommandPaletteGroup = {
      value: "threads-search",
      label: "Threads",
      items: [
        {
          kind: "action",
          value: "thread:project-context-only",
          searchTerms: ["Fix navbar spacing", "Project"],
          title: "Fix navbar spacing",
          description: "Project",
          icon: null,
          run: async () => undefined,
        },
      ],
    };

    const groups = filterCommandPaletteGroups({
      activeGroups: [group],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["thread:project-context-only"]);
  });

  it("keeps message excerpts searchable without replacing thread metadata", () => {
    const [item] = buildThreadActionItems({
      threads: [makeThread({ branch: "feat/search" })],
      projectTitleById: new Map([[PROJECT_ID, "T3 Code"]]),
      sortOrder: "updated_at",
      icon: null,
      getContentMatch: () => ({
        source: "assistant",
        snippet: "The relay reconnect is now bounded.",
        query: "reconnect",
      }),
      runThread: async (_thread) => undefined,
    });

    expect(item?.searchTerms).toContain("The relay reconnect is now bounded.");
    expect(item?.threadContentMatch).toEqual({
      source: "assistant",
      snippet: "The relay reconnect is now bounded.",
      query: "reconnect",
    });
    expect(item?.description).toBe("T3 Code · #feat/search");
  });

  it("filters archived threads out of thread search items", () => {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          title: "Active thread",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          title: "Archived thread",
          archivedAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    expect(items.map((item) => item.value)).toEqual(["thread:thread-active"]);
  });
});

describe("buildBrowseGroups", () => {
  it("waits for asynchronous browse navigation actions", async () => {
    let finishNavigation: (() => void) | undefined;
    const browseTo = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishNavigation = resolve;
        }),
    );
    const groups = buildBrowseGroups({
      browseEntries: [{ name: "Downloads", fullPath: "/Users/test/Downloads" }],
      browseQuery: "~/",
      canBrowseUp: false,
      upIcon: null,
      directoryIcon: null,
      browseUp: vi.fn(),
      browseTo,
    });
    const item = groups[0]?.items[0];
    if (!item || item.kind !== "action") {
      throw new Error("Expected a browse action");
    }

    let actionSettled = false;
    const action = item.run().then(() => {
      actionSettled = true;
    });
    await Promise.resolve();

    expect(browseTo).toHaveBeenCalledWith("Downloads");
    expect(actionSettled).toBe(false);

    finishNavigation?.();
    await action;
    expect(actionSettled).toBe(true);
  });
});
