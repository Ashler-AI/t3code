import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import {
  SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
  SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
  ScaffoldWorkspaceMigrationImportInput,
  ScaffoldWorkspaceMigrationImportResult,
  SessionTransferSource,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  makeWorkspaceMigrationImportService,
  type WorkspaceMigrationPathPort,
  workspaceMigrationPayloadDigest,
} from "./WorkspaceMigrationImportService.ts";

const operationId = "operation-1";
const decodeSessionTransferSource = Schema.decodeUnknownSync(SessionTransferSource);
const encodeSessionTransferSource = Schema.encodeSync(SessionTransferSource);
const decodeImportInput = Schema.decodeUnknownSync(ScaffoldWorkspaceMigrationImportInput);
const encodeImportInput = Schema.encodeSync(ScaffoldWorkspaceMigrationImportInput);
const joinPath = (...parts: ReadonlyArray<string>) => parts.join("/").replace(/\/{2,}/g, "/");
const relativePath = (from: string, to: string) =>
  to.startsWith(`${from}/`) ? to.slice(from.length + 1) : `../${to.replace(/^\//, "")}`;
const workspaceLstat = async (path: string) =>
  path.endsWith("removed.ts")
    ? undefined
    : {
        kind: path.endsWith("current") ? ("symbolic-link" as const) : ("file" as const),
        mode: 0o644,
      };
const operationDirectory = joinPath(
  "/runtime",
  "workspace-migrations",
  NodeCrypto.createHash("sha256").update(operationId).digest("hex").slice(0, 32),
);
const destinationOmpSessionId = "omp-destination";
const provenance = {
  sourceEnvironmentId: "env-source" as never,
  sourceProjectId: "project-source" as never,
  sourceThreadId: "thread-source" as never,
  sourceGlobalSessionId: "sf:env-source:thread-source",
  sourceOmpSessionId: "omp-source",
};

function source(): SessionTransferSource {
  return decodeSessionTransferSource({
    environmentId: "env-source",
    projectId: "project-source",
    threadId: "thread-source",
    rootPath: "/source",
    title: "Transferred thread",
    modelSelection: {
      instanceId: "omp",
      model: "openai/gpt-5.6-sol",
      options: [{ id: "thinking", value: "high" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    continuation: {
      provider: "omp",
      sessionId: "omp-source",
      eventSequence: 8,
      acpSequence: 13,
    },
    capturedAt: "2026-07-26T00:00:00.000Z",
    transcriptSha256: "6".repeat(64),
  });
}

function request(overrides: Record<string, unknown> = {}): ScaffoldWorkspaceMigrationImportInput {
  const sourceInput = {
    environmentId: "env-source",
    projectId: "project-source",
    threadId: "thread-source",
    globalSessionId: "sf:env-source:thread-source",
    ompSessionId: "omp-source",
    title: "Transferred thread",
    model: "openai/gpt-5.6-sol",
    effort: "high",
    capturedAt: "2026-07-26T00:00:00.000Z",
    transcriptSha256: "6".repeat(64),
  } as const;
  const ompBundleSha256 = NodeCrypto.createHash("sha256").update("omp").digest("hex");
  const t3MetadataSha256 = NodeCrypto.createHash("sha256").update("metadata").digest("hex");
  const workspaceArchiveSha256 = "b".repeat(64);
  const payloadWithoutDigest = {
    version: "scaffold.workspace_migration.payload.v1" as const,
    operationId,
    source: {
      environmentId: sourceInput.environmentId,
      projectId: sourceInput.projectId,
      threadId: sourceInput.threadId,
      globalSessionId: sourceInput.globalSessionId,
      ompSessionId: sourceInput.ompSessionId,
      model: sourceInput.model,
      effort: sourceInput.effort,
      capturedAt: sourceInput.capturedAt,
      transcriptSha256: sourceInput.transcriptSha256,
    },
    ompBundle: {
      path: ".__scaffold_workspace_migration__/omp-session.zip" as const,
      bytes: 3,
      sha256: ompBundleSha256,
    },
    ompExport: {
      version: 1 as const,
      sessionId: "omp-source",
      sourceChecksum: ompBundleSha256,
      files: [{ path: "session.json", size: 12, sha256: "2".repeat(64) }],
    },
    t3Metadata: {
      path: ".__scaffold_workspace_migration__/t3-metadata.json" as const,
      bytes: 8,
      sha256: t3MetadataSha256,
    },
    credentialExclusions: [...SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1],
    unsupportedFilesystemCases: [...SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1],
  };
  const payloadDigestSha256 = workspaceMigrationPayloadDigest({
    ...payloadWithoutDigest,
    digestSha256: "0".repeat(64),
  });
  const authorityBinding = {
    grantId: `grant-${operationId}`,
    sandboxId: "sandbox-destination",
    sessionId: "session-destination",
    lifecycleEpoch: 7,
    operationId,
    processingDeadlineAt: "2026-07-26T00:10:00.000Z",
    payloadDigestSha256,
    archiveSha256: workspaceArchiveSha256,
    transcriptSha256: sourceInput.transcriptSha256,
    ompBundleSha256,
    t3MetadataSha256,
  };
  const requestFingerprintSha256 = "9".repeat(64);
  return decodeImportInput({
    version: "scaffold.t3_workspace_migration.import.v1",
    operationId,
    requestFingerprintSha256,
    payloadDigestSha256,
    authority: {
      version: "scaffold.workspace_migration.import_authority.v1",
      authorityId: `wma_${"a".repeat(32)}`,
      grantId: authorityBinding.grantId,
      secret: "test-import-authority-secret",
      sandboxId: authorityBinding.sandboxId,
      sessionId: authorityBinding.sessionId,
      lifecycleEpoch: authorityBinding.lifecycleEpoch,
      operationId,
      payloadDigestSha256,
      archiveSha256: workspaceArchiveSha256,
      transcriptSha256: sourceInput.transcriptSha256,
      ompBundleSha256,
      t3MetadataSha256,
      requestFingerprintSha256,
      processingDeadlineAt: authorityBinding.processingDeadlineAt,
    },
    payload: { ...payloadWithoutDigest, digestSha256: payloadDigestSha256 },
    source: sourceInput,
    ompBundlePath: joinPath(operationDirectory, "omp-session.zip"),
    ompBundleSha256,
    ompBundleBytes: 3,
    t3MetadataPath: joinPath(operationDirectory, "t3-metadata.json"),
    t3MetadataSha256,
    t3MetadataBytes: 8,
    workspace: {
      rootDir: "/workspace",
      archiveSha256: workspaceArchiveSha256,
      files: [
        {
          path: "src/index.ts",
          bytes: 4,
          sha256: NodeCrypto.createHash("sha256").update("code").digest("hex"),
          mode: 0o644,
          executable: false,
        },
      ],
      tombstones: [{ path: "removed.ts" }],
      symlinks: [{ path: "current", target: "src" }],
    },
    ...overrides,
  });
}

function conflictingRequest(input: ScaffoldWorkspaceMigrationImportInput) {
  const encoded = encodeImportInput(input);
  const payloadWithoutDigest = {
    ...encoded.payload,
    source: { ...encoded.payload.source, model: "openai/different-model" },
  };
  const payloadDigestSha256 = workspaceMigrationPayloadDigest({
    ...payloadWithoutDigest,
    digestSha256: "0".repeat(64),
  });
  return decodeImportInput({
    ...encoded,
    payloadDigestSha256,
    payload: { ...payloadWithoutDigest, digestSha256: payloadDigestSha256 },
  });
}

function requestWithOperationBinding(
  input: ScaffoldWorkspaceMigrationImportInput,
  overrides: {
    readonly requestFingerprintSha256?: string;
    readonly workspaceArchiveSha256?: string;
  },
) {
  const encoded = encodeImportInput(input);
  const requestFingerprintSha256 =
    overrides.requestFingerprintSha256 ?? encoded.requestFingerprintSha256;
  const workspaceArchiveSha256 =
    overrides.workspaceArchiveSha256 ?? encoded.workspace.archiveSha256;
  return decodeImportInput({
    ...encoded,
    requestFingerprintSha256,
    authority: {
      ...encoded.authority,
      requestFingerprintSha256,
      archiveSha256: workspaceArchiveSha256,
    },
    workspace: {
      ...encoded.workspace,
      archiveSha256: workspaceArchiveSha256,
    },
  });
}

function requestWithFileMode(mode: 0o644 | 0o755, executable: boolean) {
  const encoded = encodeImportInput(request());
  return decodeImportInput({
    ...encoded,
    workspace: {
      ...encoded.workspace,
      files: encoded.workspace.files.map((file) => ({ ...file, mode, executable })),
    },
  });
}

describe("WorkspaceMigrationImportService", () => {
  it("matches the platform canonical payload digest vector", () => {
    const ompBundle = Buffer.from("omp bundle bytes");
    const t3Metadata = Buffer.from('{"title":"Source thread"}\n');
    const payload = {
      version: "scaffold.workspace_migration.payload.v1" as const,
      operationId: "migration:test-1",
      source: {
        environmentId: "env-source" as never,
        projectId: "project-source" as never,
        threadId: "thread-source" as never,
        globalSessionId: "sf:env-source:thread-source",
        ompSessionId: "omp-source",
        model: "openai/gpt-5.6-sol",
        effort: "high",
        capturedAt: "2026-07-26T00:00:00.000Z",
        transcriptSha256: "6".repeat(64),
      },
      ompBundle: {
        path: ".__scaffold_workspace_migration__/omp-session.zip" as const,
        bytes: ompBundle.length,
        sha256: NodeCrypto.createHash("sha256").update(ompBundle).digest("hex"),
      },
      ompExport: {
        version: 1 as const,
        sessionId: "omp-source",
        sourceChecksum: NodeCrypto.createHash("sha256").update(ompBundle).digest("hex"),
        files: [{ path: "session.json", size: 12, sha256: "1".repeat(64) }],
      },
      t3Metadata: {
        path: ".__scaffold_workspace_migration__/t3-metadata.json" as const,
        bytes: t3Metadata.length,
        sha256: NodeCrypto.createHash("sha256").update(t3Metadata).digest("hex"),
      },
      credentialExclusions: [...SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1],
      unsupportedFilesystemCases: [...SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1],
      digestSha256: "0".repeat(64),
    };

    expect(workspaceMigrationPayloadDigest(payload)).toBe(
      "124f9bef5f57cca2bba74b6d29c82e22d5cd115fc48aa76901ad7bbd8896e704",
    );
  });

  it("confines staged files, mints a fresh OMP identity, and imports exactly once", async () => {
    let imports = 0;
    const reads: string[] = [];
    const service = makeWorkspaceMigrationImportService({
      runtimeDir: "/runtime",
      workspaceRoot: "/workspace",
      paths: {
        join: joinPath,
        relative: relativePath,
        realPath: async (path) => path,
        lstat: workspaceLstat,
        readFile: async (path) => {
          reads.push(path);
          return Buffer.from(
            path.endsWith("t3-metadata.json")
              ? "metadata"
              : path.endsWith("src/index.ts")
                ? "code"
                : "omp",
          );
        },
        writeFileAtomically: async () => undefined,
        exists: async () => false,
        readLink: async () => "src",
      },
      decodeMetadata: () => source(),
      acquireCommitAuthority: async () => {},
      destination: {
        import: async ({ request: input, source: importedSource, ompBundle }) => {
          imports += 1;
          expect(importedSource.modelSelection.options).toEqual([
            { id: "thinking", value: "high" },
          ]);
          expect(ompBundle.toString()).toBe("omp");
          return new ScaffoldWorkspaceMigrationImportResult({
            environmentId: "env-destination" as never,
            projectId: "project-destination" as never,
            threadId: "thread-destination" as never,
            globalSessionId: "sf:env-destination:thread-destination",
            ompSessionId: destinationOmpSessionId,
            operationId: input.operationId,
            payloadDigestSha256: input.payloadDigestSha256,
            ompBundleSha256: input.ompBundleSha256,
            t3MetadataSha256: input.t3MetadataSha256,
            workspaceArchiveSha256: input.workspace.archiveSha256,
            transcriptSha256: input.source.transcriptSha256,
            credentialExclusions: [...SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1],
            unsupportedFilesystemCases: [
              ...SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
            ],
            provenance,
          });
        },
      },
    });

    const [first, duplicate] = await Promise.all([
      service.importSession(request()),
      service.importSession(request()),
    ]);

    expect(first).toEqual(duplicate);
    expect(first.ompSessionId).toBe(destinationOmpSessionId);
    expect(first.provenance.sourceOmpSessionId).toBe("omp-source");
    expect(imports).toBe(1);
    expect(reads).toHaveLength(3);
    await expect(service.importSession(conflictingRequest(request()))).rejects.toMatchObject({
      code: "workspace_migration_operation_conflict",
    });
    expect(imports).toBe(1);
  });

  it("rejects every concurrent waiter whose immutable operation binding differs", async () => {
    let releaseDestination!: () => void;
    const destinationRelease = new Promise<void>((resolve) => {
      releaseDestination = resolve;
    });
    let imports = 0;
    const service = makeWorkspaceMigrationImportService({
      runtimeDir: "/runtime",
      workspaceRoot: "/workspace",
      paths: {
        join: joinPath,
        relative: relativePath,
        realPath: async (path) => path,
        lstat: workspaceLstat,
        readFile: async (path) =>
          Buffer.from(
            path.endsWith("t3-metadata.json")
              ? "metadata"
              : path.endsWith("src/index.ts")
                ? "code"
                : "omp",
          ),
        writeFileAtomically: async () => undefined,
        exists: async () => false,
        readLink: async () => "src",
      },
      decodeMetadata: () => source(),
      acquireCommitAuthority: async () => {},
      destination: {
        import: async ({ request: input }) => {
          imports += 1;
          await destinationRelease;
          return new ScaffoldWorkspaceMigrationImportResult({
            environmentId: "env-destination" as never,
            projectId: "project-destination" as never,
            threadId: "thread-destination" as never,
            globalSessionId: "sf:env-destination:thread-destination",
            ompSessionId: destinationOmpSessionId,
            operationId: input.operationId,
            payloadDigestSha256: input.payloadDigestSha256,
            ompBundleSha256: input.ompBundleSha256,
            t3MetadataSha256: input.t3MetadataSha256,
            workspaceArchiveSha256: input.workspace.archiveSha256,
            transcriptSha256: input.source.transcriptSha256,
            credentialExclusions: [...SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1],
            unsupportedFilesystemCases: [
              ...SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
            ],
            provenance,
          });
        },
      },
    });
    const original = request();
    const running = service.importSession(original);
    const changedArchive = requestWithOperationBinding(original, {
      workspaceArchiveSha256: "c".repeat(64),
    });
    const changedRequestFingerprint = requestWithOperationBinding(original, {
      requestFingerprintSha256: "8".repeat(64),
    });

    expect(changedArchive.payloadDigestSha256).toBe(original.payloadDigestSha256);
    expect(changedRequestFingerprint.payloadDigestSha256).toBe(original.payloadDigestSha256);

    await expect(service.importSession(changedArchive)).rejects.toMatchObject({
      code: "workspace_migration_operation_conflict",
    });
    await expect(service.importSession(changedRequestFingerprint)).rejects.toMatchObject({
      code: "workspace_migration_operation_conflict",
    });

    releaseDestination();
    await expect(running).resolves.toMatchObject({ operationId });
    expect(imports).toBe(1);
  });

  it("rejects a capture timestamp that differs from the staged source metadata", async () => {
    let imports = 0;
    const service = makeWorkspaceMigrationImportService({
      runtimeDir: "/runtime",
      workspaceRoot: "/workspace",
      paths: {
        join: joinPath,
        relative: relativePath,
        realPath: async (path) => path,
        lstat: workspaceLstat,
        readFile: async (path) =>
          Buffer.from(
            path.endsWith("t3-metadata.json")
              ? "metadata"
              : path.endsWith("src/index.ts")
                ? "code"
                : "omp",
          ),
        writeFileAtomically: async () => undefined,
        exists: async () => false,
        readLink: async () => "src",
      },
      decodeMetadata: () =>
        decodeSessionTransferSource({
          ...encodeSessionTransferSource(source()),
          capturedAt: "2026-07-26T00:00:01.000Z",
        }),
      acquireCommitAuthority: async () => {},
      destination: {
        import: async () => {
          imports += 1;
          throw new Error("unreachable");
        },
      },
    });

    await expect(service.importSession(request())).rejects.toMatchObject({
      code: "workspace_migration_metadata_mismatch",
    });
    expect(imports).toBe(0);
  });

  it("rejects a staged path that escapes through realpath before import", async () => {
    let imports = 0;
    const service = makeWorkspaceMigrationImportService({
      runtimeDir: "/runtime",
      workspaceRoot: "/workspace",
      paths: {
        join: joinPath,
        relative: relativePath,
        realPath: async (path) =>
          path.endsWith("omp-session.zip") ? "/outside/omp-session.zip" : path,
        lstat: workspaceLstat,
        readFile: async () => Buffer.from("unused"),
        writeFileAtomically: async () => undefined,
        exists: async () => false,
        readLink: async () => "src",
      },
      decodeMetadata: () => source(),
      acquireCommitAuthority: async () => {},
      destination: {
        import: async () => {
          imports += 1;
          throw new Error("unreachable");
        },
      },
    });

    await expect(service.importSession(request())).rejects.toMatchObject({
      code: "workspace_migration_path_outside_staging",
    });
    expect(imports).toBe(0);
  });

  it("rejects changed file modes and inconsistent executable declarations", async () => {
    const importAttempts: Array<string> = [];
    const makeService = (actualMode: number) =>
      makeWorkspaceMigrationImportService({
        runtimeDir: "/runtime",
        workspaceRoot: "/workspace",
        paths: {
          join: joinPath,
          relative: relativePath,
          realPath: async (path) => path,
          lstat: async () => ({ kind: "file", mode: actualMode }),
          readFile: async (path) =>
            Buffer.from(
              path.endsWith("t3-metadata.json")
                ? "metadata"
                : path.endsWith("src/index.ts")
                  ? "code"
                  : "omp",
            ),
          writeFileAtomically: async () => undefined,
          exists: async () => false,
          readLink: async () => "src",
        },
        decodeMetadata: () => source(),
        acquireCommitAuthority: async () => {},
        destination: {
          import: async () => {
            importAttempts.push("destination");
            throw new Error("unreachable");
          },
        },
      });

    await expect(makeService(0o755).importSession(request())).rejects.toMatchObject({
      code: "workspace_migration_workspace_mode_mismatch",
    });
    await expect(
      makeService(0o755).importSession(requestWithFileMode(0o755, false)),
    ).rejects.toMatchObject({ code: "workspace_migration_workspace_mode_mismatch" });
    await expect(
      makeService(0o4755).importSession(requestWithFileMode(0o755, true)),
    ).rejects.toMatchObject({ code: "workspace_migration_workspace_mode_mismatch" });
    const encoded = encodeImportInput(request());
    expect(() =>
      decodeImportInput({
        ...encoded,
        workspace: {
          ...encoded.workspace,
          files: encoded.workspace.files.map((file) => ({ ...file, mode: 0o700 })),
        },
      }),
    ).toThrow();
    expect(importAttempts).toEqual([]);
  });

  it("uses no-follow entry types for dangling file, tombstone, and symlink paths", async () => {
    let imports = 0;
    const makeService = (
      lstat: WorkspaceMigrationPathPort["lstat"],
      readLink: WorkspaceMigrationPathPort["readLink"] = async () => "src",
    ) =>
      makeWorkspaceMigrationImportService({
        runtimeDir: "/runtime",
        workspaceRoot: "/workspace",
        paths: {
          join: joinPath,
          relative: relativePath,
          realPath: async (path) => path,
          lstat,
          readFile: async (path) =>
            Buffer.from(
              path.endsWith("t3-metadata.json")
                ? "metadata"
                : path.endsWith("src/index.ts")
                  ? "code"
                  : "omp",
            ),
          writeFileAtomically: async () => undefined,
          exists: async () => false,
          readLink,
        },
        decodeMetadata: () => source(),
        acquireCommitAuthority: async () => {},
        destination: {
          import: async ({ request: input }) => {
            imports += 1;
            return new ScaffoldWorkspaceMigrationImportResult({
              environmentId: "env-destination" as never,
              projectId: "project-destination" as never,
              threadId: "thread-destination" as never,
              globalSessionId: "sf:env-destination:thread-destination",
              ompSessionId: destinationOmpSessionId,
              operationId: input.operationId,
              payloadDigestSha256: input.payloadDigestSha256,
              ompBundleSha256: input.ompBundleSha256,
              t3MetadataSha256: input.t3MetadataSha256,
              workspaceArchiveSha256: input.workspace.archiveSha256,
              transcriptSha256: input.source.transcriptSha256,
              credentialExclusions: [...SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1],
              unsupportedFilesystemCases: [
                ...SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
              ],
              provenance,
            });
          },
        },
      });

    await expect(
      makeService(async (path) =>
        path.endsWith("src/index.ts")
          ? { kind: "symbolic-link", mode: 0o777 }
          : workspaceLstat(path),
      ).importSession(request()),
    ).rejects.toMatchObject({ code: "workspace_migration_workspace_file_type_mismatch" });
    await expect(
      makeService(async (path) =>
        path.endsWith("removed.ts") ? { kind: "symbolic-link", mode: 0o777 } : workspaceLstat(path),
      ).importSession(request()),
    ).rejects.toMatchObject({ code: "workspace_migration_tombstone_mismatch" });
    await expect(
      makeService(workspaceLstat, async () => "different-target").importSession(request()),
    ).rejects.toMatchObject({ code: "workspace_migration_symlink_mismatch" });

    await expect(makeService(workspaceLstat).importSession(request())).resolves.toMatchObject({
      operationId,
    });
    expect(imports).toBe(1);
  });

  it("reuses a durable receipt after service recreation without starting destination twice", async () => {
    let imports = 0;
    const persisted = new Map<string, Uint8Array>();
    const paths = {
      join: joinPath,
      relative: relativePath,
      realPath: async (path: string) => path,
      lstat: workspaceLstat,
      readFile: async (path: string) => {
        const stored = persisted.get(path);
        if (stored) return stored;
        return Buffer.from(
          path.endsWith("t3-metadata.json")
            ? "metadata"
            : path.endsWith("src/index.ts")
              ? "code"
              : "omp",
        );
      },
      writeFileAtomically: async (path: string, bytes: Uint8Array) => {
        persisted.set(path, bytes);
      },
      exists: async (path: string) => persisted.has(path),
      readLink: async () => "src",
    };
    const destination = {
      import: async ({ request: input }: { request: ScaffoldWorkspaceMigrationImportInput }) => {
        imports += 1;
        return new ScaffoldWorkspaceMigrationImportResult({
          environmentId: "env-destination" as never,
          projectId: "project-destination" as never,
          threadId: "thread-destination" as never,
          globalSessionId: "sf:env-destination:thread-destination",
          ompSessionId: destinationOmpSessionId,
          operationId: input.operationId,
          payloadDigestSha256: input.payloadDigestSha256,
          ompBundleSha256: input.ompBundleSha256,
          t3MetadataSha256: input.t3MetadataSha256,
          workspaceArchiveSha256: input.workspace.archiveSha256,
          transcriptSha256: input.source.transcriptSha256,
          credentialExclusions: [...SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1],
          unsupportedFilesystemCases: [
            ...SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
          ],
          provenance,
        });
      },
    };
    const makeService = () =>
      makeWorkspaceMigrationImportService({
        runtimeDir: "/runtime",
        workspaceRoot: "/workspace",
        paths,
        decodeMetadata: () => source(),
        acquireCommitAuthority: async () => {},
        destination,
      });

    const first = await makeService().importSession(request());
    const recovered = await makeService().importSession(request());

    expect(recovered).toEqual(first);
    expect(imports).toBe(1);
  });

  it("retries recovery when the atomic receipt commit fails", async () => {
    let destinationCalls = 0;
    let destinationReplays = 0;
    let destinationCommitted = false;
    let writes = 0;
    const persisted = new Map<string, Uint8Array>();
    const service = makeWorkspaceMigrationImportService({
      runtimeDir: "/runtime",
      workspaceRoot: "/workspace",
      paths: {
        join: joinPath,
        relative: relativePath,
        realPath: async (path) => path,
        lstat: workspaceLstat,
        readFile: async (path) =>
          persisted.get(path) ??
          Buffer.from(
            path.endsWith("t3-metadata.json")
              ? "metadata"
              : path.endsWith("src/index.ts")
                ? "code"
                : "omp",
          ),
        writeFileAtomically: async (path, bytes) => {
          writes += 1;
          if (writes === 1) throw new Error("simulated crash before rename");
          persisted.set(path, bytes);
        },
        exists: async (path) => persisted.has(path),
        readLink: async () => "src",
      },
      decodeMetadata: () => source(),
      acquireCommitAuthority: async () => {},
      destination: {
        import: async ({ request: input }) => {
          destinationCalls += 1;
          if (!destinationCommitted) {
            destinationReplays += 1;
            destinationCommitted = true;
          }
          return new ScaffoldWorkspaceMigrationImportResult({
            environmentId: "env-destination" as never,
            projectId: "project-destination" as never,
            threadId: "thread-destination" as never,
            globalSessionId: "sf:env-destination:thread-destination",
            ompSessionId: destinationOmpSessionId,
            operationId: input.operationId,
            payloadDigestSha256: input.payloadDigestSha256,
            ompBundleSha256: input.ompBundleSha256,
            t3MetadataSha256: input.t3MetadataSha256,
            workspaceArchiveSha256: input.workspace.archiveSha256,
            transcriptSha256: input.source.transcriptSha256,
            credentialExclusions: [...SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1],
            unsupportedFilesystemCases: [
              ...SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
            ],
            provenance,
          });
        },
      },
    });

    await expect(service.importSession(request())).rejects.toThrow("simulated crash before rename");
    await Promise.resolve();
    const recovered = await service.importSession(request());

    expect(recovered.operationId).toBe(operationId);
    expect(destinationCalls).toBe(2);
    expect(destinationReplays).toBe(1);
    expect(writes).toBe(2);
    expect(persisted.size).toBe(1);
  });
});
