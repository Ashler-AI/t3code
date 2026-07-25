import { EnvironmentId, OmpAccountRef } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  cacheOmpAccountOverview,
  createMemoryOmpAccountOverviewCache,
  isCachedOmpAccountOverview,
  mergeRefreshedOmpAccountOverview,
  OMP_RETAINED_USAGE_NOTE,
} from "./ompAccountOverviewCache";

const environmentId = EnvironmentId.make("env_local");
const overview = {
  accounts: {
    mode: "local" as const,
    managed: false,
    accounts: [
      {
        accountRef: OmpAccountRef.make("acct_local_one"),
        provider: "openai-codex",
        authKind: "oauth" as const,
        displayName: "ch***er@example.com",
        maskedEmail: "ch***er@example.com",
        state: "available" as const,
        managed: false,
      },
    ],
    capabilities: {
      accounts: true,
      login: true,
      remove: true,
      assignment: true,
      usage: true,
    },
    warning: null,
  },
  usage: {
    reports: [],
    refreshedAt: 123,
    stale: false,
    warning: null,
  },
};
const chatGptAccount = overview.accounts.accounts[0]!;

describe("OMP account overview cache", () => {
  it("stores one global snapshot per environment independently of threads", async () => {
    const cache = createMemoryOmpAccountOverviewCache();
    await cacheOmpAccountOverview(cache, environmentId, overview, 456);

    await expect(cache.get(environmentId)).resolves.toEqual({
      schemaVersion: 1,
      environmentId,
      updatedAt: 456,
      overview,
    });
  });

  it("rejects malformed and credential-bearing snapshots", () => {
    expect(
      isCachedOmpAccountOverview({
        schemaVersion: 1,
        environmentId,
        updatedAt: Number.NaN,
        overview,
      }),
    ).toBe(false);
    expect(
      isCachedOmpAccountOverview({
        schemaVersion: 1,
        environmentId,
        updatedAt: 456,
        overview: {
          ...overview,
          accounts: {
            ...overview.accounts,
            accounts: [{ ...overview.accounts.accounts[0], accessToken: "secret" }],
          },
        },
      }),
    ).toBe(false);
  });

  it("retains omitted connected-provider usage as stale without reviving removed accounts", async () => {
    const claudeAccount = {
      accountRef: OmpAccountRef.make("acct_claude_one"),
      provider: "anthropic-claude",
      authKind: "oauth" as const,
      displayName: "cl***de@example.com",
      maskedEmail: "cl***de@example.com",
      state: "available" as const,
      managed: false,
    };
    const removedChatGptAccount = {
      accountRef: OmpAccountRef.make("acct_openai_removed"),
      provider: "openai-codex",
      authKind: "oauth" as const,
      displayName: "ol***ai@example.com",
      maskedEmail: "ol***ai@example.com",
      state: "available" as const,
      managed: false,
    };
    const previous = {
      ...overview,
      accounts: {
        ...overview.accounts,
        accounts: [...overview.accounts.accounts, claudeAccount, removedChatGptAccount],
      },
      usage: {
        reports: [
          {
            provider: "openai-codex",
            accountRef: chatGptAccount.accountRef,
            maskedAccount: "ch***er@example.com",
            fetchedAt: 100,
            limits: [
              {
                id: "openai-weekly",
                label: "7-day quota",
                scope: { provider: "openai-codex" },
                amount: { remainingFraction: 0.5, unit: "percent" as const },
              },
            ],
          },
          {
            provider: "anthropic-claude",
            accountRef: claudeAccount.accountRef,
            maskedAccount: claudeAccount.maskedEmail,
            fetchedAt: 101,
            limits: [
              {
                id: "claude-weekly",
                label: "Weekly quota",
                scope: { provider: "anthropic-claude" },
                amount: { remainingFraction: 0.75, unit: "percent" as const },
              },
            ],
          },
          {
            provider: "openai-codex",
            accountRef: removedChatGptAccount.accountRef,
            maskedAccount: removedChatGptAccount.maskedEmail,
            fetchedAt: 102,
            limits: [
              {
                id: "removed-weekly",
                label: "7-day quota",
                scope: { provider: "openai-codex" },
                amount: { remainingFraction: 0.9, unit: "percent" as const },
              },
            ],
          },
        ],
        refreshedAt: 102,
        stale: false,
        warning: null,
      },
    };
    const refreshed = {
      ...overview,
      accounts: {
        ...overview.accounts,
        accounts: [...overview.accounts.accounts, claudeAccount],
      },
      usage: {
        reports: [
          {
            provider: "openai-codex",
            accountRef: chatGptAccount.accountRef,
            maskedAccount: "ch***er@example.com",
            fetchedAt: 200,
            limits: [
              {
                id: "openai-weekly",
                label: "7-day quota",
                scope: { provider: "openai-codex" },
                amount: { remainingFraction: 0.4, unit: "percent" as const },
              },
            ],
          },
        ],
        refreshedAt: 200,
        stale: false,
        warning: null,
      },
    };

    const merged = mergeRefreshedOmpAccountOverview({ previous, refreshed });
    const cache = createMemoryOmpAccountOverviewCache();
    await cacheOmpAccountOverview(cache, environmentId, merged, 201);

    expect(merged.accounts).toEqual(refreshed.accounts);
    expect(merged.usage.stale).toBe(true);
    expect(merged.usage.warning).toContain("omitted");
    expect(merged.usage.reports.map((report) => report.accountRef)).toEqual([
      chatGptAccount.accountRef,
      claudeAccount.accountRef,
    ]);
    expect(merged.usage.reports[1]?.notes).toContain(OMP_RETAINED_USAGE_NOTE);
    expect(JSON.stringify(merged)).not.toContain(removedChatGptAccount.accountRef);
    await expect(cache.get(environmentId)).resolves.toMatchObject({ overview: merged });
  });

  it("uses a complete refresh unchanged after every prior account was removed", () => {
    const refreshed = {
      ...overview,
      accounts: { ...overview.accounts, accounts: [] },
      usage: { reports: [], refreshedAt: 999, stale: false, warning: null },
    };

    expect(mergeRefreshedOmpAccountOverview({ previous: overview, refreshed })).toBe(refreshed);
  });

  it("replaces a cached available account with the refreshed unavailable state", () => {
    const refreshed = {
      ...overview,
      accounts: {
        ...overview.accounts,
        accounts: overview.accounts.accounts.map((account) => ({
          ...account,
          state: "unavailable" as const,
        })),
      },
    };

    const merged = mergeRefreshedOmpAccountOverview({ previous: overview, refreshed });

    expect(merged.accounts.accounts).toEqual(refreshed.accounts.accounts);
    expect(merged.accounts.accounts[0]?.state).toBe("unavailable");
  });
});
