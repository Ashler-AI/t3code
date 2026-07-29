// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import { makeOmpAcpRuntime } from "../provider/acp/OmpAcpSupport.ts";
import { makeOmpAccountService, OMP_ACCOUNT_METHODS } from "./OmpAccountService.ts";
import {
  accountMode,
  isTerminalOmpAccountRuntimeFailure,
  makeRestartableOmpAccountRequest,
  ompExecutableSignature,
  type OmpAccountRuntimeHandle,
} from "./OmpAccountRuntime.ts";

const readOmpExecutableSignature = (
  input: Parameters<typeof ompExecutableSignature>[0],
  platform?: NodeJS.Platform,
) => {
  const signature = ompExecutableSignature(input);
  return platform
    ? signature.pipe(Effect.provideService(HostProcessPlatform, platform))
    : signature;
};

const fixturePath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "OmpAccountRuntime.fixture.ts",
);

function fixtureExecutable(childId: string): string {
  return `#!/bin/sh
export T3_OMP_ACCOUNT_FIXTURE_CHILD_ID=${JSON.stringify(childId)}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} "$@"
`;
}

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

  it.effect("changes the executable signature when a binary is replaced at the same path", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-omp-signature-"))),
      (directory) =>
        Effect.gen(function* () {
          const executable = NodePath.join(directory, "omp");
          const replacement = NodePath.join(directory, "omp.next");
          yield* Effect.promise(() => NodeFSP.writeFile(executable, "first binary"));
          yield* Effect.promise(() => NodeFSP.chmod(executable, 0o755));
          const first = yield* readOmpExecutableSignature({ command: executable, cwd: directory });

          yield* Effect.promise(() => NodeFSP.writeFile(replacement, "second binary"));
          yield* Effect.promise(() => NodeFSP.chmod(replacement, 0o755));
          yield* Effect.promise(() => NodeFSP.rename(replacement, executable));
          const second = yield* readOmpExecutableSignature({ command: executable, cwd: directory });

          expect(second).not.toBe(first);
        }),
      (directory) =>
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
          Effect.orDie,
        ),
    ),
  );

  it.effect("resolves relative PATH entries from the child cwd", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-omp-path-"))),
      (directory) =>
        Effect.gen(function* () {
          const binDirectory = NodePath.join(directory, "bin");
          const executable = NodePath.join(binDirectory, "omp");
          yield* Effect.promise(() => NodeFSP.mkdir(binDirectory));
          yield* Effect.promise(() => NodeFSP.writeFile(executable, "binary"));
          yield* Effect.promise(() => NodeFSP.chmod(executable, 0o755));

          const signature = yield* readOmpExecutableSignature({
            command: "omp",
            cwd: directory,
            environment: { PATH: "bin" },
          });

          expect(signature.toLowerCase()).toContain(executable.toLowerCase());
        }),
      (directory) =>
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
          Effect.orDie,
        ),
    ),
  );

  it.effect("normalizes Windows PATHEXT casing through the shared resolver", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-omp-pathext-"))),
      (directory) =>
        Effect.gen(function* () {
          const binDirectory = NodePath.join(directory, "bin");
          const executable = NodePath.join(binDirectory, "omp.cmd");
          yield* Effect.promise(() => NodeFSP.mkdir(binDirectory));
          yield* Effect.promise(() => NodeFSP.writeFile(executable, "binary"));

          const signature = yield* readOmpExecutableSignature(
            {
              command: "omp",
              cwd: directory,
              environment: { PATH: "bin", PATHEXT: ".cmd" },
            },
            "win32",
          );

          expect(signature.toLowerCase()).toContain(executable.toLowerCase());
        }),
      (directory) =>
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
          Effect.orDie,
        ),
    ),
  );

  it.effect("reuses one cached child while the executable signature is unchanged", () =>
    Effect.gen(function* () {
      let createdRuntimes = 0;
      let disposedRuntimes = 0;
      const request = yield* makeRestartableOmpAccountRequest({
        getRuntimeSignature: Effect.succeed("inode-1"),
        createRuntime: Effect.sync(() => {
          createdRuntimes += 1;
          return {
            request: (method) => Effect.succeed({ method, runtime: createdRuntimes }),
            dispose: Effect.sync(() => {
              disposedRuntimes += 1;
            }),
          } satisfies OmpAccountRuntimeHandle;
        }),
      });

      const first = yield* request(OMP_ACCOUNT_METHODS.list, {});
      const second = yield* request(OMP_ACCOUNT_METHODS.usage, {});

      expect(first).toMatchObject({ runtime: 1 });
      expect(second).toMatchObject({ runtime: 1 });
      expect(createdRuntimes).toBe(1);
      expect(disposedRuntimes).toBe(0);
    }),
  );

  it.effect("coalesces concurrent requests onto one replacement child", () =>
    Effect.gen(function* () {
      let signature = "inode-1";
      let createdRuntimes = 0;
      const disposedRuntimes: number[] = [];
      const request = yield* makeRestartableOmpAccountRequest({
        getRuntimeSignature: Effect.sync(() => signature),
        createRuntime: Effect.sync(() => {
          const runtimeId = ++createdRuntimes;
          return {
            request: (method) => Effect.succeed({ method, runtime: runtimeId }),
            dispose: Effect.sync(() => {
              disposedRuntimes.push(runtimeId);
            }),
          } satisfies OmpAccountRuntimeHandle;
        }),
      });

      yield* request(OMP_ACCOUNT_METHODS.list, {});
      signature = "inode-2";
      const results = yield* Effect.all(
        [
          request(OMP_ACCOUNT_METHODS.list, {}),
          request(OMP_ACCOUNT_METHODS.usage, {}),
          request(OMP_ACCOUNT_METHODS.assignment, {}),
        ],
        { concurrency: "unbounded" },
      );

      expect(results).toHaveLength(3);
      expect(results.every((result) => (result as { runtime: number }).runtime === 2)).toBe(true);
      expect(createdRuntimes).toBe(2);
      expect(disposedRuntimes).toEqual([1]);
    }),
  );

  it.effect("interrupts blocked runtime creation and leaves the mutex usable", () =>
    Effect.gen(function* () {
      let createAttempts = 0;
      const firstCreateStarted = yield* Deferred.make<void>();
      const request = yield* makeRestartableOmpAccountRequest({
        getRuntimeSignature: Effect.succeed("inode-1"),
        createRuntime: Effect.suspend(() => {
          createAttempts += 1;
          if (createAttempts === 1) {
            return Deferred.succeed(firstCreateStarted, undefined).pipe(
              Effect.andThen(Effect.never),
            );
          }
          return Effect.succeed({
            request: (method) => Effect.succeed({ method, runtime: createAttempts }),
          } satisfies OmpAccountRuntimeHandle);
        }),
      });

      const blocked = yield* request(OMP_ACCOUNT_METHODS.list, {}).pipe(Effect.forkScoped);
      yield* Deferred.await(firstCreateStarted);
      yield* Fiber.interrupt(blocked);

      const afterInterruption = yield* request(OMP_ACCOUNT_METHODS.usage, {});
      expect(afterInterruption).toMatchObject({
        method: OMP_ACCOUNT_METHODS.usage,
        runtime: 2,
      });
      expect(createAttempts).toBe(2);
    }),
  );

  it.effect("releases an interrupted request before checking for a replacement child", () =>
    Effect.gen(function* () {
      let signature = "inode-1";
      let createdRuntimes = 0;
      const disposedRuntimes: number[] = [];
      const firstRequestStarted = yield* Deferred.make<void>();
      const request = yield* makeRestartableOmpAccountRequest({
        getRuntimeSignature: Effect.sync(() => signature),
        createRuntime: Effect.sync(() => {
          const runtimeId = ++createdRuntimes;
          return {
            request: (method) =>
              runtimeId === 1 && method === OMP_ACCOUNT_METHODS.list
                ? Deferred.succeed(firstRequestStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                  )
                : Effect.succeed({ runtime: runtimeId }),
            dispose: Effect.sync(() => {
              disposedRuntimes.push(runtimeId);
            }),
          } satisfies OmpAccountRuntimeHandle;
        }),
      });

      const blocked = yield* request(OMP_ACCOUNT_METHODS.list, {}).pipe(Effect.forkScoped);
      yield* Deferred.await(firstRequestStarted);
      signature = "inode-2";
      yield* Fiber.interrupt(blocked);

      const afterInterruption = yield* request(OMP_ACCOUNT_METHODS.usage, {});
      expect(afterInterruption).toMatchObject({ runtime: 2 });
      expect(createdRuntimes).toBe(2);
      expect(disposedRuntimes).toEqual([1]);
    }),
  );

  it.effect("does not pin terminal status aliases or unknown login discriminators", () =>
    Effect.gen(function* () {
      for (const terminal of [
        { flowId: "flow-status", status: "complete", outcome: "failure" },
        { flowId: "flow-future", kind: "future-challenge" },
      ]) {
        let signature = "inode-1";
        let createdRuntimes = 0;
        const request = yield* makeRestartableOmpAccountRequest({
          getRuntimeSignature: Effect.sync(() => signature),
          createRuntime: Effect.sync(() => {
            const runtimeId = ++createdRuntimes;
            return {
              request: (method) =>
                method === OMP_ACCOUNT_METHODS.login
                  ? Effect.succeed(terminal)
                  : Effect.succeed({ runtime: runtimeId }),
            } satisfies OmpAccountRuntimeHandle;
          }),
        });

        yield* request(OMP_ACCOUNT_METHODS.login, { provider: "openai" });
        signature = "inode-2";
        const afterTerminal = yield* request(OMP_ACCOUNT_METHODS.list, {});

        expect(afterTerminal).toMatchObject({ runtime: 2 });
        expect(createdRuntimes).toBe(2);
      }
    }),
  );

  it.effect("pins a login to its child until the flow reaches a terminal result", () =>
    Effect.gen(function* () {
      let signature = "inode-1";
      let createdRuntimes = 0;
      const disposedRuntimes: number[] = [];
      const request = yield* makeRestartableOmpAccountRequest({
        getRuntimeSignature: Effect.sync(() => signature),
        createRuntime: Effect.sync(() => {
          const runtimeId = ++createdRuntimes;
          return {
            request: (method) => {
              if (method === OMP_ACCOUNT_METHODS.login) {
                return Effect.succeed({ flowId: "flow-1", kind: "browser", runtime: runtimeId });
              }
              if (method === OMP_ACCOUNT_METHODS.loginRespond) {
                return Effect.succeed({
                  flowId: "flow-1",
                  kind: "complete",
                  outcome: "success",
                  runtime: runtimeId,
                });
              }
              return Effect.succeed({ runtime: runtimeId });
            },
            dispose: Effect.sync(() => {
              disposedRuntimes.push(runtimeId);
            }),
          } satisfies OmpAccountRuntimeHandle;
        }),
      });

      const begun = yield* request(OMP_ACCOUNT_METHODS.login, { provider: "openai" });
      signature = "inode-2";
      const completed = yield* request(OMP_ACCOUNT_METHODS.loginRespond, {
        flowId: "flow-1",
        response: "",
      });

      expect(begun).toMatchObject({ runtime: 1 });
      expect(completed).toMatchObject({ runtime: 1, outcome: "success" });
      expect(createdRuntimes).toBe(1);
      expect(disposedRuntimes).toEqual([]);

      const afterLogin = yield* request(OMP_ACCOUNT_METHODS.list, {});
      expect(afterLogin).toMatchObject({ runtime: 2 });
      expect(createdRuntimes).toBe(2);
      expect(disposedRuntimes).toEqual([1]);
    }),
  );

  it.effect(
    "completes OAuth on its original executable and refreshes persisted account state",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-omp-oauth-"))),
        (directory) =>
          Effect.gen(function* () {
            const executable = NodePath.join(directory, "omp");
            const replacement = NodePath.join(directory, "omp.next");
            const statePath = NodePath.join(directory, "account.json");
            const requestLogPath = NodePath.join(directory, "requests.ndjson");
            yield* Effect.promise(() =>
              NodeFSP.writeFile(executable, fixtureExecutable("original")),
            );
            yield* Effect.promise(() => NodeFSP.chmod(executable, 0o755));

            const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const crypto = yield* Crypto.Crypto;
            const parentScope = yield* Scope.Scope;
            const request = yield* makeRestartableOmpAccountRequest({
              getRuntimeSignature: ompExecutableSignature({ command: executable, cwd: directory }),
              createRuntime: Effect.gen(function* () {
                const runtimeScope = yield* Scope.fork(parentScope, "sequential");
                const runtime = yield* makeOmpAcpRuntime({
                  childProcessSpawner,
                  ompSettings: { binaryPath: executable },
                  cwd: directory,
                  environment: {
                    ...process.env,
                    T3_OMP_ACCOUNT_FIXTURE_STATE_PATH: statePath,
                    T3_OMP_ACCOUNT_FIXTURE_REQUEST_LOG_PATH: requestLogPath,
                  },
                  clientInfo: { name: "t3code-omp-account-test", version: "1" },
                }).pipe(
                  Effect.provideService(Crypto.Crypto, crypto),
                  Effect.provideService(Scope.Scope, runtimeScope),
                );
                yield* runtime.start();
                return {
                  request: runtime.request,
                  dispose: Scope.close(runtimeScope, Exit.void).pipe(Effect.ignore),
                } satisfies OmpAccountRuntimeHandle;
              }),
            });
            const service = yield* makeOmpAccountService({ request });

            const begun = yield* service.beginLogin("openai");
            yield* Effect.promise(() =>
              NodeFSP.writeFile(replacement, fixtureExecutable("replacement")),
            );
            yield* Effect.promise(() => NodeFSP.chmod(replacement, 0o755));
            yield* Effect.promise(() => NodeFSP.rename(replacement, executable));
            const completed = yield* service.respondLogin("openai", begun.flowId, "");
            const refreshed = yield* service.listAccounts;
            const requests = (yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8")))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as { childId: string; method: string });

            expect(completed).toMatchObject({ kind: "complete", outcome: "success" });
            expect(refreshed.accounts).toEqual([
              expect.objectContaining({
                accountRef: "acct_fixture_openai",
                maskedEmail: "fi***re@example.test",
                state: "available",
              }),
            ]);
            expect(requests).toEqual([
              { childId: "original", method: OMP_ACCOUNT_METHODS.login },
              { childId: "original", method: OMP_ACCOUNT_METHODS.loginRespond },
              { childId: "replacement", method: OMP_ACCOUNT_METHODS.list },
            ]);
          }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
            Effect.orDie,
          ),
      ),
  );

  it.effect("preserves the service account cache across an executable refresh", () =>
    Effect.gen(function* () {
      const existingAccount = {
        accountRef: "acct_existing",
        provider: "openai-codex",
        type: "oauth",
        email: "existing@example.com",
        state: "available",
      };
      let signature = "inode-1";
      let createdRuntimes = 0;
      const disposedRuntimes: number[] = [];
      const request = yield* makeRestartableOmpAccountRequest({
        getRuntimeSignature: Effect.sync(() => signature),
        createRuntime: Effect.sync(() => {
          const runtimeId = ++createdRuntimes;
          return {
            request: (method) => {
              if (method === OMP_ACCOUNT_METHODS.list) {
                return Effect.succeed({ accounts: [existingAccount] });
              }
              if (method === OMP_ACCOUNT_METHODS.usage) {
                return Effect.succeed({ reports: [] });
              }
              return EffectAcpErrors.AcpRequestError.methodNotFound(method);
            },
            dispose: Effect.sync(() => {
              disposedRuntimes.push(runtimeId);
            }),
          } satisfies OmpAccountRuntimeHandle;
        }),
      });
      const service = yield* makeOmpAccountService({ request });

      const before = yield* service.listAccounts;
      signature = "inode-2";
      yield* service.getUsage();
      const after = yield* service.getSnapshot;

      expect(before.accounts).toHaveLength(1);
      expect(after.accounts.accounts).toEqual(before.accounts);
      expect(createdRuntimes).toBe(2);
      expect(disposedRuntimes).toEqual([1]);
    }),
  );

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
