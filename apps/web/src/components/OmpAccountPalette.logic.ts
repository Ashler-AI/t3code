import type {
  OmpAccountOverview,
  OmpLoginChallenge,
  OmpUsageLimit,
  OmpUsageReport,
} from "@t3tools/contracts";

import { OMP_RETAINED_USAGE_NOTE } from "../connection/ompAccountOverviewCache";

export interface OmpLoginFlowActions {
  readonly openBrowser: (url: string) => void;
  readonly requestInput: (challenge: OmpLoginChallenge) => string | null | Promise<string | null>;
  readonly respond: (flowId: string, response: string) => Promise<OmpLoginChallenge>;
  readonly cancel: (flowId: string) => Promise<void>;
}

/**
 * Drive OMP's asynchronous login handshake without tying callback completion
 * to the command palette lifetime. Browser challenges are acknowledged with an
 * empty response; OMP holds that request until OAuth completes or another
 * challenge is available.
 */
export async function completeOmpLoginFlow(
  initialChallenge: OmpLoginChallenge,
  actions: OmpLoginFlowActions,
  maxSteps = 16,
): Promise<OmpLoginChallenge | null> {
  let challenge = initialChallenge;
  const openedUrls = new Set<string>();
  for (let step = 0; step < maxSteps && challenge.kind !== "complete"; step += 1) {
    if (challenge.url && !openedUrls.has(challenge.url)) {
      openedUrls.add(challenge.url);
      actions.openBrowser(challenge.url);
    }
    if (challenge.kind === "browser") {
      challenge = await actions.respond(challenge.flowId, "");
      continue;
    }
    const response = await actions.requestInput(challenge);
    if (response === null) {
      await actions.cancel(challenge.flowId);
      return null;
    }
    challenge = await actions.respond(challenge.flowId, response);
  }
  return challenge;
}

export function normalizeOmpLoginChallengeResponse(value: string): string | null {
  const response = value.trim();
  return response.length > 0 ? response : null;
}

export function ompLoginChallengeExpiryDelay(
  challenge: OmpLoginChallenge,
  now = Date.now(),
): number | null {
  if (challenge.expiresAt === undefined) return null;
  return Math.max(0, challenge.expiresAt - now);
}

export function describeOmpLoginFailure(error: unknown): string | undefined {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? message : undefined;
  }
  if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ["detail", "message", "reason"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export interface OmpUsageDisplayRow {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly stale: boolean;
}

export interface OmpOverviewStatusPresentation {
  readonly freshnessTitle: string;
  readonly freshnessDescription: string;
  readonly warning: string | null;
}

export interface OmpLoginActionPresentation {
  readonly disabled: false;
  readonly description: string;
}

export interface OmpOverviewRefreshFailureState {
  readonly overview: OmpAccountOverview | null;
  readonly cachedAt: number | null;
  readonly refreshWarning: string;
}

function timestampMs(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  // OMP implementations in the wild report both Unix seconds and milliseconds.
  return value < 100_000_000_000 ? value * 1_000 : value;
}

function relativeAge(timestamp: number, now: number): string {
  const elapsedMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function buildOmpOverviewStatusPresentation(input: {
  readonly overview: OmpAccountOverview;
  readonly cachedAt: number | null;
  readonly refreshWarning: string | null;
  readonly now?: number;
}): OmpOverviewStatusPresentation {
  const refreshedAt = timestampMs(input.overview.usage.refreshedAt);
  const cachedAt = timestampMs(input.cachedAt);
  const displayedAt = refreshedAt ?? cachedAt;
  const now = input.now ?? Date.now();
  const freshnessTitle = displayedAt
    ? `${refreshedAt ? "Last refreshed" : "Cached"} ${relativeAge(displayedAt, now)}`
    : "No refresh timestamp available";
  const freshnessDescription = refreshedAt
    ? "Account and plan usage snapshot"
    : "Cached account and plan usage snapshot";
  const warnings = [
    input.refreshWarning,
    input.overview.accounts.warning,
    input.overview.usage.warning,
    input.overview.usage.stale && !input.overview.usage.warning
      ? "Plan usage may be out of date."
      : null,
  ].filter((warning): warning is string => Boolean(warning?.trim()));

  return {
    freshnessTitle,
    freshnessDescription,
    warning: [...new Set(warnings)].join(" ") || null,
  };
}

/** Account-pool mutations never alter the account already bound to a live turn. */
export function getOmpLoginActionPresentation(input: {
  readonly hasActiveTurn: boolean;
}): OmpLoginActionPresentation {
  return {
    disabled: false,
    description: input.hasActiveTurn
      ? "For future sessions · This turn keeps its account"
      : "Available for future sessions",
  };
}

export function preserveOmpOverviewAfterRefreshFailure(input: {
  readonly overview: OmpAccountOverview | null;
  readonly cachedAt: number | null;
  readonly warning: string;
}): OmpOverviewRefreshFailureState {
  return {
    overview: input.overview,
    cachedAt: input.cachedAt,
    refreshWarning: input.warning,
  };
}

export function providerDisplayName(provider: string): string {
  const normalized = provider.toLowerCase();
  if (
    normalized.includes("openai") ||
    normalized.includes("chatgpt") ||
    normalized.includes("codex")
  ) {
    return "ChatGPT";
  }
  if (normalized.includes("anthropic") || normalized.includes("claude")) return "Claude";
  return provider;
}

export interface OmpAccountRowPresentation {
  readonly connected: boolean;
  readonly title: string;
  readonly description: string;
}

export function buildOmpAccountRowPresentation(
  account: OmpAccountOverview["accounts"]["accounts"][number],
): OmpAccountRowPresentation {
  const provider = providerDisplayName(account.provider);
  const identity = account.maskedEmail ?? account.displayName;
  if (account.state === "unavailable") {
    return {
      connected: false,
      title: `${provider} needs reconnecting`,
      description: `${identity} · Not connected`,
    };
  }
  return { connected: true, title: identity, description: provider };
}

export function isVisibleOmpUsageLimit(limit: OmpUsageLimit): boolean {
  return !`${limit.label} ${limit.scope.tier ?? ""}`.toLowerCase().includes("spark");
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatOmpUsageAmount(limit: OmpUsageLimit): string {
  const amount = limit.amount;
  if (amount.remainingFraction !== undefined) {
    return `${percent(amount.remainingFraction)} remaining`;
  }
  if (amount.usedFraction !== undefined) {
    return `${percent(amount.usedFraction)} used`;
  }
  if (amount.remaining !== undefined && amount.limit !== undefined) {
    return `${amount.remaining.toLocaleString()} of ${amount.limit.toLocaleString()} remaining`;
  }
  if (amount.used !== undefined && amount.limit !== undefined) {
    return `${amount.used.toLocaleString()} of ${amount.limit.toLocaleString()} used`;
  }
  if (amount.remaining !== undefined) return `${amount.remaining.toLocaleString()} remaining`;
  if (amount.used !== undefined) return `${amount.used.toLocaleString()} used`;
  return "Usage available";
}

export function buildOmpUsageDisplayRows(
  reports: ReadonlyArray<OmpUsageReport>,
  accounts: ReadonlyArray<OmpAccountOverview["accounts"]["accounts"][number]> = [],
): OmpUsageDisplayRow[] {
  const reportRows = reports.flatMap((report, reportIndex) =>
    report.limits.filter(isVisibleOmpUsageLimit).map((limit) => {
      const stale = report.notes?.includes(OMP_RETAINED_USAGE_NOTE) ?? false;
      return {
        key: `${report.accountRef ?? report.maskedAccount ?? reportIndex}:${limit.id}`,
        title: `${providerDisplayName(report.provider)} · ${limit.label}`,
        description: [
          report.maskedAccount,
          formatOmpUsageAmount(limit),
          stale ? "Last known" : null,
        ]
          .filter(Boolean)
          .join(" · "),
        stale,
      };
    }),
  );
  const missingAccountRows = accounts
    .filter((account) => account.state !== "unavailable")
    .filter(
      (account) =>
        !reports.some(
          (report) =>
            (report.accountRef === account.accountRef ||
              (report.provider === account.provider &&
                report.maskedAccount !== undefined &&
                (report.maskedAccount === account.maskedEmail ||
                  report.maskedAccount === account.displayName))) &&
            report.limits.some(isVisibleOmpUsageLimit),
        ),
    )
    .map((account) => ({
      key: `${account.accountRef}:unavailable`,
      title: `${providerDisplayName(account.provider)} · ${account.maskedEmail ?? account.displayName}`,
      description: "Usage unavailable",
      stale: true,
    }));
  return [...reportRows, ...missingAccountRows];
}
