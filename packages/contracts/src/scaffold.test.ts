import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import {
  SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
  SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
  ScaffoldSessionTransferDescriptor,
  ScaffoldRetentionCloneImportInput,
  ScaffoldWorkspaceMigrationImportInput,
  scaffoldSessionTransferOperationIdentity,
  scaffoldSessionTransferOperationIdFromSha256,
} from "./scaffold.ts";

const decodeWorkspaceMigrationImport = Schema.decodeUnknownSync(
  ScaffoldWorkspaceMigrationImportInput,
);
const decodeSessionTransferDescriptor = Schema.decodeUnknownSync(ScaffoldSessionTransferDescriptor);
const decodeRetentionCloneImport = Schema.decodeUnknownSync(ScaffoldRetentionCloneImportInput);

function workspaceMigrationImport(baseSha: string) {
  const digest = "a".repeat(64);
  return {
    version: "scaffold.t3_workspace_migration.import.v1",
    operationId: "migration:test",
    requestFingerprintSha256: digest,
    payloadDigestSha256: digest,
    payload: {
      version: "scaffold.workspace_migration.payload.v1",
      operationId: "migration:test",
      source: {
        environmentId: "source-environment",
        projectId: "source-project",
        threadId: "source-thread",
        globalSessionId: "sf:source-environment:source-thread",
        ompSessionId: "source-omp-session",
        model: "openai/gpt-5.6-sol",
        capturedAt: "2026-07-26T00:00:00.000Z",
        transcriptSha256: digest,
      },
      ompBundle: {
        path: ".__scaffold_workspace_migration__/omp-session.zip",
        bytes: 1,
        sha256: digest,
      },
      ompExport: {
        version: 1,
        sessionId: "source-omp-session",
        sourceChecksum: digest,
        files: [],
      },
      t3Metadata: {
        path: ".__scaffold_workspace_migration__/t3-metadata.json",
        bytes: 1,
        sha256: digest,
      },
      credentialExclusions: SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
      unsupportedFilesystemCases: SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
      digestSha256: digest,
    },
    authority: {
      version: "scaffold.workspace_migration.import_authority.v1",
      authorityId: "authority-test",
      grantId: "grant-test",
      secret: "secret-test",
      sandboxId: "sandbox-test",
      sessionId: "session-test",
      lifecycleEpoch: 1,
      operationId: "migration:test",
      payloadDigestSha256: digest,
      archiveSha256: digest,
      transcriptSha256: digest,
      ompBundleSha256: digest,
      t3MetadataSha256: digest,
      requestFingerprintSha256: digest,
      processingDeadlineAt: "2026-07-26T00:01:00.000Z",
    },
    source: {
      environmentId: "source-environment",
      projectId: "source-project",
      threadId: "source-thread",
      globalSessionId: "sf:source-environment:source-thread",
      ompSessionId: "source-omp-session",
      model: "openai/gpt-5.6-sol",
      capturedAt: "2026-07-26T00:00:00.000Z",
      transcriptSha256: digest,
    },
    ompBundlePath: "/tmp/omp-session.zip",
    ompBundleSha256: digest,
    ompBundleBytes: 1,
    t3MetadataPath: "/tmp/t3-metadata.json",
    t3MetadataSha256: digest,
    t3MetadataBytes: 1,
    workspace: {
      rootDir: "/workspace",
      baseSha,
      archiveSha256: digest,
      files: [],
      tombstones: [],
      symlinks: [],
    },
  };
}

function retentionCloneImport() {
  const exact = workspaceMigrationImport("b".repeat(40));
  const { requestFingerprintSha256: _requestFingerprintSha256, ...withoutFingerprint } = exact;
  const source = {
    ...exact.source,
    t3SessionId: "source-t3-session",
  };
  return {
    ...withoutFingerprint,
    version: "scaffold.t3_workspace_migration.import.v3",
    kind: "retention-clone.v1",
    exact: false,
    archiveId: "sra_archive_test",
    transcriptSha256: exact.source.transcriptSha256,
    payload: {
      ...exact.payload,
      version: "scaffold.workspace_migration.payload.v3",
      kind: "retention-clone",
      exact: false,
      archiveId: "sra_archive_test",
      source,
    },
    source,
  };
}

describe("Scaffold retention clone contract", () => {
  it("accepts audit provenance without destination or cursor authority", () => {
    expect(decodeRetentionCloneImport(retentionCloneImport())).toMatchObject({
      kind: "retention-clone.v1",
      exact: false,
      source: { t3SessionId: "source-t3-session" },
    });
  });

  it("decodes the supervisor envelope without a migration grant fingerprint", () => {
    const decoded = decodeRetentionCloneImport(retentionCloneImport());
    expect(decoded.requestFingerprintSha256).toBeUndefined();
    expect(decoded.payload).toMatchObject({
      version: "scaffold.workspace_migration.payload.v3",
      kind: "retention-clone",
      exact: false,
      archiveId: "sra_archive_test",
      source: { t3SessionId: "source-t3-session" },
    });
  });

  it("rejects the ordinary v1 payload and excess source authority on clone imports", () => {
    const input = retentionCloneImport();
    expect(() =>
      decodeRetentionCloneImport({
        ...input,
        payload: { ...input.payload, version: "scaffold.workspace_migration.payload.v1" },
      }),
    ).toThrow();
    expect(() =>
      decodeRetentionCloneImport({
        ...input,
        source: { ...input.source, sessionId: "source-session-authority" },
      }),
    ).toThrow();
  });

  it.each([
    { source: { eventSequence: 9 } },
    { source: { acpSequence: 3 } },
    { source: { resumeCursor: { eventSequence: 9 } } },
    { destinationThreadId: "source-thread" },
    { destinationOmpSessionId: "source-omp-session" },
    { unexpectedAuthority: "browser-owned" },
  ])("rejects imported ordering or destination identity authority", (injected) => {
    const input = retentionCloneImport();
    const source = "source" in injected ? { ...input.source, ...injected.source } : input.source;
    expect(() => decodeRetentionCloneImport({ ...input, ...injected, source })).toThrow();
  });
});

describe("Scaffold workspace migration credential exclusions", () => {
  it("declares complete portable roots and common machine credential paths", () => {
    expect(SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1).toContain(
      "v1:portable-root:auth",
    );
    expect(SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1).toContain(
      "v1:path-basename:.npmrc",
    );
    expect(SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1).toContain(
      "v1:workspace-tree:.ssh",
    );
    expect(new Set(SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1).size).toBe(
      SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1.length,
    );
  });
});

describe("Scaffold workspace migration Git base commit", () => {
  it("decodes lowercase SHA-1 and SHA-256 Git commit ids", () => {
    expect(
      decodeWorkspaceMigrationImport(workspaceMigrationImport("b".repeat(40))).workspace.baseSha,
    ).toBe("b".repeat(40));
    expect(
      decodeWorkspaceMigrationImport(workspaceMigrationImport("c".repeat(64))).workspace.baseSha,
    ).toBe("c".repeat(64));
  });

  it.each(["d".repeat(39), "d".repeat(41), "D".repeat(40), `g${"d".repeat(39)}`])(
    "rejects malformed Git commit id %s",
    (baseSha) => {
      expect(() => decodeWorkspaceMigrationImport(workspaceMigrationImport(baseSha))).toThrow();
    },
  );
});

describe("Scaffold session transfer operation identity", () => {
  it("is stable across caller recreation and preserves identity boundaries", () => {
    const input = {
      sourceEnvironmentId: EnvironmentId.make("local environment:one"),
      sourceThreadId: ThreadId.make("thread/one"),
      deployment: "staging" as const,
    };

    expect(scaffoldSessionTransferOperationIdentity(input)).toBe(
      '["scaffold.session-transfer.operation.v1","local environment:one","thread/one","staging"]',
    );
    expect(scaffoldSessionTransferOperationIdentity({ ...input })).toBe(
      scaffoldSessionTransferOperationIdentity(input),
    );
  });

  it("keeps Unicode, delimiters, and long identities unambiguous", () => {
    const identity = scaffoldSessionTransferOperationIdentity({
      sourceEnvironmentId: EnvironmentId.make(`environment:${"雪".repeat(300)}`),
      sourceThreadId: ThreadId.make(`thread/%:${"🧵".repeat(300)}`),
      deployment: "production",
    });

    expect(JSON.parse(identity)).toEqual([
      "scaffold.session-transfer.operation.v1",
      `environment:${"雪".repeat(300)}`,
      `thread/%:${"🧵".repeat(300)}`,
      "production",
    ]);
  });

  it("separates source environments, source threads, and deployments", () => {
    const base = {
      sourceEnvironmentId: EnvironmentId.make("environment-one"),
      sourceThreadId: ThreadId.make("thread-one"),
      deployment: "staging" as const,
    };
    const ids = new Set([
      scaffoldSessionTransferOperationIdentity(base),
      scaffoldSessionTransferOperationIdentity({
        ...base,
        sourceEnvironmentId: EnvironmentId.make("environment-two"),
      }),
      scaffoldSessionTransferOperationIdentity({
        ...base,
        sourceThreadId: ThreadId.make("thread-two"),
      }),
      scaffoldSessionTransferOperationIdentity({ ...base, deployment: "production" }),
    ]);

    expect(ids.size).toBe(4);
  });

  it("formats only an exact SHA-256 digest into the bounded downstream id", () => {
    const operationId = scaffoldSessionTransferOperationIdFromSha256("a".repeat(64));
    expect(operationId).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(operationId.length).toBeLessThanOrEqual(160);
    expect(() => scaffoldSessionTransferOperationIdFromSha256("not-a-digest")).toThrow("SHA-256");
  });
});

describe("Scaffold session transfer descriptors", () => {
  it("keeps exact OMP continuation behind an opt-in envelope", () => {
    const exactSource = {
      environmentId: "source-environment",
      projectId: "source-project",
      threadId: "source-thread",
      rootPath: "/workspace",
      title: "Exact OMP session",
      modelSelection: { instanceId: "omp", model: "openai/gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      continuation: {
        provider: "omp",
        sessionId: "omp-private-session",
        eventSequence: 4,
        acpSequence: 7,
      },
      capturedAt: "2026-07-27T00:00:00.000Z",
      transcriptSha256: "a".repeat(64),
    };

    expect(decodeSessionTransferDescriptor({ kind: "exact-omp", source: exactSource })).toEqual({
      kind: "exact-omp",
      source: exactSource,
    });
  });

  it("represents contextual continuation without native private session identity", () => {
    const descriptor = decodeSessionTransferDescriptor({
      kind: "contextual-native",
      continuation: {
        exact: false,
        destinationProvider: "omp",
        nativeSessionStateTransferred: false,
      },
      source: {
        environmentId: "source-environment",
        projectId: "source-project",
        threadId: "source-thread",
        globalSessionId: "sf:source-environment:source-thread",
        rootPath: "/workspace",
        title: "Native source",
        provider: "codex",
        modelSelection: { instanceId: "codex-work", model: "gpt-5.6-sol" },
        runtimeMode: "full-access",
        interactionMode: "default",
        capturedAt: "2026-07-27T00:00:00.000Z",
        visibleContextSha256: "b".repeat(64),
      },
      contextArtifact: {
        path: ".__scaffold_workspace_migration__/contextual-handoff.md",
        bytes: 12,
        sha256: "b".repeat(64),
        mediaType: "text/markdown; charset=utf-8",
      },
    });

    expect(descriptor.kind).toBe("contextual-native");
    if (descriptor.kind !== "contextual-native") throw new Error("expected contextual descriptor");
    expect(JSON.stringify(descriptor)).not.toMatch(
      /nativeSessionId|providerSessionId|resumeCursor|credential|token/i,
    );
    expect(() =>
      decodeSessionTransferDescriptor({
        ...descriptor,
        continuation: { ...descriptor.continuation, exact: true },
      }),
    ).toThrow();
  });
});
