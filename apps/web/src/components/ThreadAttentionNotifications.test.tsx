import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  bootstrapped: true,
  threads: [] as unknown[],
  lastVisitedAtById: {} as Record<string, string>,
  navigate: vi.fn(),
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useCallback<T>(callback: T): T {
      nextIndex();
      return callback;
    },
    useEffect(effect: () => void | (() => void)) {
      nextIndex();
      effect();
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    useRef: hooks.useRef,
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: testState.navigate }),
}));
vi.mock("../state/entities", () => ({
  useAllEnvironmentShellsBootstrapped: () => testState.bootstrapped,
  useThreadShells: () => testState.threads,
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (selector: (state: unknown) => unknown) =>
    selector({ threadLastVisitedAtById: testState.lastVisitedAtById }),
}));

import { ThreadAttentionNotifications } from "./ThreadAttentionNotifications";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function attentionThread() {
  return {
    environmentId: "env-local",
    id: "thread-1",
    title: "Fix sidebar",
    hasPendingApprovals: false,
    hasPendingUserInput: true,
    latestTurn: { turnId: "turn-2", completedAt: null },
    session: null,
  };
}

function renderNotifications(): void {
  hooks.beginRender();
  ThreadAttentionNotifications();
}

describe("ThreadAttentionNotifications", () => {
  const eventListeners = new Map<string, Set<EventListener>>();
  const createdNotifications: FakeNotification[] = [];
  const focus = vi.fn();
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);

  class FakeNotification {
    static permission: NotificationPermission = "default";
    static requestPermission = requestPermission;

    readonly close = vi.fn();
    readonly listeners = new Map<string, EventListener>();

    constructor(
      readonly title: string,
      readonly options?: NotificationOptions,
    ) {
      createdNotifications.push(this);
    }

    addEventListener(type: string, listener: EventListener): void {
      this.listeners.set(type, listener);
    }
  }

  beforeEach(() => {
    hooks.reset();
    testState.bootstrapped = true;
    testState.threads = [];
    testState.lastVisitedAtById = {};
    testState.navigate.mockReset();
    eventListeners.clear();
    createdNotifications.length = 0;
    focus.mockReset();
    requestPermission.mockClear();
    FakeNotification.permission = "default";

    const windowStub = {
      Notification: FakeNotification,
      localStorage: new MemoryStorage(),
      focus,
      addEventListener(type: string, listener: EventListener) {
        const listeners = eventListeners.get(type) ?? new Set<EventListener>();
        listeners.add(listener);
        eventListeners.set(type, listeners);
      },
      removeEventListener(type: string, listener: EventListener) {
        eventListeners.get(type)?.delete(listener);
      },
    };
    vi.stubGlobal("window", windowStub);
    vi.stubGlobal("Notification", FakeNotification);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests permission from a gesture, navigates on click, and deduplicates replay", async () => {
    renderNotifications();
    for (const listener of eventListeners.get("pointerdown") ?? []) {
      listener(new Event("pointerdown"));
    }
    await Promise.resolve();
    expect(requestPermission).toHaveBeenCalledTimes(1);

    FakeNotification.permission = "granted";
    testState.threads = [attentionThread()];
    renderNotifications();

    expect(createdNotifications).toHaveLength(1);
    expect(createdNotifications[0]).toMatchObject({
      title: "Fix sidebar",
      options: {
        body: "The agent is waiting for your input.",
        tag: "env-local:thread-1:input:turn-2",
      },
    });

    renderNotifications();
    expect(createdNotifications).toHaveLength(1);

    createdNotifications[0]?.listeners.get("click")?.(new Event("click"));
    expect(createdNotifications[0]?.close).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(testState.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-local", threadId: "thread-1" },
    });

    // Remount and replay the same attention event after it temporarily clears.
    // The persisted key prevents a duplicate native notification.
    hooks.reset();
    testState.threads = [];
    renderNotifications();
    testState.threads = [attentionThread()];
    renderNotifications();
    expect(createdNotifications).toHaveLength(1);
  });

  it("does not create a native notification when permission is denied", () => {
    renderNotifications();
    FakeNotification.permission = "denied";
    testState.threads = [attentionThread()];

    renderNotifications();

    expect(createdNotifications).toEqual([]);
  });
});
