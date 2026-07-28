import {
  OmpAccountRef,
  type OmpAccountAssignment,
  type OmpAccountAuthKind,
  type OmpAccountReassignmentReason,
  type OmpAccountState,
  type OmpAccountSummary,
  type OmpLoginChallenge,
  type OmpUsageAmount,
  type OmpUsageLimit,
  type OmpUsageReport,
  type OmpUsageResetCredits,
  type OmpUsageSnapshot,
  type OmpUsageStatus,
  type OmpUsageUnit,
  type ThreadId,
} from "@t3tools/contracts";

type UnknownRecord = Record<string, unknown>;

const usageUnits = new Set<OmpUsageUnit>([
  "percent",
  "tokens",
  "requests",
  "usd",
  "minutes",
  "bytes",
  "unknown",
]);
const usageStatuses = new Set<OmpUsageStatus>(["ok", "warning", "exhausted", "unknown"]);
const accountStates = new Set<OmpAccountState>(["available", "limited", "unavailable", "unknown"]);
const reassignmentReasons = new Set<OmpAccountReassignmentReason>([
  "initial-assignment",
  "load-balanced",
  "usage-limited",
  "quota-exhausted",
  "account-unavailable",
  "broker-policy",
  "unknown",
]);

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalNumber(target: Record<string, unknown>, key: string, value: unknown): void {
  const number = asFiniteNumber(value);
  if (number !== undefined) target[key] = number;
}

function stringArray(value: unknown): Array<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.flatMap((entry) => {
    const text = asString(entry);
    return text ? [text] : [];
  });
  return values.length > 0 ? values : undefined;
}

export function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return "••••";
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length === 1) return `${local}***@${domain}`;
  if (local.length === 2) return `${local[0]}***${local[1]}@${domain}`;
  return `${local.slice(0, 2)}***${local.slice(-2)}@${domain}`;
}

function parseAccountRef(value: unknown): OmpAccountRef | undefined {
  const ref = asString(value);
  // The extension must mint an opaque alias. Numeric/database ids are never
  // accepted as client-visible account handles.
  return ref?.startsWith("acct_") ? OmpAccountRef.make(ref) : undefined;
}

function parseAuthKind(value: unknown, managed: boolean): OmpAccountAuthKind {
  if (managed) return "managed";
  if (value === "oauth") return "oauth";
  if (value === "api-key" || value === "api_key") return "api-key";
  return "oauth";
}

export function parseOmpAccountSummary(
  value: unknown,
  options?: { readonly managed?: boolean },
): OmpAccountSummary | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const accountRef = parseAccountRef(record.accountRef);
  const provider = asString(record.provider);
  if (!accountRef || !provider) return undefined;

  const managed = options?.managed ?? record.managed === true;
  const rawEmail = asString(record.maskedEmail) ?? asString(record.email);
  const maskedEmail = rawEmail?.includes("***")
    ? rawEmail
    : rawEmail
      ? maskEmail(rawEmail)
      : undefined;
  const rawDisplayName = asString(record.displayName) ?? asString(record.label);
  const displayName =
    rawDisplayName && rawDisplayName.includes("@")
      ? maskEmail(rawDisplayName)
      : (rawDisplayName ?? maskedEmail ?? provider);
  const rawState = asString(record.state);
  const state =
    rawState && accountStates.has(rawState as OmpAccountState)
      ? (rawState as OmpAccountState)
      : "unknown";
  const organization = asString(record.organizationName) ?? asString(record.orgName);

  return {
    accountRef,
    provider,
    authKind: parseAuthKind(record.authKind ?? record.type, managed),
    displayName,
    ...(maskedEmail ? { maskedEmail } : {}),
    ...(organization ? { organization } : {}),
    state,
    managed,
  };
}

export function parseOmpAccountsList(
  value: unknown,
  options?: { readonly managed?: boolean },
): ReadonlyArray<OmpAccountSummary> | undefined {
  const record = asRecord(value);
  const rawAccounts = Array.isArray(value) ? value : record?.accounts;
  if (!Array.isArray(rawAccounts)) return undefined;
  return rawAccounts.flatMap((entry) => {
    const account = parseOmpAccountSummary(entry, options);
    return account ? [account] : [];
  });
}

function parseUsageAmount(value: unknown): OmpUsageAmount | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const rawUnit = asString(record.unit) ?? "unknown";
  const unit = usageUnits.has(rawUnit as OmpUsageUnit) ? (rawUnit as OmpUsageUnit) : "unknown";
  const amount: Record<string, unknown> = { unit };
  optionalNumber(amount, "used", record.used);
  optionalNumber(amount, "limit", record.limit);
  optionalNumber(amount, "remaining", record.remaining);
  optionalNumber(amount, "usedFraction", record.usedFraction);
  optionalNumber(amount, "remainingFraction", record.remainingFraction);
  return amount as OmpUsageAmount;
}

function parseUsageLimit(value: unknown, fallbackProvider: string): OmpUsageLimit | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const id = asString(record.id);
  const label = asString(record.label);
  const amount = parseUsageAmount(record.amount);
  if (!id || !label || !amount) return undefined;
  // ChatGPT's Spark allowance is a model-tier pseudo-quota, not a separate
  // subscription/account quota. Ashler intentionally hides it.
  if (id.toLowerCase().includes(":spark:") || label.toLowerCase().includes("(spark)")) {
    return undefined;
  }

  const rawScope = asRecord(record.scope);
  const provider = asString(rawScope?.provider) ?? fallbackProvider;
  const scope: Record<string, unknown> = { provider };
  const modelId = asString(rawScope?.modelId);
  const tier = asString(rawScope?.tier);
  const windowId = asString(rawScope?.windowId);
  if (modelId) scope.modelId = modelId;
  if (tier) scope.tier = tier;
  if (windowId) scope.windowId = windowId;
  if (typeof rawScope?.shared === "boolean") scope.shared = rawScope.shared;

  const rawWindow = asRecord(record.window);
  const windowIdValue = asString(rawWindow?.id);
  const windowLabel = asString(rawWindow?.label);
  const window: Record<string, unknown> | undefined =
    windowIdValue && windowLabel ? { id: windowIdValue, label: windowLabel } : undefined;
  if (window) {
    optionalNumber(window, "durationMs", rawWindow?.durationMs);
    optionalNumber(window, "resetsAt", rawWindow?.resetsAt);
  }
  const rawStatus = asString(record.status);
  const status =
    rawStatus && usageStatuses.has(rawStatus as OmpUsageStatus)
      ? (rawStatus as OmpUsageStatus)
      : undefined;
  const notes = stringArray(record.notes);

  return {
    id,
    label,
    scope: scope as OmpUsageLimit["scope"],
    ...(window ? { window: window as NonNullable<OmpUsageLimit["window"]> } : {}),
    amount,
    ...(status ? { status } : {}),
    ...(notes ? { notes } : {}),
  };
}

function parseUsageReport(value: unknown): OmpUsageReport | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const provider = asString(record.provider);
  const fetchedAt = asFiniteNumber(record.fetchedAt);
  if (!provider || fetchedAt === undefined || !Array.isArray(record.limits)) return undefined;
  const limits = record.limits.flatMap((entry) => {
    const limit = parseUsageLimit(entry, provider);
    return limit ? [limit] : [];
  });
  const accountRef = parseAccountRef(record.accountRef);
  const metadata = asRecord(record.metadata);
  const rawAccount =
    asString(record.maskedAccount) ?? asString(record.email) ?? asString(metadata?.email);
  const maskedAccount =
    rawAccount?.includes("@") && !rawAccount.includes("***") ? maskEmail(rawAccount) : rawAccount;
  const resetCredits = parseUsageResetCredits(record.resetCredits);
  const notes = stringArray(record.notes);
  return {
    provider,
    ...(accountRef ? { accountRef } : {}),
    ...(maskedAccount ? { maskedAccount } : {}),
    fetchedAt,
    limits,
    ...(resetCredits ? { resetCredits } : {}),
    ...(notes ? { notes } : {}),
  };
}

function parseUsageResetCredits(value: unknown): OmpUsageResetCredits | undefined {
  const record = asRecord(value);
  const availableCount = asFiniteNumber(record?.availableCount);
  if (!record || availableCount === undefined) return undefined;

  const credits = Array.isArray(record.credits)
    ? record.credits.flatMap((entry) => {
        const credit = asRecord(entry);
        if (!credit) return [];
        const grantedAt = asString(credit.grantedAt);
        const expiresAt = asString(credit.expiresAt);
        const status = asString(credit.status);
        return [
          {
            ...(grantedAt ? { grantedAt } : {}),
            ...(expiresAt ? { expiresAt } : {}),
            ...(status ? { status } : {}),
          },
        ];
      })
    : undefined;

  return {
    availableCount,
    ...(credits ? { credits } : {}),
  };
}

export function parseOmpUsageResponse(value: unknown): OmpUsageSnapshot | undefined {
  const record = asRecord(value);
  const rawReports = Array.isArray(value) ? value : record?.reports;
  if (!Array.isArray(rawReports)) return undefined;
  const reports = rawReports.flatMap((entry) => {
    const report = parseUsageReport(entry);
    return report ? [report] : [];
  });
  const refreshedAt =
    asFiniteNumber(record?.refreshedAt) ??
    reports.reduce<number | null>(
      (latest, report) =>
        latest === null || report.fetchedAt > latest ? report.fetchedAt : latest,
      null,
    );
  return { reports, refreshedAt, stale: false, warning: null };
}

export function parseOmpAccountAssignment(
  value: unknown,
  threadId: ThreadId,
  options?: { readonly managed?: boolean },
): OmpAccountAssignment | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const rawReason = asString(record.reassignmentReason) ?? asString(record.reason);
  const reassignmentReason =
    rawReason && reassignmentReasons.has(rawReason as OmpAccountReassignmentReason)
      ? (rawReason as OmpAccountReassignmentReason)
      : undefined;
  const accountValue = "account" in record ? record.account : record.assignment;
  if (accountValue === null) {
    return {
      threadId,
      account: null,
      automatic: true,
      ...(reassignmentReason ? { reassignmentReason } : {}),
    };
  }
  const account = parseOmpAccountSummary(accountValue, options);
  return account
    ? {
        threadId,
        account,
        automatic: true,
        ...(reassignmentReason ? { reassignmentReason } : {}),
      }
    : undefined;
}

export function parseOmpLoginChallenge(
  value: unknown,
  provider: string,
): OmpLoginChallenge | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const flowId = asString(record.flowId);
  const rawKind = asString(record.kind) ?? asString(record.status);
  const kind =
    rawKind === "code"
      ? "input"
      : rawKind === "browser" || rawKind === "input" || rawKind === "complete"
        ? rawKind
        : undefined;
  if (!flowId || !kind) return undefined;
  const rawMaskedAccount = asString(record.maskedAccount) ?? asString(record.email);
  const maskedAccount =
    rawMaskedAccount?.includes("@") && !rawMaskedAccount.includes("***")
      ? maskEmail(rawMaskedAccount)
      : rawMaskedAccount;
  const url = asString(record.url);
  const message = asString(record.message);
  const prompt = asString(record.prompt);
  const inputType =
    kind === "input" && (rawKind === "code" || record.inputType === "code") ? "code" : undefined;
  const expiresAt = asFiniteNumber(record.expiresAt);
  const outcome =
    record.outcome === "success" || record.outcome === "failure" ? record.outcome : undefined;
  return {
    flowId,
    provider,
    kind,
    ...(inputType ? { inputType } : {}),
    ...(url ? { url } : {}),
    ...(message ? { message } : {}),
    ...(prompt ? { prompt } : {}),
    ...(maskedAccount ? { maskedAccount } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(outcome ? { outcome } : {}),
  };
}
