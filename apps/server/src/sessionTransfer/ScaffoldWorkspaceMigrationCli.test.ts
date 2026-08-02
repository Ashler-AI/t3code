import { describe, expect, it } from "@effect/vitest";
import {
  SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
  SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
  ScaffoldWorkspaceMigrationCommand,
  ScaffoldWorkspaceMigrationReceipt,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  makeScaffoldWorkspaceMigrationCli,
  ScaffoldWorkspaceMigrationCliError,
} from "./ScaffoldWorkspaceMigrationCli.ts";

const decodeWorkspaceMigrationCommand = Schema.decodeUnknownSync(ScaffoldWorkspaceMigrationCommand);
const encodeWorkspaceMigrationCommand = Schema.encodeSync(ScaffoldWorkspaceMigrationCommand);

const command = decodeWorkspaceMigrationCommand({
  version: "scaffold.workspace_migration.command.v1",
  operationId: "operation-1",
  cwd: "/repo/worktree",
  source: {
    environmentId: "source-environment",
    projectId: "source-project",
    threadId: "source-thread",
    globalSessionId: "sf:source-environment:source-thread",
    ompSessionId: "omp-session",
    model: "openai/gpt-5.6-sol",
    effort: "high",
    capturedAt: "2026-07-26T00:00:00.000Z",
    transcriptSha256: "e".repeat(64),
  },
  ompBundlePath: "/tmp/omp-session.zip",
  ompExport: {
    version: 1,
    sessionId: "omp-session",
    sourceChecksum: "c".repeat(64),
    files: [{ path: "sessions/omp-session.json", size: 10, sha256: "d".repeat(64) }],
  },
  t3MetadataPath: "/tmp/t3-metadata.json",
  t3MetadataSha256: "f".repeat(64),
  credentialExclusions: [...SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1],
  unsupportedFilesystemCases: [...SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1],
});

const receipt = Schema.decodeUnknownSync(ScaffoldWorkspaceMigrationReceipt)({
  ok: true,
  version: "scaffold.workspace_migration.receipt.v1",
  sessionId: "ses-destination",
  operationId: "operation-1",
  payloadDigestSha256: "a".repeat(64),
  archiveSha256: "b".repeat(64),
  ompBundleSha256: "c".repeat(64),
  t3MetadataSha256: "f".repeat(64),
  workspaceArchiveSha256: "b".repeat(64),
  transcriptSha256: "e".repeat(64),
  credentialExclusions: [...SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1],
  unsupportedFilesystemCases: [...SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1],
  binding: {
    deployment: "staging",
    environmentId: "destination-environment",
    sessionId: "ses-destination",
    lifecycleEpoch: 1,
    status: "ready",
    links: {
      session: "https://scaffold.example/?q=ses-destination",
      web: "https://scaffold.example/sessions/ses-destination/web",
      tilt: "https://scaffold.example/sessions/ses-destination/tilt",
    },
    lastKnownAt: "2026-07-26T00:00:00.000Z",
  },
  source: {
    environmentId: "source-environment",
    projectId: "source-project",
    threadId: "source-thread",
    globalSessionId: "sf:source-environment:source-thread",
    ompSessionId: "omp-session",
  },
  destination: {
    environmentId: "destination-environment",
    projectId: "destination-project",
    threadId: "destination-thread",
    globalSessionId: "sf:destination-environment:destination-thread",
    ompSessionId: "omp-destination",
  },
});

describe("ScaffoldWorkspaceMigrationCli", () => {
  it("requires the complete versioned migration declarations", () => {
    const encoded = encodeWorkspaceMigrationCommand(command);
    expect(() =>
      decodeWorkspaceMigrationCommand({
        ...encoded,
        unsupportedFilesystemCases: [],
      }),
    ).toThrow();
    expect(() =>
      decodeWorkspaceMigrationCommand({
        ...encoded,
        credentialExclusions: encoded.credentialExclusions.slice(1),
      }),
    ).toThrow();
    expect(() =>
      decodeWorkspaceMigrationCommand({
        ...encoded,
        credentialExclusions: encoded.credentialExclusions.toReversed(),
      }),
    ).toThrow();
  });

  it("uses the exact stdin CLI contract and accepts a new-identity receipt", async () => {
    const calls: unknown[] = [];
    const cli = makeScaffoldWorkspaceMigrationCli({
      process: {
        run: async (input) => {
          calls.push(input);
          return {
            stdout: JSON.stringify(receipt),
            stderr: "",
            code: 0,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
      },
      environmentForDeployment: (deployment) => ({
        SCAFFOLD_CONTROL_PLANE_URL: `https://${deployment}.example`,
      }),
    });

    await expect(cli.migrate(command, "staging")).resolves.toEqual(receipt);
    expect(command.source.capturedAt).toBe("2026-07-26T00:00:00.000Z");
    expect(command.credentialExclusions).toEqual(
      SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
    );
    expect(command.unsupportedFilesystemCases).toEqual(
      SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
    );
    expect(calls).toEqual([
      expect.objectContaining({
        command: "scaffold-handoff",
        args: ["workspace-migrate", "--input", "-", "--json"],
        stdin: JSON.stringify(command),
        env: {
          SCAFFOLD_CONTROL_PLANE_URL: "https://staging.example",
        },
      }),
    ]);
  });

  it("durably binds the full proposal before acknowledging upload", async () => {
    const fingerprint = "8".repeat(64);
    const proposalPath = "/tmp/fresh-transfer/authority-proposal.json";
    const acknowledgementPath = "/tmp/fresh-transfer/authority-acknowledgement.json";
    const commandWithHandshake = decodeWorkspaceMigrationCommand({
      ...encodeWorkspaceMigrationCommand(command),
      requestFingerprintSha256: fingerprint,
      authorityHandshake: { proposalPath, acknowledgementPath },
    });
    const binding = {
      operationId: command.operationId,
      requestFingerprintSha256: fingerprint,
      sessionId: receipt.sessionId,
      sandboxId: "sandbox-1",
      lifecycleEpoch: 1,
      grantId: "grant-1",
      payloadDigestSha256: receipt.payloadDigestSha256,
      archiveSha256: receipt.archiveSha256,
      transcriptSha256: receipt.transcriptSha256,
      ompBundleSha256: receipt.ompBundleSha256,
      t3MetadataSha256: receipt.t3MetadataSha256,
      state: "pending",
      processingDeadlineAt: "2026-07-26T00:02:00.000Z",
    } as const;
    const files = new Map<string, string>();
    let bound: unknown;
    const cli = makeScaffoldWorkspaceMigrationCli({
      process: {
        run: async () => {
          files.set(
            proposalPath,
            JSON.stringify({
              version: "scaffold.workspace_migration.authority_proposal.v1",
              operationId: command.operationId,
              requestFingerprintSha256: fingerprint,
              binding,
            }),
          );
          return {
            stdout: JSON.stringify(receipt),
            stderr: "",
            code: 0,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
      },
      authorityFiles: {
        read: async (path) => files.get(path),
        writeAtomic: async (path, contents) => {
          expect(bound).toEqual(binding);
          files.set(path, contents);
        },
        sleep: async () => undefined,
      },
    });

    await cli.migrate(commandWithHandshake, "staging", async (authority) => {
      bound = authority;
    });
    expect(JSON.parse(files.get(acknowledgementPath) ?? "null")).toEqual({
      version: "scaffold.workspace_migration.authority_ack.v1",
      operationId: command.operationId,
      requestFingerprintSha256: fingerprint,
      grantId: "grant-1",
    });
  });

  it("uses authenticated status and abort CLI commands", async () => {
    const calls: unknown[] = [];
    const cli = makeScaffoldWorkspaceMigrationCli({
      process: {
        run: async (input) => {
          calls.push(input);
          return {
            stdout: JSON.stringify({ error: "workspace_migration_operation_unknown" }),
            stderr: "",
            code: 0,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
      },
    });
    const operation = {
      operationId: command.operationId,
      requestFingerprintSha256: "8".repeat(64),
      deployment: "staging" as const,
    };
    await cli.reconcile(operation);
    await cli.abort(operation);
    expect(calls).toEqual([
      expect.objectContaining({
        args: ["workspace-migration-status", "--input", "-", "--json"],
        stdin: JSON.stringify({
          operationId: operation.operationId,
          requestFingerprintSha256: operation.requestFingerprintSha256,
        }),
      }),
      expect.objectContaining({
        args: ["workspace-migration-abort", "--input", "-", "--json"],
        stdin: JSON.stringify({
          operationId: operation.operationId,
          requestFingerprintSha256: operation.requestFingerprintSha256,
        }),
      }),
    ]);
  });

  it("maps a two-line handoff 404 response to unresolved authority", async () => {
    const cli = makeScaffoldWorkspaceMigrationCli({
      process: {
        run: async () => ({
          stdout: "",
          stderr:
            'Workspace migration operation was not found.\n{"code":"workspace_migration_operation_unknown","status":404}\n',
          code: 1,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      },
    });
    await expect(
      cli.reconcile({
        operationId: command.operationId,
        requestFingerprintSha256: "8".repeat(64),
        deployment: "staging",
      }),
    ).resolves.toEqual({ error: "workspace_migration_operation_unknown" });
  });

  it("rejects a receipt that reuses source identity", async () => {
    const cli = makeScaffoldWorkspaceMigrationCli({
      process: {
        run: async () => ({
          stdout: JSON.stringify({
            ...receipt,
            destination: { ...receipt.destination, threadId: command.source.threadId },
          }),
          stderr: "",
          code: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      },
    });

    await expect(cli.migrate(command, "staging")).rejects.toBeInstanceOf(
      ScaffoldWorkspaceMigrationCliError,
    );
  });

  it("surfaces a safe Scaffold error code without response details", async () => {
    const cli = makeScaffoldWorkspaceMigrationCli({
      process: {
        run: async () => ({
          stdout: "",
          stderr: `${JSON.stringify({
            code: "workspace_migration_destination_not_ready",
            status: 409,
            body: { reason: "agent_transport_authority_missing" },
          })}\n`,
          code: 1,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      },
    });

    await expect(cli.migrate(command, "staging")).rejects.toMatchObject({
      code: "workspace_migration_destination_not_ready",
      detail: "Scaffold workspace migration failed (workspace_migration_destination_not_ready).",
      status: 409,
    });
  });

  it.each([
    ["OMP bundle", { ompBundleSha256: "9".repeat(64) }],
    ["T3 metadata", { t3MetadataSha256: "9".repeat(64) }],
    ["archive alias", { archiveSha256: "9".repeat(64) }],
    ["credential exclusions", { credentialExclusions: [] }],
    ["unsupported filesystem cases", { unsupportedFilesystemCases: [] }],
  ])("rejects mismatched %s provenance", async (_label, overrides) => {
    const cli = makeScaffoldWorkspaceMigrationCli({
      process: {
        run: async () => ({
          stdout: JSON.stringify({ ...receipt, ...overrides }),
          stderr: "",
          code: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      },
    });

    await expect(cli.migrate(command, "staging")).rejects.toBeInstanceOf(
      ScaffoldWorkspaceMigrationCliError,
    );
  });
});
