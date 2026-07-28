import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as ServerConfig from "../config.ts";
import { makeOmpAcpRuntime } from "../provider/acp/OmpAcpSupport.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  isOmpAccountTransportError,
  makeOmpAccountService,
  OmpAccountTransportError,
} from "./OmpAccountService.ts";

export interface OmpAccountRuntimeHandle {
  readonly request: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

function acpErrorTag(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || Array.isArray(cause)) return undefined;
  const tag = (cause as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" ? tag : undefined;
}

export function isTerminalOmpAccountRuntimeFailure(cause: unknown): boolean {
  switch (acpErrorTag(cause)) {
    case "AcpProcessExitedError":
    case "AcpTransportError":
    case "AcpInputStreamEndedError":
      return true;
    default:
      return false;
  }
}

export const makeRestartableOmpAccountRequest = Effect.fn("makeRestartableOmpAccountRequest")(
  function* <E>(options: {
    readonly createRuntime: Effect.Effect<OmpAccountRuntimeHandle, E>;
    readonly isTerminalFailure?: (cause: unknown) => boolean;
  }) {
    const runtimeRef = yield* Ref.make<Option.Option<OmpAccountRuntimeHandle>>(Option.none());
    const runtimeMutex = yield* Semaphore.make(1);
    const isTerminalFailure = options.isTerminalFailure ?? isTerminalOmpAccountRuntimeFailure;

    const getRuntime = runtimeMutex.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(runtimeRef);
        if (Option.isSome(current)) return current.value;

        const runtime = yield* options.createRuntime;
        yield* Ref.set(runtimeRef, Option.some(runtime));
        return runtime;
      }),
    );

    const invalidateRuntime = (failedRuntime: OmpAccountRuntimeHandle) =>
      runtimeMutex.withPermit(
        Ref.update(runtimeRef, (current) =>
          Option.isSome(current) && current.value === failedRuntime ? Option.none() : current,
        ),
      );

    return (method: string, payload: unknown) =>
      getRuntime.pipe(
        Effect.flatMap((runtime) =>
          runtime.request(method, payload).pipe(
            Effect.catch((cause) => {
              const terminal = isTerminalFailure(cause);
              return (terminal ? invalidateRuntime(runtime) : Effect.void).pipe(
                Effect.andThen(
                  Effect.fail(
                    new OmpAccountTransportError({
                      detail: terminal
                        ? "OMP account transport ended; the cached runtime was discarded."
                        : "OMP could not complete the account request.",
                      ...(terminal ? { category: "runtime-restarted" as const } : {}),
                      cause,
                    }),
                  ),
                ),
              );
            }),
          ),
        ),
        Effect.mapError((cause) =>
          isOmpAccountTransportError(cause)
            ? cause
            : new OmpAccountTransportError({
                detail: "OMP could not start the account runtime.",
                cause,
              }),
        ),
      );
  },
);

export function accountMode(environment: NodeJS.ProcessEnv): "local" | "broker" {
  const mode = environment.T3_OMP_ACCOUNT_MODE?.trim();
  if (!mode || mode === "local") return "local";
  if (mode === "broker") return "broker";
  throw new Error("T3_OMP_ACCOUNT_MODE must be either local or broker");
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const runtimeScope = yield* Scope.Scope;
  const request = yield* makeRestartableOmpAccountRequest({
    isTerminalFailure: isTerminalOmpAccountRuntimeFailure,
    createRuntime: Effect.gen(function* () {
      const serverSettings = yield* settings.getSettings;
      const runtime = yield* makeOmpAcpRuntime({
        childProcessSpawner,
        ompSettings: serverSettings.providers.omp,
        cwd: config.cwd,
        environment: process.env,
        clientInfo: { name: "t3code-omp-accounts", version: "1" },
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(Scope.Scope, runtimeScope),
      );
      yield* runtime.start();
      return runtime;
    }),
  });

  return yield* makeOmpAccountService({
    mode: accountMode(process.env),
    request,
  });
});
