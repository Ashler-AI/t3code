import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import type * as AcpSessionRuntime from "../provider/acp/AcpSessionRuntime.ts";
import { makeOmpAcpRuntime } from "../provider/acp/OmpAcpSupport.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeOmpAccountService, OmpAccountTransportError } from "./OmpAccountService.ts";

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];

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
  const runtimeRef = yield* Ref.make<Option.Option<Runtime>>(Option.none());
  const runtimeMutex = yield* Semaphore.make(1);

  const getRuntime = runtimeMutex.withPermit(
    Effect.gen(function* () {
      const current = yield* Ref.get(runtimeRef);
      if (Option.isSome(current)) return current.value;

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
      yield* Ref.set(runtimeRef, Option.some(runtime));
      return runtime;
    }),
  );

  return yield* makeOmpAccountService({
    mode: accountMode(process.env),
    request: (method, payload) =>
      getRuntime.pipe(
        Effect.flatMap((runtime) => runtime.request(method, payload)),
        Effect.mapError(
          (cause) =>
            new OmpAccountTransportError({
              detail: "OMP could not complete the account request.",
              cause,
            }),
        ),
      ),
  });
});
