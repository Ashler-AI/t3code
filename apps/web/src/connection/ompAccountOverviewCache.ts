import {
  OmpAccountOverview,
  type EnvironmentId,
  type OmpAccountOverview as OmpAccountOverviewValue,
  type OmpAccountSummary,
  type OmpUsageReport,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const DATABASE_NAME = "t3code:omp-account-overview";
const DATABASE_VERSION = 1;
const STORE_NAME = "snapshots";
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "apikey",
  "credential",
  "secret",
  "token",
]);

export const OMP_RETAINED_USAGE_NOTE =
  "Last known usage; this account was omitted from the latest provider refresh.";
const OMP_PARTIAL_USAGE_WARNING =
  "Some connected accounts were omitted from the latest usage refresh. Showing their last known usage.";

export interface CachedOmpAccountOverview {
  readonly schemaVersion: 1;
  readonly environmentId: EnvironmentId;
  readonly updatedAt: number;
  readonly overview: OmpAccountOverviewValue;
}

export interface OmpAccountOverviewCache {
  readonly get: (environmentId: EnvironmentId) => Promise<CachedOmpAccountOverview | null>;
  readonly put: (entry: CachedOmpAccountOverview) => Promise<void>;
}

function providerFamily(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (
    normalized.includes("openai") ||
    normalized.includes("chatgpt") ||
    normalized.includes("codex")
  ) {
    return "openai";
  }
  if (normalized.includes("anthropic") || normalized.includes("claude")) return "anthropic";
  return normalized;
}

function reportIdentity(report: OmpUsageReport): string {
  if (report.accountRef) return `account:${report.accountRef}`;
  return `provider:${providerFamily(report.provider)}:${report.maskedAccount ?? ""}`;
}

function accountMatchesReport(account: OmpAccountSummary, report: OmpUsageReport): boolean {
  if (report.accountRef) return account.accountRef === report.accountRef;
  if (providerFamily(account.provider) !== providerFamily(report.provider)) return false;
  if (!report.maskedAccount) return true;
  return (
    account.maskedEmail === report.maskedAccount || account.displayName === report.maskedAccount
  );
}

function markUsageReportRetained(report: OmpUsageReport): OmpUsageReport {
  return {
    ...report,
    notes: [...new Set([...(report.notes ?? []), OMP_RETAINED_USAGE_NOTE])],
  };
}

/**
 * Merge a successful but provider-partial refresh into the last browser snapshot.
 * The refreshed account list is authoritative for removals. Usage is not: OMP
 * can return one provider while another provider's usage probe is temporarily
 * unavailable, even though both accounts remain connected.
 */
export function mergeRefreshedOmpAccountOverview(input: {
  readonly previous: OmpAccountOverviewValue | null;
  readonly refreshed: OmpAccountOverviewValue;
}): OmpAccountOverviewValue {
  if (input.previous === null) return input.refreshed;

  const refreshedReportIds = new Set(input.refreshed.usage.reports.map(reportIdentity));
  const retainedReports = input.previous.usage.reports
    .filter(
      (report) =>
        !refreshedReportIds.has(reportIdentity(report)) &&
        input.refreshed.accounts.accounts.some((account) => accountMatchesReport(account, report)),
    )
    .map(markUsageReportRetained);

  if (retainedReports.length === 0) return input.refreshed;

  const warnings = [input.refreshed.usage.warning, OMP_PARTIAL_USAGE_WARNING].filter(
    (warning): warning is string => Boolean(warning),
  );
  return {
    accounts: input.refreshed.accounts,
    usage: {
      ...input.refreshed.usage,
      reports: [...input.refreshed.usage.reports, ...retainedReports],
      stale: true,
      warning: [...new Set(warnings)].join(" "),
    },
  };
}

const isOmpAccountOverview = Schema.is(OmpAccountOverview);

function containsCredentialMaterial(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsCredentialMaterial(entry, seen));
  }
  return Object.entries(value).some(
    ([key, entry]) =>
      FORBIDDEN_CREDENTIAL_KEYS.has(key.replaceAll(/[-_]/g, "").toLowerCase()) ||
      containsCredentialMaterial(entry, seen),
  );
}

export function isCachedOmpAccountOverview(value: unknown): value is CachedOmpAccountOverview {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<CachedOmpAccountOverview>;
  return (
    entry.schemaVersion === 1 &&
    typeof entry.environmentId === "string" &&
    entry.environmentId.length > 0 &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt) &&
    isOmpAccountOverview(entry.overview) &&
    !containsCredentialMaterial(entry.overview)
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this browser context."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "environmentId" });
      }
    });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Could not open the OMP account cache."));
    });
    request.addEventListener("success", () => resolve(request.result));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("The OMP account cache transaction was aborted.")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("The OMP account cache transaction failed.")),
    );
  });
}

export function createIndexedDbOmpAccountOverviewCache(): OmpAccountOverviewCache {
  return {
    async get(environmentId) {
      const database = await openDatabase();
      try {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const done = transactionDone(transaction);
        const request = transaction.objectStore(STORE_NAME).get(environmentId);
        const value = await new Promise<unknown>((resolve, reject) => {
          request.addEventListener("success", () => resolve(request.result));
          request.addEventListener("error", () =>
            reject(request.error ?? new Error("Could not read the OMP account cache.")),
          );
        });
        await done;
        return isCachedOmpAccountOverview(value) ? value : null;
      } finally {
        database.close();
      }
    },
    async put(entry) {
      if (!isCachedOmpAccountOverview(entry)) {
        throw new Error("Refusing to persist an invalid OMP account snapshot.");
      }
      const database = await openDatabase();
      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(STORE_NAME).put(entry);
        await done;
      } finally {
        database.close();
      }
    },
  };
}

export function createMemoryOmpAccountOverviewCache(
  initial: ReadonlyArray<CachedOmpAccountOverview> = [],
): OmpAccountOverviewCache {
  const entries = new Map(initial.map((entry) => [entry.environmentId, entry]));
  return {
    async get(environmentId) {
      return entries.get(environmentId) ?? null;
    },
    async put(entry) {
      if (!isCachedOmpAccountOverview(entry)) {
        throw new Error("Refusing to persist an invalid OMP account snapshot.");
      }
      entries.set(entry.environmentId, entry);
    },
  };
}

export const browserOmpAccountOverviewCache = createIndexedDbOmpAccountOverviewCache();

export async function cacheOmpAccountOverview(
  cache: OmpAccountOverviewCache,
  environmentId: EnvironmentId,
  overview: OmpAccountOverviewValue,
  updatedAt = Date.now(),
): Promise<void> {
  await cache.put({ schemaVersion: 1, environmentId, overview, updatedAt });
}
