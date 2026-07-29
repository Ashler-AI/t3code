import type {
  OmpAccountOverview,
  OmpLoginChallenge,
  OmpLoginSubmitResult,
  OmpUsageLimit,
  OmpUsageReport,
} from "@t3tools/contracts";

import { OMP_RETAINED_USAGE_NOTE } from "../connection/ompAccountOverviewCache";

export interface OmpLoginFlowActions {
  readonly openBrowser: (url: string, flowId: string, cancel: () => Promise<void>) => void;
  readonly requestInput: (challenge: OmpLoginChallenge) => string | null | Promise<string | null>;
  readonly respond: (flowId: string, response: string) => Promise<OmpLoginChallenge>;
  readonly submit: (flowId: string, response: string) => Promise<OmpLoginSubmitResult>;
  readonly getSubmitSupport: () => boolean | undefined;
  readonly setSubmitSupported: (supported: boolean) => void;
  readonly dismissInput: (flowId: string) => void;
  readonly cancel: (flowId: string) => Promise<void>;
}

export interface ActiveOmpLoginFlow {
  readonly environmentId: string;
  readonly provider: "openai" | "anthropic";
}

export interface OmpLoginBrowserWindow {
  readonly closed: boolean;
  opener: unknown;
  readonly location: Pick<Location, "replace">;
  close: () => void;
}

export interface PreparedOmpLoginBrowserWindow {
  readonly navigate: (url: string) => boolean;
  readonly waitUntilClosed: (signal: AbortSignal, pollIntervalMs?: number) => Promise<boolean>;
  readonly closeIfUnused: () => void;
}

export class InvalidOmpAuthorizationUrlError extends Error {
  override readonly name = "InvalidOmpAuthorizationUrlError";

  constructor() {
    super("The sign-in provider returned an unsafe authorization URL.");
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

/**
 * Authorization links may leave the app only over HTTPS, except for OAuth
 * callbacks hosted by a local CLI on the browser's own loopback interface.
 */
export function normalizeOmpAuthorizationUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol === "https:") return parsed.href;
  if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) return parsed.href;
  return null;
}

/**
 * Reserve a browser tab while the account action still has user activation.
 * The OMP authorization URL arrives only after an environment RPC, when a new
 * `window.open` may be blocked by the browser's popup policy.
 */
export function prepareOmpLoginBrowserWindow(
  openWindow: () => OmpLoginBrowserWindow | null,
): PreparedOmpLoginBrowserWindow {
  let popup: OmpLoginBrowserWindow | null;
  try {
    popup = openWindow();
  } catch {
    popup = null;
  }
  let navigated = false;
  if (popup !== null) {
    try {
      popup.opener = null;
    } catch {
      // A popup that retains its opener must never receive provider-controlled
      // navigation. The visible manual link remains available without it.
      try {
        popup.close();
      } catch {
        // The popup is still discarded locally even if the browser rejects close().
      }
      popup = null;
    }
  }

  return {
    navigate: (url) => {
      const authorizationUrl = normalizeOmpAuthorizationUrl(url);
      if (authorizationUrl === null || popup === null) return false;
      try {
        if (popup.closed) return false;
        popup.location.replace(authorizationUrl);
        navigated = true;
        return true;
      } catch {
        return false;
      }
    },
    waitUntilClosed: async (signal, pollIntervalMs = 250) => {
      if (!navigated || popup === null || signal.aborted) return false;
      while (!signal.aborted) {
        try {
          if (popup.closed) return true;
        } catch {
          // `Window.closed` is normally cross-origin safe. If a browser revokes
          // even that access, keep the OAuth flow alive and let its callback or
          // timeout remain authoritative.
          return false;
        }
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timeoutId);
            signal.removeEventListener("abort", finish);
            resolve();
          };
          const timeoutId = setTimeout(finish, Math.max(1, pollIntervalMs));
          signal.addEventListener("abort", finish, { once: true });
        });
      }
      return false;
    },
    closeIfUnused: () => {
      if (navigated || popup === null) return;
      try {
        if (popup.closed) return;
        popup.close();
      } catch {
        // The browser may revoke access after a user closes the reserved tab.
      } finally {
        popup = null;
      }
    },
  };
}

/**
 * Treat a closed provider window as presentation context only. Some embedded
 * browsers close a preopened tab after navigation even though the same flow can
 * still finish through the visible fallback link or manual code input.
 */
export async function observeOmpLoginBrowserWindowClose(
  browserWindow: PreparedOmpLoginBrowserWindow,
  signal: AbortSignal,
  onClosed: () => void,
  pollIntervalMs?: number,
): Promise<void> {
  if (await browserWindow.waitUntilClosed(signal, pollIntervalMs)) onClosed();
}

export function describeOmpLoginTerminalFailure(input: {
  readonly message: string | undefined;
  readonly browserWindowClosed: boolean;
}): string {
  const message = input.message?.trim();
  if (input.browserWindowClosed && (!message || message === "Login did not complete.")) {
    return "The sign-in window closed before login completed. Start sign-in again.";
  }
  return message || "Existing accounts are unchanged.";
}

export const OMP_REJECTED_SUBMIT_POLL_TIMEOUT_MS = 10_000;

export class OmpRejectedSubmitPollTimeoutError extends Error {
  override readonly name = "OmpRejectedSubmitPollTimeoutError";

  constructor() {
    super("Sign-in response was not accepted before the authorization callback completed.");
  }
}

async function awaitRejectedSubmitTerminalPoll(
  poll: Promise<OmpLoginChallenge>,
  timeoutMs: number,
): Promise<OmpLoginChallenge> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new OmpRejectedSubmitPollTimeoutError()), timeoutMs);
  });
  try {
    const challenge = await Promise.race([poll, timeout]);
    if (challenge.kind !== "complete") {
      throw new Error("Sign-in response was not accepted before the authorization flow completed.");
    }
    return challenge;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export function reserveOmpLoginFlow(
  active: ActiveOmpLoginFlow | null,
  requested: ActiveOmpLoginFlow,
): { readonly active: ActiveOmpLoginFlow; readonly acquired: boolean } {
  return active === null ? { active: requested, acquired: true } : { active, acquired: false };
}

export function reconcileOmpLoginSubmitSupport(
  supportByEnvironment: ReadonlyMap<string, boolean>,
  previousScopeByEnvironment: ReadonlyMap<string, string>,
  currentScopes: ReadonlyArray<{ readonly environmentId: string; readonly scope: string }>,
): {
  readonly supportByEnvironment: ReadonlyMap<string, boolean>;
  readonly scopeByEnvironment: ReadonlyMap<string, string>;
} {
  const nextSupport = new Map<string, boolean>();
  const nextScopes = new Map<string, string>();
  for (const current of currentScopes) {
    nextScopes.set(current.environmentId, current.scope);
    if (previousScopeByEnvironment.get(current.environmentId) !== current.scope) continue;
    const support = supportByEnvironment.get(current.environmentId);
    if (support !== undefined) nextSupport.set(current.environmentId, support);
  }
  return { supportByEnvironment: nextSupport, scopeByEnvironment: nextScopes };
}

export function throwOmpLoginCancelFailure<TFailure>(
  result: { readonly _tag: "Success" } | ({ readonly _tag: "Failure" } & TFailure),
  squashFailure: (failure: { readonly _tag: "Failure" } & TFailure) => unknown,
): void {
  if (result._tag === "Failure") throw squashFailure(result);
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
  rejectedSubmitPollTimeoutMs = OMP_REJECTED_SUBMIT_POLL_TIMEOUT_MS,
): Promise<OmpLoginChallenge | null> {
  let challenge = initialChallenge;
  const openedUrls = new Set<string>();
  const cancellationsByFlowId = new Map<string, Promise<void>>();
  const cancelOnce = async (flowId: string): Promise<void> => {
    const existing = cancellationsByFlowId.get(flowId);
    if (existing !== undefined) return await existing;
    const cancellation = Promise.resolve().then(() => actions.cancel(flowId));
    cancellationsByFlowId.set(flowId, cancellation);
    return await cancellation;
  };
  const cancelWithoutMasking = async (flowId: string, error: unknown): Promise<never> => {
    try {
      await cancelOnce(flowId);
    } catch {
      // Preserve the submit/poll failure that made the flow unusable.
    }
    throw error;
  };
  for (let step = 0; step < maxSteps && challenge.kind !== "complete"; step += 1) {
    if (challenge.url) {
      const authorizationUrl = normalizeOmpAuthorizationUrl(challenge.url);
      if (authorizationUrl === null) {
        return await cancelWithoutMasking(challenge.flowId, new InvalidOmpAuthorizationUrlError());
      }
      if (!openedUrls.has(authorizationUrl)) {
        openedUrls.add(authorizationUrl);
        actions.openBrowser(authorizationUrl, challenge.flowId, () => cancelOnce(challenge.flowId));
      }
    }
    if (challenge.kind === "browser") {
      try {
        challenge = await actions.respond(challenge.flowId, "");
      } catch (error) {
        return await cancelWithoutMasking(challenge.flowId, error);
      }
      continue;
    }

    const flowId = challenge.flowId;
    let submitSupport = actions.getSubmitSupport();
    if (submitSupport === undefined) {
      try {
        const probe = await actions.submit(flowId, "");
        submitSupport = probe.supported;
        actions.setSubmitSupported(probe.supported);
      } catch (error) {
        return await cancelWithoutMasking(flowId, error);
      }
    }
    if (submitSupport !== true) {
      const response = await actions.requestInput(challenge);
      if (response === null) {
        await cancelOnce(flowId);
        return null;
      }

      if (submitSupport === false) {
        try {
          challenge = await actions.respond(flowId, response);
        } catch (error) {
          return await cancelWithoutMasking(flowId, error);
        }
        continue;
      }

      try {
        challenge = await actions.respond(flowId, response);
      } catch (error) {
        return await cancelWithoutMasking(flowId, error);
      }
      continue;
    }

    const nextChallenge = actions.respond(flowId, "");
    const input = Promise.resolve().then(() => actions.requestInput(challenge));
    let winner:
      | { readonly _tag: "Remote"; readonly next: OmpLoginChallenge }
      | { readonly _tag: "Local"; readonly response: string | null };
    try {
      winner = await Promise.race([
        nextChallenge.then((next) => ({ _tag: "Remote" as const, next })),
        input.then((response) => ({ _tag: "Local" as const, response })),
      ]);
    } catch (error) {
      actions.dismissInput(flowId);
      void nextChallenge.catch(() => undefined);
      void input.catch(() => undefined);
      return await cancelWithoutMasking(flowId, error);
    }
    if (winner._tag === "Remote") {
      actions.dismissInput(flowId);
      challenge = winner.next;
      continue;
    }
    if (winner.response === null) {
      await cancelOnce(flowId);
      void nextChallenge.catch(() => undefined);
      return null;
    }
    try {
      const submission = await actions.submit(flowId, winner.response);
      if (!submission.supported) {
        throw new Error("OMP login submit support changed during an active login flow.");
      }
      if (!submission.accepted) {
        // A browser callback can consume the flow just before the pasted code
        // arrives. The already-running response request is authoritative, so
        // give it a bounded window to report the terminal outcome.
        challenge = await awaitRejectedSubmitTerminalPoll(
          nextChallenge,
          rejectedSubmitPollTimeoutMs,
        );
        continue;
      }
    } catch (error) {
      void nextChallenge.catch(() => undefined);
      return await cancelWithoutMasking(flowId, error);
    }
    try {
      challenge = await nextChallenge;
    } catch (error) {
      return await cancelWithoutMasking(flowId, error);
    }
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
  readonly disabled: boolean;
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
  readonly hasEnvironment: boolean;
  readonly hasActiveTurn: boolean;
  readonly hasActiveLogin?: boolean;
}): OmpLoginActionPresentation {
  return {
    disabled: !input.hasEnvironment || input.hasActiveLogin === true,
    description: !input.hasEnvironment
      ? "Connect to a local T3 environment to manage accounts"
      : input.hasActiveLogin === true
        ? "Another account sign-in is already in progress"
        : input.hasActiveTurn
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
  const reportRows = reports.flatMap((report, reportIndex) => {
    const stale = report.notes?.includes(OMP_RETAINED_USAGE_NOTE) ?? false;
    const reportKey = report.accountRef ?? report.maskedAccount ?? reportIndex;
    const resetCreditRows =
      report.resetCredits && report.resetCredits.availableCount > 0
        ? [
            {
              key: `${reportKey}:reset-credits`,
              title: `${providerDisplayName(report.provider)} · Saved resets`,
              description: [
                report.maskedAccount,
                `${report.resetCredits.availableCount.toLocaleString()} available`,
                stale ? "Last known" : null,
              ]
                .filter(Boolean)
                .join(" · "),
              stale,
            },
          ]
        : [];
    const limitRows = report.limits.filter(isVisibleOmpUsageLimit).map((limit) => ({
      key: `${report.accountRef ?? report.maskedAccount ?? reportIndex}:${limit.id}`,
      title: `${providerDisplayName(report.provider)} · ${limit.label}`,
      description: [report.maskedAccount, formatOmpUsageAmount(limit), stale ? "Last known" : null]
        .filter(Boolean)
        .join(" · "),
      stale,
    }));
    return [...resetCreditRows, ...limitRows];
  });
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
            (report.limits.some(isVisibleOmpUsageLimit) ||
              (report.resetCredits?.availableCount ?? 0) > 0),
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
