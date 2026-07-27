import * as NodeCrypto from "node:crypto";

import {
  SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
  SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
  ScaffoldWorkspaceMigrationAuthorityAcknowledgement,
  ScaffoldWorkspaceMigrationAuthorityProposal,
  ScaffoldWorkspaceMigrationCommand,
  ScaffoldWorkspaceMigrationReceipt,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ProcessRunner } from "../processRunner.ts";

export class ScaffoldWorkspaceMigrationCliError extends Data.TaggedError(
  "ScaffoldWorkspaceMigrationCliError",
)<{
  readonly code: string;
  readonly detail: string;
  readonly status?: number;
}> {}

export interface ScaffoldWorkspaceMigrationProcessPort {
  readonly run: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin: string;
    readonly timeout: Duration.Input;
    readonly maxOutputBytes: number;
  }) => Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number | null;
    readonly timedOut: boolean;
    readonly stdoutTruncated: boolean;
    readonly stderrTruncated: boolean;
  }>;
}

const decodeReceipt = Schema.decodeUnknownSync(ScaffoldWorkspaceMigrationReceipt);
const decodeAuthorityProposal = Schema.decodeUnknownSync(
  ScaffoldWorkspaceMigrationAuthorityProposal,
);
const encodeAuthorityAcknowledgement = Schema.encodeSync(
  Schema.fromJsonString(ScaffoldWorkspaceMigrationAuthorityAcknowledgement),
);

interface AuthorityFiles {
  readonly read: (path: string) => Promise<string | undefined>;
  readonly writeAtomic: (path: string, contents: string) => Promise<void>;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

function validateReceipt(
  command: ScaffoldWorkspaceMigrationCommand,
  receipt: ScaffoldWorkspaceMigrationReceipt,
): ScaffoldWorkspaceMigrationReceipt {
  if (
    receipt.operationId !== command.operationId ||
    receipt.binding.sessionId !== receipt.sessionId ||
    receipt.binding.environmentId !== receipt.destination.environmentId ||
    (receipt.binding.status !== "ready" && receipt.binding.status !== "agent_running") ||
    receipt.source.environmentId !== command.source.environmentId ||
    receipt.source.projectId !== command.source.projectId ||
    receipt.source.threadId !== command.source.threadId ||
    receipt.source.globalSessionId !== command.source.globalSessionId ||
    receipt.source.ompSessionId !== command.source.ompSessionId ||
    receipt.transcriptSha256 !== command.source.transcriptSha256 ||
    receipt.ompBundleSha256 !== command.ompExport.sourceChecksum ||
    receipt.t3MetadataSha256 !== command.t3MetadataSha256 ||
    receipt.archiveSha256 !== receipt.workspaceArchiveSha256 ||
    JSON.stringify(receipt.credentialExclusions) !== JSON.stringify(command.credentialExclusions) ||
    JSON.stringify(receipt.credentialExclusions) !==
      JSON.stringify(SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1) ||
    JSON.stringify(receipt.unsupportedFilesystemCases) !==
      JSON.stringify(command.unsupportedFilesystemCases) ||
    JSON.stringify(receipt.unsupportedFilesystemCases) !==
      JSON.stringify(SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1) ||
    receipt.destination.environmentId === command.source.environmentId ||
    receipt.destination.projectId === command.source.projectId ||
    receipt.destination.threadId === command.source.threadId ||
    receipt.destination.globalSessionId !==
      `sf:${receipt.destination.environmentId}:${receipt.destination.threadId}` ||
    receipt.destination.ompSessionId === command.source.ompSessionId
  ) {
    throw new ScaffoldWorkspaceMigrationCliError({
      code: "scaffold_workspace_migration_receipt_mismatch",
      detail: "Scaffold returned a receipt that does not preserve copy-with-provenance identity.",
    });
  }
  return receipt;
}

export function makeScaffoldWorkspaceMigrationCli(options: {
  readonly process: ScaffoldWorkspaceMigrationProcessPort;
  readonly authorityFiles?: AuthorityFiles;
}) {
  const run = async (args: ReadonlyArray<string>, input: unknown) => {
    const output = await options.process.run({
      command: "scaffold-handoff",
      args,
      stdin: JSON.stringify(input),
      timeout: Duration.minutes(5),
      maxOutputBytes: 1024 * 1024,
    });
    if (output.timedOut || output.code !== 0) {
      let errorStatus: number | undefined;
      let errorCode: string | undefined;
      try {
        const lastLine = output.stderr
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1);
        const error = JSON.parse(lastLine ?? "null") as Record<string, unknown>;
        if (typeof error.status === "number") errorStatus = error.status;
        if (typeof error.code === "string") errorCode = error.code;
      } catch {
        // The process error below remains intentionally credential-free.
      }
      throw new ScaffoldWorkspaceMigrationCliError({
        code: output.timedOut
          ? "scaffold_workspace_migration_timeout"
          : (errorCode ?? "scaffold_workspace_migration_failed"),
        detail: output.timedOut
          ? "Scaffold workspace migration timed out."
          : `Scaffold workspace migration failed with exit code ${String(output.code)}.`,
        ...(errorStatus === undefined ? {} : { status: errorStatus }),
      });
    }
    try {
      return JSON.parse(output.stdout.trim()) as unknown;
    } catch {
      throw new ScaffoldWorkspaceMigrationCliError({
        code: "scaffold_workspace_migration_invalid_response",
        detail: "Scaffold workspace migration did not return JSON.",
      });
    }
  };

  const migrate = async (
    command: ScaffoldWorkspaceMigrationCommand,
    bindAuthority?: (
      binding: ScaffoldWorkspaceMigrationAuthorityProposal["binding"],
    ) => Promise<void>,
  ): Promise<ScaffoldWorkspaceMigrationReceipt> => {
    const processPromise = run(["workspace-migrate", "--input", "-", "--json"], command);
    const handshake = command.authorityHandshake;
    if (bindAuthority && handshake) {
      const files = options.authorityFiles;
      if (!files) {
        throw new ScaffoldWorkspaceMigrationCliError({
          code: "scaffold_workspace_migration_authority_files_unavailable",
          detail: "Workspace migration authority files are unavailable.",
        });
      }
      const deadline = performance.now() + 120_000;
      let proposal: ScaffoldWorkspaceMigrationAuthorityProposal | undefined;
      while (!proposal && performance.now() < deadline) {
        const raw = await files.read(handshake.proposalPath);
        if (raw !== undefined) {
          try {
            proposal = decodeAuthorityProposal(JSON.parse(raw));
          } catch {
            throw new ScaffoldWorkspaceMigrationCliError({
              code: "scaffold_workspace_migration_authority_proposal_invalid",
              detail: "Scaffold returned an invalid authority proposal.",
            });
          }
          break;
        }
        const completed = await Promise.race([
          processPromise.then(() => true),
          files.sleep(50).then(() => false),
        ]);
        if (completed) break;
      }
      if (!proposal) {
        await processPromise;
        throw new ScaffoldWorkspaceMigrationCliError({
          code: "scaffold_workspace_migration_authority_proposal_missing",
          detail: "Scaffold did not provide a pre-upload authority proposal.",
        });
      }
      if (
        proposal.operationId !== command.operationId ||
        proposal.binding.operationId !== command.operationId ||
        proposal.requestFingerprintSha256 !== command.requestFingerprintSha256 ||
        proposal.binding.requestFingerprintSha256 !== command.requestFingerprintSha256
      ) {
        throw new ScaffoldWorkspaceMigrationCliError({
          code: "scaffold_workspace_migration_authority_proposal_mismatch",
          detail: "Scaffold returned authority for a different migration operation.",
        });
      }
      await bindAuthority(proposal.binding);
      await files.writeAtomic(
        handshake.acknowledgementPath,
        encodeAuthorityAcknowledgement(
          new ScaffoldWorkspaceMigrationAuthorityAcknowledgement({
            version: "scaffold.workspace_migration.authority_ack.v1",
            operationId: proposal.operationId,
            requestFingerprintSha256: proposal.requestFingerprintSha256,
            grantId: proposal.binding.grantId,
          }),
        ),
      );
    }

    const parsed = await processPromise;
    try {
      return validateReceipt(command, decodeReceipt(parsed));
    } catch (error) {
      if (error instanceof ScaffoldWorkspaceMigrationCliError) throw error;
      throw new ScaffoldWorkspaceMigrationCliError({
        code: "scaffold_workspace_migration_invalid_receipt",
        detail: "Scaffold workspace migration returned an invalid receipt.",
      });
    }
  };

  const reconcileOrAbort = async (
    command: "workspace-migration-status" | "workspace-migration-abort",
    input: { operationId: string; requestFingerprintSha256: string },
  ) => {
    try {
      return await run([command, "--input", "-", "--json"], input);
    } catch (error) {
      if (error instanceof ScaffoldWorkspaceMigrationCliError && error.status === 404) {
        return { error: "workspace_migration_operation_unknown" };
      }
      throw error;
    }
  };
  const reconcile = (input: { operationId: string; requestFingerprintSha256: string }) =>
    reconcileOrAbort("workspace-migration-status", input);
  const abort = (input: { operationId: string; requestFingerprintSha256: string }) =>
    reconcileOrAbort("workspace-migration-abort", input);

  return { migrate, reconcile, abort };
}

export const makeLiveScaffoldWorkspaceMigrationCli = Effect.fn(
  "makeLiveScaffoldWorkspaceMigrationCli",
)(function* () {
  const runner = yield* ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return makeScaffoldWorkspaceMigrationCli({
    process: {
      run: (input) => runner.run(input).pipe(Effect.runPromise),
    },
    authorityFiles: {
      read: (filePath) =>
        fileSystem.readFileString(filePath).pipe(
          Effect.map((contents) => contents as string | undefined),
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(undefined as string | undefined)
              : Effect.fail(error),
          ),
          Effect.runPromise,
        ),
      writeAtomic: (filePath, contents) =>
        Effect.gen(function* () {
          const temporaryPath = path.join(
            path.dirname(filePath),
            `.${path.basename(filePath)}.${NodeCrypto.randomUUID()}.tmp`,
          );
          yield* fileSystem.writeFileString(temporaryPath, contents, { mode: 0o600 });
          yield* fileSystem.rename(temporaryPath, filePath);
        }).pipe(Effect.runPromise),
      sleep: (milliseconds) => Effect.sleep(Duration.millis(milliseconds)).pipe(Effect.runPromise),
    },
  });
});
