import {
  IsoDateTime,
  OmpAccountRef,
  ProviderDriverKind,
  ThreadId,
  type ProviderSession,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  maskEmail,
  parseOmpAccountAssignment,
  parseOmpAccountsList,
  parseOmpLoginChallenge,
  parseOmpUsageResponse,
} from "./OmpAccountParsers.ts";
import {
  makeOmpAccountService,
  getOmpThreadAccountAssignment,
  OMP_ACCOUNT_METHODS,
  OmpAccountTransportError,
  type OmpAccountExtensionTransport,
} from "./OmpAccountService.ts";

const transportFailure = (detail: string) => new OmpAccountTransportError({ detail });
const THREAD_ID = ThreadId.make("thread-1");
const NOW = IsoDateTime.make("2026-07-24T20:00:00.000Z");

function providerSession(overrides?: Partial<ProviderSession>): ProviderSession {
  return {
    threadId: THREAD_ID,
    provider: ProviderDriverKind.make("omp"),
    status: "running",
    runtimeMode: "full-access",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function providerServiceFor(session?: ProviderSession) {
  return { listSessions: () => Effect.succeed(session ? [session] : []) };
}

const accountResponse = {
  accounts: [
    {
      accountRef: "acct_openai_primary",
      id: 4815,
      credentialId: 1623,
      provider: "openai-codex",
      type: "oauth",
      email: "zhenchristopher@gmail.com",
      accessToken: "secret-access-token",
      refreshToken: "secret-refresh-token",
      accountId: "raw-upstream-account-id",
      orgId: "raw-org-id",
      orgName: "Ashler",
      state: "available",
      raw: { secret: "never-return-this" },
    },
  ],
};

const usageResponse = {
  reports: [
    {
      provider: "openai-codex",
      accountRef: "acct_openai_primary",
      fetchedAt: 1234,
      raw: { access_token: "never-return-this" },
      metadata: {
        accountId: "raw-upstream-account-id",
        email: "zhenchristopher@gmail.com",
      },
      resetCredits: {
        availableCount: 2,
        credits: [
          {
            id: "credential-private-reset-id",
            grantedAt: "2026-07-24T20:00:00.000Z",
            expiresAt: "2026-08-24T20:00:00.000Z",
            status: "available",
            providerPayload: { secret: "never-return-this" },
          },
        ],
      },
      limits: [
        {
          id: "openai-codex:weekly:primary",
          label: "7-day quota",
          scope: {
            provider: "openai-codex",
            accountId: "raw-upstream-account-id",
            projectId: "raw-project-id",
            orgId: "raw-org-id",
            tier: "pro",
          },
          amount: { usedFraction: 0.25, unit: "percent" },
          status: "ok",
        },
        {
          id: "openai-codex:spark:weekly",
          label: "7 days (Spark)",
          scope: { provider: "openai-codex" },
          amount: { usedFraction: 0.1, unit: "percent" },
        },
      ],
    },
  ],
};

describe("OMP account parsers", () => {
  it("preserves terminal login outcomes", () => {
    expect(
      parseOmpLoginChallenge(
        {
          flowId: "login_123",
          kind: "complete",
          outcome: "failure",
          message: "Login did not complete.",
        },
        "anthropic",
      ),
    ).toEqual({
      flowId: "login_123",
      provider: "anthropic",
      kind: "complete",
      outcome: "failure",
      message: "Login did not complete.",
    });
  });

  it("preserves manual-code metadata and challenge expiry", () => {
    expect(
      parseOmpLoginChallenge(
        {
          flowId: "login_code",
          kind: "input",
          inputType: "code",
          prompt: "Paste the authorization code or full redirect URL.",
          expiresAt: 1_753_394_400_000,
        },
        "anthropic",
      ),
    ).toEqual({
      flowId: "login_code",
      provider: "anthropic",
      kind: "input",
      inputType: "code",
      prompt: "Paste the authorization code or full redirect URL.",
      expiresAt: 1_753_394_400_000,
    });
  });

  it("normalizes the legacy code challenge to canonical input metadata", () => {
    expect(
      parseOmpLoginChallenge(
        { flowId: "login_legacy", kind: "code", prompt: "Paste the code." },
        "anthropic",
      ),
    ).toEqual({
      flowId: "login_legacy",
      provider: "anthropic",
      kind: "input",
      inputType: "code",
      prompt: "Paste the code.",
    });
  });

  it("masks identities and strips raw credential and usage identifiers", () => {
    const accounts = parseOmpAccountsList(accountResponse);
    const usage = parseOmpUsageResponse(usageResponse);

    expect(maskEmail("zhenchristopher@gmail.com")).toBe("zh***er@gmail.com");
    expect(accounts).toEqual([
      {
        accountRef: "acct_openai_primary",
        provider: "openai-codex",
        authKind: "oauth",
        displayName: "zh***er@gmail.com",
        maskedEmail: "zh***er@gmail.com",
        organization: "Ashler",
        state: "available",
        managed: false,
      },
    ]);
    expect(usage?.reports[0]?.limits).toHaveLength(1);
    expect(usage?.reports[0]?.maskedAccount).toBe("zh***er@gmail.com");
    expect(usage?.reports[0]?.limits[0]?.scope).toEqual({
      provider: "openai-codex",
      tier: "pro",
    });
    expect(usage?.reports[0]?.resetCredits).toEqual({
      availableCount: 2,
      credits: [
        {
          grantedAt: "2026-07-24T20:00:00.000Z",
          expiresAt: "2026-08-24T20:00:00.000Z",
          status: "available",
        },
      ],
    });
    const serialized = JSON.stringify({ accounts, usage });
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("raw-upstream-account-id");
    expect(serialized).not.toContain("raw-project-id");
    expect(serialized).not.toContain("raw-org-id");
    expect(serialized).not.toContain("credential-private-reset-id");
    expect(serialized).not.toContain("providerPayload");
    expect(serialized).not.toContain("Spark");
  });

  it("rejects raw credential ids as account handles", () => {
    expect(
      parseOmpAccountsList({
        accounts: [{ id: 42, provider: "anthropic", email: "user@example.com" }],
      }),
    ).toEqual([]);
  });

  it("returns only masked assignment identity and whitelisted reassignment reasons", () => {
    const assignment = parseOmpAccountAssignment(
      {
        account: accountResponse.accounts[0],
        reassignmentReason: "quota-exhausted",
        rawAccountId: "raw-upstream-account-id",
        accessToken: "secret-access-token",
      },
      THREAD_ID,
    );
    const unsafeReason = parseOmpAccountAssignment(
      {
        account: null,
        reason: "credential raw-upstream-account-id failed",
      },
      THREAD_ID,
    );

    expect(assignment).toEqual({
      threadId: THREAD_ID,
      account: {
        accountRef: "acct_openai_primary",
        provider: "openai-codex",
        authKind: "oauth",
        displayName: "zh***er@gmail.com",
        maskedEmail: "zh***er@gmail.com",
        organization: "Ashler",
        state: "available",
        managed: false,
      },
      automatic: true,
      reassignmentReason: "quota-exhausted",
    });
    expect(unsafeReason).toEqual({
      threadId: THREAD_ID,
      account: null,
      automatic: true,
    });
    expect(JSON.stringify(assignment)).not.toContain("secret");
    expect(JSON.stringify(assignment)).not.toContain("raw-upstream-account-id");
  });
});

describe("OmpAccountService", () => {
  it.effect("probes the optional submit extension with an empty response", () =>
    Effect.gen(function* () {
      const requests: Array<{ method: string; payload: unknown }> = [];
      const service = yield* makeOmpAccountService({
        request: (method, payload) => {
          requests.push({ method, payload });
          return Effect.succeed({ accepted: false });
        },
      });

      const result = yield* service.submitLogin("login_probe", "");

      expect(result).toEqual({ supported: true, accepted: false });
      expect(requests).toEqual([
        {
          method: OMP_ACCOUNT_METHODS.loginSubmit,
          payload: { flowId: "login_probe", response: "" },
        },
      ]);
    }),
  );

  it.effect("submits manual login input through the immediate idempotent extension", () =>
    Effect.gen(function* () {
      const requests: Array<{ method: string; payload: unknown }> = [];
      const service = yield* makeOmpAccountService({
        request: (method, payload) => {
          requests.push({ method, payload });
          return Effect.succeed({ accepted: requests.length === 1 });
        },
      });

      const accepted = yield* service.submitLogin("login_manual", "callback-code");
      const duplicate = yield* service.submitLogin("login_manual", "callback-code");

      expect(accepted).toEqual({ supported: true, accepted: true });
      expect(duplicate).toEqual({ supported: true, accepted: false });
      expect(requests).toEqual([
        {
          method: OMP_ACCOUNT_METHODS.loginSubmit,
          payload: { flowId: "login_manual", response: "callback-code" },
        },
        {
          method: OMP_ACCOUNT_METHODS.loginSubmit,
          payload: { flowId: "login_manual", response: "callback-code" },
        },
      ]);
    }),
  );

  it.effect("falls back from a missing submit extension without disabling account login", () =>
    Effect.gen(function* () {
      const service = yield* makeOmpAccountService({
        request: (method) =>
          method === OMP_ACCOUNT_METHODS.loginSubmit
            ? Effect.fail(transportFailure("JSON-RPC -32601: method not found"))
            : Effect.succeed({}),
      });

      const result = yield* service.submitLogin("login_legacy", "callback-code");
      const snapshot = yield* service.getSnapshot;

      expect(result).toEqual({ supported: false, accepted: false });
      expect(snapshot.accounts.capabilities.login).toBe(true);
    }),
  );

  it.effect("replaces cached availability with a successful unavailable refresh", () =>
    Effect.gen(function* () {
      let listCalls = 0;
      const service = yield* makeOmpAccountService({
        request: (method) => {
          if (method !== OMP_ACCOUNT_METHODS.list) {
            return Effect.fail(transportFailure("unexpected request"));
          }
          listCalls += 1;
          return Effect.succeed(
            listCalls === 1
              ? accountResponse
              : {
                  accounts: [
                    {
                      accountRef: "acct_openai_primary",
                      provider: "openai-codex",
                      authKind: "oauth",
                      displayName: "zh***er@gmail.com",
                      maskedEmail: "zh***er@gmail.com",
                      state: "unavailable",
                      managed: false,
                    },
                  ],
                },
          );
        },
      });

      const available = yield* service.listAccounts;
      const unavailable = yield* service.listAccounts;
      const snapshot = yield* service.getSnapshot;

      expect(available.accounts[0]?.state).toBe("available");
      expect(unavailable.accounts[0]?.state).toBe("unavailable");
      expect(unavailable.warning).toBeNull();
      expect(snapshot.accounts).toEqual(unavailable);
    }),
  );

  it.effect("retains cached usage and accounts when an optional refresh fails", () =>
    Effect.gen(function* () {
      const callCounts = new Map<string, number>();
      const requests: Array<{ method: string; payload: unknown }> = [];
      const transport: OmpAccountExtensionTransport = {
        request: (method, payload) => {
          requests.push({ method, payload });
          const count = (callCounts.get(method) ?? 0) + 1;
          callCounts.set(method, count);
          if (method === OMP_ACCOUNT_METHODS.list) {
            return count === 1
              ? Effect.succeed(accountResponse)
              : Effect.fail(transportFailure("temporary account refresh failure"));
          }
          if (method === OMP_ACCOUNT_METHODS.usage) {
            return count === 1
              ? Effect.succeed(usageResponse)
              : Effect.fail(transportFailure("temporary usage refresh failure"));
          }
          return Effect.fail(transportFailure("unexpected request"));
        },
      };
      const service = yield* makeOmpAccountService(transport);

      const initialAccounts = yield* service.listAccounts;
      const initialUsage = yield* service.getUsage();
      const staleAccounts = yield* service.listAccounts;
      const staleUsage = yield* service.getUsage({ refresh: true });
      const cachedSnapshot = yield* service.getSnapshot;

      expect(initialAccounts.accounts).toHaveLength(1);
      expect(initialAccounts.warning).toBeNull();
      expect(staleAccounts.accounts).toEqual(initialAccounts.accounts);
      expect(staleAccounts.warning).toContain("last cached");
      expect(initialUsage.stale).toBe(false);
      expect(staleUsage.reports).toEqual(initialUsage.reports);
      expect(staleUsage.stale).toBe(true);
      expect(staleUsage.warning).toContain("last cached");
      expect(cachedSnapshot.accounts).toEqual(staleAccounts);
      expect(cachedSnapshot.usage).toEqual(staleUsage);
      expect(requests.at(-1)).toEqual({
        method: OMP_ACCOUNT_METHODS.usage,
        payload: { refresh: true },
      });
    }),
  );

  it.effect("degrades gracefully when stock OMP lacks account extensions", () =>
    Effect.gen(function* () {
      const service = yield* makeOmpAccountService({
        request: (method) =>
          method === OMP_ACCOUNT_METHODS.usage
            ? Effect.succeed(usageResponse)
            : Effect.fail(transportFailure("JSON-RPC -32601: method not found")),
      });

      const accounts = yield* service.listAccounts;
      const assignment = yield* service.getAssignmentForSession("native-session-1", THREAD_ID);
      const usage = yield* service.getUsage();

      expect(accounts.accounts).toEqual([]);
      expect(accounts.capabilities.accounts).toBe(false);
      expect(assignment).toEqual({ threadId: THREAD_ID, account: null, automatic: true });
      expect(usage.reports).toHaveLength(1);
    }),
  );

  it.effect("resolves a started OMP thread without exposing its native session id", () =>
    Effect.gen(function* () {
      const requests: Array<{ method: string; payload: unknown }> = [];
      const service = yield* makeOmpAccountService({
        request: (method, payload) => {
          requests.push({ method, payload });
          return Effect.succeed({
            account: accountResponse.accounts[0],
            reassignmentReason: "load-balanced",
          });
        },
      });

      const assignment = yield* getOmpThreadAccountAssignment(
        providerServiceFor(
          providerSession({
            resumeCursor: { schemaVersion: 3, sessionId: "native-session-sticky" },
            model: "anthropic/claude-fable-5",
          }),
        ),
        service,
        THREAD_ID,
      );

      expect(assignment.threadId).toBe(THREAD_ID);
      expect(assignment.account?.maskedEmail).toBe("zh***er@gmail.com");
      expect(assignment.reassignmentReason).toBe("load-balanced");
      expect(assignment).not.toHaveProperty("sessionId");
      expect(requests).toEqual([
        {
          method: OMP_ACCOUNT_METHODS.assignment,
          payload: { sessionId: "native-session-sticky", provider: "anthropic" },
        },
      ]);
    }),
  );

  it.effect("normalizes an OpenAI model alias for cross-process sticky lookup", () =>
    Effect.gen(function* () {
      const requests: unknown[] = [];
      const service = yield* makeOmpAccountService({
        request: (_method, payload) => {
          requests.push(payload);
          return Effect.succeed({ account: null });
        },
      });

      yield* getOmpThreadAccountAssignment(
        providerServiceFor(
          providerSession({
            resumeCursor: { schemaVersion: 3, sessionId: "native-openai-session" },
            model: "openai/gpt-5.6-sol",
          }),
        ),
        service,
        THREAD_ID,
      );

      expect(requests).toEqual([{ sessionId: "native-openai-session", provider: "openai-codex" }]);
    }),
  );

  it.effect("handles an active but unassigned OMP thread and rejects inactive sessions", () =>
    Effect.gen(function* () {
      let requests = 0;
      const service = yield* makeOmpAccountService({
        request: () => {
          requests += 1;
          return Effect.succeed({ account: null });
        },
      });
      const activeSession = providerSession({
        resumeCursor: { schemaVersion: 3, sessionId: "native-unassigned" },
      });

      const unassigned = yield* getOmpThreadAccountAssignment(
        providerServiceFor(activeSession),
        service,
        THREAD_ID,
      );
      const inactiveError = yield* getOmpThreadAccountAssignment(
        providerServiceFor(providerSession({ ...activeSession, status: "closed" })),
        service,
        THREAD_ID,
      ).pipe(Effect.flip);

      expect(unassigned).toEqual({ threadId: THREAD_ID, account: null, automatic: true });
      expect(inactiveError.reason).toBe("unavailable");
      expect(inactiveError.detail).toContain("not active");
      expect(requests).toBe(1);
    }),
  );

  it.effect("rejects non-OMP and missing thread bindings before querying accounts", () =>
    Effect.gen(function* () {
      let requests = 0;
      const service = yield* makeOmpAccountService({
        request: () => {
          requests += 1;
          return Effect.succeed({ account: null });
        },
      });
      const nonOmpError = yield* getOmpThreadAccountAssignment(
        providerServiceFor(
          providerSession({
            provider: ProviderDriverKind.make("codex"),
            resumeCursor: { schemaVersion: 1, sessionId: "private-codex-session" },
          }),
        ),
        service,
        THREAD_ID,
      ).pipe(Effect.flip);
      const missingError = yield* getOmpThreadAccountAssignment(
        providerServiceFor(),
        service,
        THREAD_ID,
      ).pipe(Effect.flip);

      expect(nonOmpError.detail).toContain("not backed by OMP");
      expect(missingError.detail).toContain("No active provider session");
      expect(requests).toBe(0);
    }),
  );

  it.effect("reports broker-managed state and rejects local account mutation", () =>
    Effect.gen(function* () {
      let requests = 0;
      const service = yield* makeOmpAccountService({
        mode: "broker",
        request: () => {
          requests += 1;
          return Effect.succeed({});
        },
      });

      const accounts = yield* service.listAccounts;
      const loginError = yield* service.beginLogin("anthropic").pipe(Effect.flip);
      const removeError = yield* service
        .removeAccount(OmpAccountRef.make("acct_anthropic_primary"))
        .pipe(Effect.flip);

      expect(accounts.mode).toBe("broker");
      expect(accounts.managed).toBe(true);
      expect(accounts.capabilities.login).toBe(false);
      expect(accounts.capabilities.remove).toBe(false);
      expect(loginError.reason).toBe("managed-by-broker");
      expect(removeError.reason).toBe("managed-by-broker");
      // listAccounts is the sole read request; both mutations fail locally.
      expect(requests).toBe(1);
    }),
  );
});
