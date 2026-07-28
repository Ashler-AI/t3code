import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { openIndexedDatabase } from "./indexedDbOpen";

function makeOpenRequest(error: DOMException | null = null) {
  const close = vi.fn();
  const database = { close } as unknown as IDBDatabase;
  const request = new EventTarget() as IDBOpenDBRequest;
  Object.defineProperty(request, "result", {
    value: database,
  });
  Object.defineProperty(request, "error", {
    value: error,
  });
  return { close, database, request };
}

function open(
  request: IDBOpenDBRequest,
  timeoutMs = 5_000,
  upgrade: (database: IDBDatabase) => void = () => undefined,
) {
  vi.stubGlobal("indexedDB", { open: () => request });
  return openIndexedDatabase({
    databaseName: "test-database",
    databaseVersion: 1,
    unavailableMessage: "Storage is unavailable.",
    openErrorMessage: "Storage could not open.",
    blockedMessage: "Storage is blocked by another tab.",
    timeoutMessage: "Storage did not open.",
    upgrade,
    timeoutMs,
  });
}

describe("openIndexedDatabase", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fails immediately when another tab blocks the open request", async () => {
    const { close, request } = makeOpenRequest();
    const result = open(request);

    request.dispatchEvent(new Event("blocked"));
    await expect(result).rejects.toThrow("Storage is blocked by another tab.");

    request.dispatchEvent(new Event("success"));
    expect(close).toHaveBeenCalledOnce();
  });

  it("bounds an open request that never settles", async () => {
    vi.useFakeTimers();
    const { request } = makeOpenRequest();
    const result = open(request, 10);
    const rejection = expect(result).rejects.toThrow("Storage did not open.");

    await vi.advanceTimersByTimeAsync(10);
    await rejection;
  });

  it("preserves the IndexedDB request error", async () => {
    const error = new DOMException("Open failed.", "UnknownError");
    const { request } = makeOpenRequest(error);
    const result = open(request);

    request.dispatchEvent(new Event("error"));

    await expect(result).rejects.toBe(error);
  });

  it("runs the upgrade and resolves a successful open before the deadline", async () => {
    vi.useFakeTimers();
    const { close, database, request } = makeOpenRequest();
    const upgrade = vi.fn();
    const result = open(request, 10, upgrade);

    request.dispatchEvent(new Event("upgradeneeded"));
    request.dispatchEvent(new Event("success"));

    await expect(result).resolves.toBe(database);
    expect(upgrade).toHaveBeenCalledExactlyOnceWith(database);
    await vi.advanceTimersByTimeAsync(10);
    expect(close).not.toHaveBeenCalled();
  });

  it("closes a database that arrives after the open deadline", async () => {
    vi.useFakeTimers();
    const { close, request } = makeOpenRequest();
    const result = open(request, 10);
    const rejection = expect(result).rejects.toThrow("Storage did not open.");

    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    request.dispatchEvent(new Event("success"));

    expect(close).toHaveBeenCalledOnce();
  });
});
