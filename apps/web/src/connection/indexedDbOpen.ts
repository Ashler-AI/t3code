const DEFAULT_OPEN_TIMEOUT_MS = 5_000;

export function openIndexedDatabase(input: {
  databaseName: string;
  databaseVersion: number;
  unavailableMessage: string;
  openErrorMessage: string;
  blockedMessage: string;
  timeoutMessage: string;
  upgrade: (database: IDBDatabase) => void;
  timeoutMs?: number;
}): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error(input.unavailableMessage));
      return;
    }

    const request = indexedDB.open(input.databaseName, input.databaseVersion);
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(input.timeoutMessage));
    }, input.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      reject(error);
    };

    request.addEventListener("upgradeneeded", () => input.upgrade(request.result));
    request.addEventListener("blocked", () => rejectOnce(new Error(input.blockedMessage)));
    request.addEventListener("error", () => {
      rejectOnce(request.error ?? new Error(input.openErrorMessage));
    });
    request.addEventListener("success", () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      globalThis.clearTimeout(timeout);
      resolve(request.result);
    });
  });
}
