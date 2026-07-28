import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import { makeOmpAccountService, OMP_ACCOUNT_METHODS } from "./OmpAccountService.ts";
import {
  accountMode,
  isTerminalOmpAccountRuntimeFailure,
  makeRestartableOmpAccountRequest,
  type OmpAccountRuntimeHandle,
} from "./OmpAccountRuntime.ts";

describe("OMP account runtime mode", () => {
  it("preserves local account login behavior by default", () => {
    expect(accountMode({})).toBe("local");
    expect(accountMode({ T3_OMP_ACCOUNT_MODE: "local" })).toBe("local");
  });

  it("uses read-only broker account behavior on Scaffold", () => {
    expect(accountMode({ T3_OMP_ACCOUNT_MODE: "broker" })).toBe("broker");
  });

  it("fails closed on an unknown account mode", () => {
    expect(() => accountMode({ T3_OMP_ACCOUNT_MODE: "managed-ish" })).toThrow(
      /must be either local or broker/u,
    );
  });

  it("distinguishes a dead ACP child from a request-level OAuth rejection", () => {
    expect(isTerminalOmpAccountRuntimeFailure(new EffectAcpErrors.AcpProcessExitedError({}))).toBe(
      true,
    );
    expect(
      isTerminalOmpAccountRuntimeFailure(
        new EffectAcpErrors.AcpTransportError({ cause: new Error("pipe closed") }),
      ),
    ).toBe(true);
    expect(
      isTerminalOmpAccountRuntimeFailure(
        EffectAcpErrors.AcpRequestError.invalidParams("authorization code rejected"),
      ),
    ).toBe(false);
  });

  it.effect("discards a terminated OAuth child and preserves cached accounts for the retry", () =>
    Effect.gen(function* () {
      const existingAccount = {
        accountRef: "acct_existing",
        provider: "openai-codex",
        type: "oauth",
        email: "existing@example.com",
        state: "available",
      };
      const firstRuntime: OmpAccountRuntimeHandle = {
        request: (method) => {
          switch (method) {
            case OMP_ACCOUNT_METHODS.list:
              return Effect.succeed({ accounts: [existingAccount] });
            case OMP_ACCOUNT_METHODS.login:
              return Effect.succeed({
                flowId: "flow_interrupted",
                kind: "input",
                inputType: "code",
              });
            case OMP_ACCOUNT_METHODS.loginRespond:
              return Effect.fail(
                new EffectAcpErrors.AcpProcessExitedError({
                  cause: { accessToken: "must-not-cross-the-account-boundary" },
                }),
              );
            default:
              return EffectAcpErrors.AcpRequestError.methodNotFound(method);
          }
        },
      };
      const secondRuntime: OmpAccountRuntimeHandle = {
        request: (method) =>
          method === OMP_ACCOUNT_METHODS.login
            ? Effect.succeed({
                flowId: "flow_retried",
                kind: "browser",
                url: "https://example.invalid/authorize",
              })
            : EffectAcpErrors.AcpRequestError.methodNotFound(method),
      };
      const runtimes = [firstRuntime, secondRuntime];
      let createdRuntimes = 0;
      const request = yield* makeRestartableOmpAccountRequest({
        createRuntime: Effect.sync(() => {
          const runtime = runtimes[createdRuntimes];
          createdRuntimes += 1;
          if (!runtime) throw new Error("unexpected third OMP account runtime");
          return runtime;
        }),
      });
      const service = yield* makeOmpAccountService({ request });

      const before = yield* service.listAccounts;
      yield* service.beginLogin("anthropic");
      const interrupted = yield* service
        .respondLogin("anthropic", "flow_interrupted", "sensitive-code")
        .pipe(Effect.flip);
      const retried = yield* service.beginLogin("anthropic");
      const after = yield* service.getSnapshot;

      expect(interrupted.reason).toBe("request-failed");
      expect(interrupted.detail).toBe("The OMP account connection restarted. Start sign-in again.");
      expect(interrupted.cause).toBeUndefined();
      expect(interrupted.detail).not.toContain("must-not-cross");
      expect(retried).toMatchObject({ flowId: "flow_retried", kind: "browser" });
      expect(createdRuntimes).toBe(2);
      expect(before.accounts).toHaveLength(1);
      expect(after.accounts.accounts).toEqual(before.accounts);
    }),
  );
});
