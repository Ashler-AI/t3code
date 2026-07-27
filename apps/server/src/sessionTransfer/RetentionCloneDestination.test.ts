import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ScaffoldRetentionCloneImportInput,
  ScaffoldRetentionCloneImportResult,
  SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
  SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { buildRetentionCloneDestinationPlan } from "./LiveWorkspaceMigrationDestination.ts";
import {
  retentionCloneRequestFingerprint,
  validateRetentionCloneImportResult,
} from "./WorkspaceMigrationImportService.ts";

const decodeInput = Schema.decodeUnknownSync(ScaffoldRetentionCloneImportInput);

function request(operationId: string) {
  const hash = "a".repeat(64);
  return decodeInput({
    version: "scaffold.t3_workspace_migration.import.v3",
    kind: "retention-clone.v1",
    exact: false,
    archiveId: "sra_archive_source",
    operationId,
    payloadDigestSha256: hash,
    transcriptSha256: hash,
    payload: {
      version: "scaffold.workspace_migration.payload.v3",
      kind: "retention-clone",
      exact: false,
      archiveId: "sra_archive_source",
      operationId,
      source: {
        t3SessionId: "t3-session-source",
        environmentId: "environment-source",
        projectId: "project-source",
        threadId: "thread-source",
        globalSessionId: "sf:environment-source:thread-source",
        ompSessionId: "omp-source",
        model: "openai/gpt-5.6-sol",
        capturedAt: "2026-07-27T00:00:00.000Z",
        transcriptSha256: hash,
      },
      ompBundle: {
        path: ".__scaffold_workspace_migration__/omp-session.zip",
        bytes: 1,
        sha256: hash,
      },
      ompExport: {
        version: 1,
        sessionId: "omp-source",
        sourceChecksum: hash,
        files: [],
      },
      t3Metadata: {
        path: ".__scaffold_workspace_migration__/t3-metadata.json",
        bytes: 1,
        sha256: hash,
      },
      credentialExclusions: SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
      unsupportedFilesystemCases: SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
      digestSha256: hash,
    },
    source: {
      t3SessionId: "t3-session-source",
      environmentId: "environment-source",
      projectId: "project-source",
      threadId: "thread-source",
      globalSessionId: "sf:environment-source:thread-source",
      ompSessionId: "omp-source",
      title: "Retained session",
      model: "openai/gpt-5.6-sol",
      effort: "high",
      capturedAt: "2026-07-27T00:00:00.000Z",
      transcriptSha256: hash,
    },
    ompBundlePath: "/runtime/omp-session.zip",
    ompBundleSha256: hash,
    ompBundleBytes: 1,
    t3MetadataPath: "/runtime/t3-metadata.json",
    t3MetadataSha256: hash,
    t3MetadataBytes: 1,
    workspace: {
      rootDir: "/workspace",
      archiveSha256: hash,
      files: [],
      tombstones: [],
      symlinks: [],
    },
  });
}

describe("retention clone destination", () => {
  it("derives a stable request fingerprint when the supervisor omits one", () => {
    const input = request("restore-one");
    expect(input.requestFingerprintSha256).toBeUndefined();
    expect(retentionCloneRequestFingerprint(input)).toMatch(/^[a-f0-9]{64}$/);
    expect(retentionCloneRequestFingerprint(input)).toBe(retentionCloneRequestFingerprint(input));
    expect(retentionCloneRequestFingerprint(request("restore-two"))).not.toBe(
      retentionCloneRequestFingerprint(input),
    );
  });

  it("mints six fresh identities and initializes one zero continuation boundary", () => {
    const plan = buildRetentionCloneDestinationPlan({
      request: request("restore-one"),
      destinationT3SessionId: "t3-session-destination",
      destinationEnvironmentId: EnvironmentId.make("environment-destination"),
    });
    expect(plan.result.t3SessionId).not.toBe("t3-session-source");
    expect(plan.result.environmentId).not.toBe("environment-source");
    expect(plan.result.projectId).not.toBe("project-source");
    expect(plan.result.threadId).not.toBe("thread-source");
    expect(plan.result.globalSessionId).not.toBe("sf:environment-source:thread-source");
    expect(plan.result.ompSessionId).not.toBe("omp-source");
    expect(plan.resumeCursor).toEqual({
      schemaVersion: 3,
      sessionId: plan.result.ompSessionId,
      eventSequence: 0,
      acpSequence: 0,
    });
    expect(plan.result.provenance).toMatchObject({
      sourceT3SessionId: "t3-session-source",
      sourceOmpSessionId: "omp-source",
    });
  });

  it("converges for one operation and allocates new identities for another", () => {
    const destination = {
      destinationT3SessionId: "t3-session-destination",
      destinationEnvironmentId: EnvironmentId.make("environment-destination"),
    };
    const first = buildRetentionCloneDestinationPlan({
      request: request("restore-one"),
      ...destination,
    });
    const retry = buildRetentionCloneDestinationPlan({
      request: request("restore-one"),
      ...destination,
    });
    const another = buildRetentionCloneDestinationPlan({
      request: request("restore-two"),
      destinationT3SessionId: "t3-session-destination-two",
      destinationEnvironmentId: EnvironmentId.make("environment-destination-two"),
    });
    expect(retry.result).toEqual(first.result);
    expect(another.result.projectId).not.toBe(first.result.projectId);
    expect(another.result.threadId).not.toBe(first.result.threadId);
    expect(another.result.globalSessionId).not.toBe(first.result.globalSessionId);
    expect(another.result.ompSessionId).not.toBe(first.result.ompSessionId);
    expect(another.result.t3SessionId).not.toBe(first.result.t3SessionId);
    expect(another.result.environmentId).not.toBe(first.result.environmentId);
  });

  it("rejects destination receipts that rewrite source provenance", () => {
    const input = request("restore-one");
    const plan = buildRetentionCloneDestinationPlan({
      request: input,
      destinationT3SessionId: "t3-session-destination",
      destinationEnvironmentId: EnvironmentId.make("environment-destination"),
    });
    expect(validateRetentionCloneImportResult(input, plan.result)).toBe(plan.result);
    try {
      validateRetentionCloneImportResult(
        input,
        new ScaffoldRetentionCloneImportResult({
          ...plan.result,
          provenance: {
            ...plan.result.provenance,
            sourceThreadId: "rewritten-source-thread" as never,
          },
        }),
      );
      throw new Error("expected rewritten provenance to be rejected");
    } catch (error) {
      expect(error).toMatchObject({ code: "retention_clone_identity_mismatch" });
    }
  });
});
