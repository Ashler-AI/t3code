import { OmpAccountRef, type OmpLoginChallenge } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildOmpAccountRowPresentation,
  buildOmpOverviewStatusPresentation,
  buildOmpUsageDisplayRows,
  completeOmpLoginFlow,
  describeOmpLoginFailure,
  formatOmpUsageAmount,
  getOmpLoginActionPresentation,
  normalizeOmpLoginChallengeResponse,
  ompLoginChallengeExpiryDelay,
  preserveOmpOverviewAfterRefreshFailure,
  providerDisplayName,
} from "./OmpAccountPalette.logic";

describe("OMP account palette presentation", () => {
  it("polls a browser OAuth challenge until OMP reports its terminal outcome", async () => {
    const opened: string[] = [];
    const responses: string[] = [];
    const result = await completeOmpLoginFlow(
      {
        flowId: "login_123",
        provider: "anthropic",
        kind: "browser",
        url: "https://example.test/oauth",
      },
      {
        openBrowser: (url) => opened.push(url),
        requestInput: () => null,
        respond: async (_flowId, response) => {
          responses.push(response);
          return {
            flowId: "login_123",
            provider: "anthropic",
            kind: "complete",
            outcome: "success",
          };
        },
        cancel: async () => undefined,
      },
    );

    expect(opened).toEqual(["https://example.test/oauth"]);
    expect(responses).toEqual([""]);
    expect(result?.outcome).toBe("success");
  });

  it("awaits an in-app code challenge and supports cancellation", async () => {
    const responses: string[] = [];
    const requestedKinds: string[] = [];
    const completed = await completeOmpLoginFlow(
      {
        flowId: "login_code",
        provider: "anthropic",
        kind: "code",
        prompt: "Paste the authorization code.",
      },
      {
        openBrowser: () => undefined,
        requestInput: async (challenge) => {
          requestedKinds.push(challenge.kind);
          return "  claude-code-123  ";
        },
        respond: async (_flowId, response) => {
          responses.push(response);
          return {
            flowId: "login_code",
            provider: "anthropic",
            kind: "complete",
            outcome: "success",
          };
        },
        cancel: async () => undefined,
      },
    );
    let cancelled = false;
    const canceled = await completeOmpLoginFlow(
      { flowId: "login_cancel", provider: "anthropic", kind: "input" },
      {
        openBrowser: () => undefined,
        requestInput: async () => null,
        respond: async () => {
          throw new Error("respond must not run after cancellation");
        },
        cancel: async () => {
          cancelled = true;
        },
      },
    );

    expect(requestedKinds).toEqual(["code"]);
    expect(responses).toEqual(["  claude-code-123  "]);
    expect(completed?.outcome).toBe("success");
    expect(canceled).toBeNull();
    expect(cancelled).toBe(true);
  });

  it("normalizes challenge input and extracts structured failures", () => {
    expect(normalizeOmpLoginChallengeResponse("  callback-code  ")).toBe("callback-code");
    expect(normalizeOmpLoginChallengeResponse("   ")).toBeNull();
    expect(describeOmpLoginFailure({ detail: "Authorization code expired." })).toBe(
      "Authorization code expired.",
    );
    expect(describeOmpLoginFailure({ reason: "request-failed" })).toBe("request-failed");
    expect(describeOmpLoginFailure({ cause: { token: "secret" } })).toBeUndefined();
  });

  it("derives a bounded delay for expiring login input panels", () => {
    const challenge: OmpLoginChallenge = {
      flowId: "login_expiry",
      provider: "anthropic",
      kind: "input",
      expiresAt: 12_000,
    };

    expect(ompLoginChallengeExpiryDelay(challenge, 10_000)).toBe(2_000);
    expect(ompLoginChallengeExpiryDelay(challenge, 15_000)).toBe(0);
    expect(
      ompLoginChallengeExpiryDelay(
        { flowId: challenge.flowId, provider: challenge.provider, kind: challenge.kind },
        10_000,
      ),
    ).toBeNull();
  });

  it("filters the ChatGPT Spark quota while keeping other account windows", () => {
    const rows = buildOmpUsageDisplayRows([
      {
        provider: "openai",
        maskedAccount: "ch***@example.com",
        fetchedAt: 1,
        limits: [
          {
            id: "weekly",
            label: "7-day quota",
            scope: { provider: "openai" },
            amount: { remainingFraction: 0.42, unit: "percent" },
          },
          {
            id: "spark",
            label: "7 days (Spark)",
            scope: { provider: "openai", tier: "Spark" },
            amount: { remainingFraction: 1, unit: "percent" },
          },
        ],
      },
    ]);

    expect(rows).toEqual([
      {
        key: "ch***@example.com:weekly",
        title: "ChatGPT · 7-day quota",
        description: "ch***@example.com · 42% remaining",
        stale: false,
      },
    ]);
  });

  it("labels retained provider usage as last known", () => {
    const rows = buildOmpUsageDisplayRows([
      {
        provider: "anthropic-claude",
        maskedAccount: "cl***de@example.com",
        fetchedAt: 1,
        limits: [
          {
            id: "weekly",
            label: "Weekly quota",
            scope: { provider: "anthropic-claude" },
            amount: { remainingFraction: 0.6, unit: "percent" },
          },
        ],
        notes: ["Last known usage; this account was omitted from the latest provider refresh."],
      },
    ]);

    expect(rows).toEqual([
      {
        key: "cl***de@example.com:weekly",
        title: "Claude · Weekly quota",
        description: "cl***de@example.com · 60% remaining · Last known",
        stale: true,
      },
    ]);
  });

  it("shows a concise unavailable row for a connected account omitted from usage refresh", () => {
    const rows = buildOmpUsageDisplayRows(
      [
        {
          provider: "openai-codex",
          accountRef: OmpAccountRef.make("acct_openai_first"),
          maskedAccount: "fi***st@example.com",
          fetchedAt: 1,
          limits: [],
        },
      ],
      [
        {
          accountRef: OmpAccountRef.make("acct_openai_first"),
          provider: "openai-codex",
          authKind: "oauth",
          displayName: "fi***st@example.com",
          maskedEmail: "fi***st@example.com",
          state: "available",
          managed: false,
        },
        {
          accountRef: OmpAccountRef.make("acct_openai_second"),
          provider: "openai-codex",
          authKind: "oauth",
          displayName: "se***nd@example.com",
          maskedEmail: "se***nd@example.com",
          state: "available",
          managed: false,
        },
        {
          accountRef: OmpAccountRef.make("acct_claude_disabled"),
          provider: "anthropic",
          authKind: "oauth",
          displayName: "cl***de@example.com",
          maskedEmail: "cl***de@example.com",
          state: "unavailable",
          managed: false,
        },
      ],
    );

    expect(rows).toEqual([
      {
        key: "acct_openai_first:unavailable",
        title: "ChatGPT · fi***st@example.com",
        description: "Usage unavailable",
        stale: true,
      },
      {
        key: "acct_openai_second:unavailable",
        title: "ChatGPT · se***nd@example.com",
        description: "Usage unavailable",
        stale: true,
      },
    ]);
  });

  it("formats absolute usage when a provider does not report a percentage", () => {
    expect(
      formatOmpUsageAmount({
        id: "tokens",
        label: "Tokens",
        scope: { provider: "bifrost" },
        amount: { used: 1_250, limit: 10_000, unit: "tokens" },
      }),
    ).toBe("1,250 of 10,000 used");
  });

  it("uses subscription product names for OMP provider aliases", () => {
    expect(providerDisplayName("openai-codex")).toBe("ChatGPT");
    expect(providerDisplayName("anthropic-claude")).toBe("Claude");
  });

  it("shows the cached snapshot age and keeps refresh warnings persistent", () => {
    const now = Date.UTC(2026, 6, 24, 12, 10);
    const presentation = buildOmpOverviewStatusPresentation({
      overview: {
        accounts: {
          mode: "local",
          managed: false,
          accounts: [],
          capabilities: {
            accounts: true,
            login: true,
            remove: true,
            assignment: true,
            usage: true,
          },
          warning: "Account eligibility could not be refreshed.",
        },
        usage: {
          reports: [],
          refreshedAt: Date.UTC(2026, 6, 24, 12, 5),
          stale: true,
          warning: "Showing the last cached usage result.",
        },
      },
      cachedAt: Date.UTC(2026, 6, 24, 12, 6),
      refreshWarning: "The environment is offline.",
      now,
    });

    expect(presentation).toEqual({
      freshnessTitle: "Last refreshed 5m ago",
      freshnessDescription: "Account and plan usage snapshot",
      warning:
        "The environment is offline. Account eligibility could not be refreshed. Showing the last cached usage result.",
    });
  });

  it("falls back to the cache timestamp when OMP has no refresh timestamp", () => {
    const now = Date.UTC(2026, 6, 24, 12, 10);
    const presentation = buildOmpOverviewStatusPresentation({
      overview: {
        accounts: {
          mode: "local",
          managed: false,
          accounts: [],
          capabilities: {
            accounts: true,
            login: true,
            remove: true,
            assignment: true,
            usage: true,
          },
          warning: null,
        },
        usage: { reports: [], refreshedAt: null, stale: false, warning: null },
      },
      cachedAt: Date.UTC(2026, 6, 24, 10, 10),
      refreshWarning: null,
      now,
    });

    expect(presentation.freshnessTitle).toBe("Cached 2h ago");
    expect(presentation.warning).toBeNull();
  });

  it("keeps ChatGPT and Claude login enabled during an active turn and scopes it forward", () => {
    const activeTurnActions = ["Add ChatGPT", "Add Claude"].map((title) => ({
      title,
      ...getOmpLoginActionPresentation({ hasActiveTurn: true }),
    }));
    const idle = getOmpLoginActionPresentation({ hasActiveTurn: false });

    expect(activeTurnActions).toEqual([
      {
        title: "Add ChatGPT",
        disabled: false,
        description: "For future sessions · This turn keeps its account",
      },
      {
        title: "Add Claude",
        disabled: false,
        description: "For future sessions · This turn keeps its account",
      },
    ]);
    expect(idle).toEqual({
      disabled: false,
      description: "Available for future sessions",
    });
  });

  it("presents unavailable OAuth accounts as reconnect-required, not connected", () => {
    expect(
      buildOmpAccountRowPresentation({
        accountRef: OmpAccountRef.make("acct_claude_disabled"),
        provider: "anthropic-claude",
        authKind: "oauth",
        displayName: "cl***de@example.com",
        maskedEmail: "cl***de@example.com",
        state: "unavailable",
        managed: false,
      }),
    ).toEqual({
      connected: false,
      title: "Claude needs reconnecting",
      description: "cl***de@example.com · Not connected",
    });
  });

  it("preserves cached account and usage rows when refresh fails", () => {
    const overview = {
      accounts: {
        mode: "local" as const,
        managed: false,
        accounts: [],
        capabilities: {
          accounts: true,
          login: true,
          remove: true,
          assignment: true,
          usage: true,
        },
        warning: null,
      },
      usage: { reports: [], refreshedAt: 123, stale: false, warning: null },
    };

    expect(
      preserveOmpOverviewAfterRefreshFailure({
        overview,
        cachedAt: 456,
        warning: "Showing the last cached account and usage data.",
      }),
    ).toEqual({
      overview,
      cachedAt: 456,
      refreshWarning: "Showing the last cached account and usage data.",
    });
  });
});
