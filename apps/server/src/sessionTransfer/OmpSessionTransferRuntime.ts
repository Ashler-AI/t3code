import type { OmpSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeOmpAcpRuntime } from "../provider/acp/OmpAcpSupport.ts";

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ExportResponse = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  archivePath: Schema.String,
  sourceChecksum: Sha256Hex,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      sha256: Sha256Hex,
    }),
  ),
});
const ImportResponse = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  sessionFile: Schema.String,
  sourceChecksum: Sha256Hex,
  installedChecksums: Schema.Record(Schema.String, Sha256Hex),
  idempotent: Schema.Boolean,
});

export type OmpSessionExport = typeof ExportResponse.Type;
export type OmpSessionImport = typeof ImportResponse.Type;

export interface OmpSessionTransferRuntimeOptions {
  readonly cwd: string;
  readonly ompSettings: Pick<OmpSettings, "binaryPath"> | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/** Dedicated ACP control process. It transfers only OMP's portable session bundle. */
export const makeOmpSessionTransferRuntime = Effect.fn("makeOmpSessionTransferRuntime")(function* (
  options: OmpSessionTransferRuntimeOptions,
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const runtime = yield* makeOmpAcpRuntime({
    childProcessSpawner,
    ompSettings: options.ompSettings,
    cwd: options.cwd,
    ...(options.environment ? { environment: options.environment } : {}),
    clientInfo: { name: "t3code-omp-session-transfer", version: "1" },
  }).pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.provideService(Scope.Scope, scope));
  yield* runtime.start();

  return {
    exportSession: (input: { readonly sessionId: string; readonly archivePath: string }) =>
      runtime
        .request("_omp/session/export", input)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ExportResponse))),
    importSession: (input: {
      readonly archivePath: string;
      readonly cwd: string;
      readonly sessionDir?: string;
      readonly sourceChecksum?: string;
      readonly additionalDirectories?: ReadonlyArray<string>;
      readonly destinationSessionId?: string;
    }) =>
      runtime
        .request("_omp/session/import", input)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ImportResponse))),
  };
});
