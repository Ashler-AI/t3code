import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
  OMP_ACCOUNT_METHODS,
  OmpAccountTransportError,
} from "./OmpAccountService.ts";

export interface OmpAccountRuntimeHandle {
  readonly request: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly dispose?: Effect.Effect<void>;
}

interface CachedOmpAccountRuntime {
  readonly runtime: OmpAccountRuntimeHandle;
  readonly signature: string | undefined;
  readonly activeLoginFlowIds: ReadonlySet<string>;
  readonly inFlightRequests: number;
}

function payloadFlowId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const flowId = (payload as { readonly flowId?: unknown }).flowId;
  return typeof flowId === "string" && flowId.length > 0 ? flowId : undefined;
}

function challengeFlowId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as {
    readonly flowId?: unknown;
    readonly kind?: unknown;
    readonly status?: unknown;
  };
  const discriminator =
    typeof record.kind === "string"
      ? record.kind
      : typeof record.status === "string"
        ? record.status
        : undefined;
  const continues =
    discriminator === "browser" || discriminator === "input" || discriminator === "code";
  return continues && typeof record.flowId === "string" && record.flowId.length > 0
    ? record.flowId
    : undefined;
}

function trackLoginResult(
  activeLoginFlowIds: ReadonlySet<string>,
  method: string,
  payload: unknown,
  result: unknown,
): ReadonlySet<string> {
  const next = new Set(activeLoginFlowIds);
  if (method === OMP_ACCOUNT_METHODS.login) {
    const flowId = challengeFlowId(result);
    if (flowId) next.add(flowId);
    return next;
  }

  const flowId = payloadFlowId(payload);
  if (!flowId) return next;
  if (method === OMP_ACCOUNT_METHODS.loginCancel) {
    next.delete(flowId);
  } else if (method === OMP_ACCOUNT_METHODS.loginRespond) {
    const continuingFlowId = challengeFlowId(result);
    next.delete(flowId);
    if (continuingFlowId) next.add(continuingFlowId);
  }
  return next;
}

function commandLookupEnvironment(
  environment: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform,
  path: Path.Path,
): NodeJS.ProcessEnv {
  const key =
    environment.PATH !== undefined ? "PATH" : environment.Path !== undefined ? "Path" : "path";
  const value = environment[key];
  if (!value) return environment;
  const delimiter = platform === "win32" ? ";" : ":";
  const normalized = value
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"+|"+$/g, ""))
    .filter(Boolean)
    .map((entry) => (path.isAbsolute(entry) ? entry : path.resolve(cwd, entry)))
    .join(delimiter);
  return { ...environment, [key]: normalized };
}

/** Fingerprint the executable identity, including inode replacement at the same path. */
export function ompExecutableSignature(input: {
  readonly command: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.Effect<string> {
  return Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = commandLookupEnvironment(
      input.environment ?? process.env,
      input.cwd,
      platform,
      path,
    );
    const command =
      (input.command.includes("/") || input.command.includes("\\")) &&
      !path.isAbsolute(input.command)
        ? path.resolve(input.cwd, input.command)
        : input.command;
    const resolved = yield* resolveCommandPath(command, { env: environment }).pipe(
      Effect.catchTag("CommandResolutionError", () => Effect.succeed(command)),
    );
    return yield* fileSystem.stat(resolved).pipe(
      Effect.map((info) =>
        [
          resolved,
          info.dev,
          Option.getOrUndefined(info.ino),
          info.size,
          info.mode,
          Option.getOrUndefined(info.mtime)?.getTime(),
          Option.getOrUndefined(info.birthtime)?.getTime(),
        ].join(":"),
      ),
      Effect.orElseSucceed(() => `unavailable:${resolved}`),
    );
  }).pipe(Effect.provide(NodeServices.layer));
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
  function* <E, ESignature>(options: {
    readonly createRuntime: Effect.Effect<OmpAccountRuntimeHandle, E>;
    readonly getRuntimeSignature?: Effect.Effect<string, ESignature>;
    readonly isTerminalFailure?: (cause: unknown) => boolean;
  }) {
    const runtimeRef = yield* Ref.make<Option.Option<CachedOmpAccountRuntime>>(Option.none());
    const runtimeMutex = yield* Semaphore.make(1);
    const isTerminalFailure = options.isTerminalFailure ?? isTerminalOmpAccountRuntimeFailure;

    const disposeRuntime = (runtime: OmpAccountRuntimeHandle) =>
      runtime.dispose ?? Effect.succeed(undefined);

    const acquireRuntime = runtimeMutex.withPermit(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(runtimeRef);
          if (
            Option.isSome(current) &&
            (current.value.activeLoginFlowIds.size > 0 || current.value.inFlightRequests > 0)
          ) {
            const acquired = {
              ...current.value,
              inFlightRequests: current.value.inFlightRequests + 1,
            };
            yield* Ref.set(runtimeRef, Option.some(acquired));
            return acquired.runtime;
          }

          const signature = yield* restore(
            options.getRuntimeSignature ?? Effect.succeed(undefined),
          );
          if (Option.isSome(current) && current.value.signature === signature) {
            const acquired = { ...current.value, inFlightRequests: 1 };
            yield* Ref.set(runtimeRef, Option.some(acquired));
            return acquired.runtime;
          }

          if (Option.isSome(current)) {
            yield* Ref.set(runtimeRef, Option.none());
            yield* disposeRuntime(current.value.runtime);
          }

          const runtime = yield* restore(options.createRuntime);
          yield* Ref.set(
            runtimeRef,
            Option.some({
              runtime,
              signature,
              activeLoginFlowIds: new Set(),
              inFlightRequests: 1,
            }),
          );
          return runtime;
        }),
      ),
    );

    const trackRequestResult = (
      runtime: OmpAccountRuntimeHandle,
      method: string,
      payload: unknown,
      result: unknown,
    ) =>
      runtimeMutex.withPermit(
        Ref.update(runtimeRef, (current) =>
          Option.isSome(current) && current.value.runtime === runtime
            ? Option.some({
                ...current.value,
                activeLoginFlowIds: trackLoginResult(
                  current.value.activeLoginFlowIds,
                  method,
                  payload,
                  result,
                ),
              })
            : current,
        ),
      );

    const releaseRequest = (runtime: OmpAccountRuntimeHandle) =>
      runtimeMutex.withPermit(
        Ref.update(runtimeRef, (current) =>
          Option.isSome(current) && current.value.runtime === runtime
            ? Option.some({
                ...current.value,
                inFlightRequests: Math.max(0, current.value.inFlightRequests - 1),
              })
            : current,
        ),
      );

    const invalidateRuntime = (runtime: OmpAccountRuntimeHandle) =>
      runtimeMutex.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(runtimeRef);
          if (Option.isNone(current) || current.value.runtime !== runtime) return;
          yield* Ref.set(runtimeRef, Option.none());
          yield* disposeRuntime(runtime);
        }),
      );

    return (method: string, payload: unknown) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const runtime = yield* restore(acquireRuntime);
          return yield* restore(
            runtime.request(method, payload).pipe(
              Effect.tap((result) => trackRequestResult(runtime, method, payload, result)),
              Effect.catch((cause) => {
                const terminal = isTerminalFailure(cause);
                return (terminal ? invalidateRuntime(runtime) : Effect.succeed(undefined)).pipe(
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
          ).pipe(Effect.ensuring(releaseRequest(runtime)));
        }),
      ).pipe(
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
  const parentRuntimeScope = yield* Scope.Scope;
  const request = yield* makeRestartableOmpAccountRequest({
    isTerminalFailure: isTerminalOmpAccountRuntimeFailure,
    getRuntimeSignature: settings.getSettings.pipe(
      Effect.flatMap((serverSettings) =>
        ompExecutableSignature({
          command: serverSettings.providers.omp?.binaryPath || "omp",
          cwd: config.cwd,
          environment: process.env,
        }),
      ),
    ),
    createRuntime: Effect.gen(function* () {
      const serverSettings = yield* settings.getSettings;
      const runtimeScope = yield* Scope.fork(parentRuntimeScope, "sequential");
      const runtime = yield* Effect.gen(function* () {
        const created = yield* makeOmpAcpRuntime({
          childProcessSpawner,
          ompSettings: serverSettings.providers.omp,
          cwd: config.cwd,
          environment: process.env,
          clientInfo: { name: "t3code-omp-accounts", version: "1" },
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Scope.Scope, runtimeScope),
        );
        yield* created.start();
        return created;
      }).pipe(Effect.onError(() => Scope.close(runtimeScope, Exit.void).pipe(Effect.ignore)));
      return {
        request: (method, payload) => runtime.request(method, payload),
        dispose: Scope.close(runtimeScope, Exit.void).pipe(Effect.ignore),
      } satisfies OmpAccountRuntimeHandle;
    }),
  });

  return yield* makeOmpAccountService({
    mode: accountMode(process.env),
    request,
  });
});
