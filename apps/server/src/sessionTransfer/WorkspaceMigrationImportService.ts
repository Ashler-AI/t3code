import * as NodeCrypto from "node:crypto";

import {
  SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
  SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
  ScaffoldWorkspaceMigrationPayload,
  ScaffoldRetentionClonePayload,
  ScaffoldWorkspaceMigrationImportInput,
  ScaffoldWorkspaceMigrationImportResult,
  ScaffoldRetentionCloneImportInput,
  ScaffoldRetentionCloneImportResult,
  ScaffoldRetentionT3Metadata,
  type SessionTransferSource,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";

export class WorkspaceMigrationImportError extends Data.TaggedError(
  "WorkspaceMigrationImportError",
)<{
  readonly code: string;
  readonly detail: string;
}> {}

export interface WorkspaceMigrationPathPort {
  readonly join: (...parts: ReadonlyArray<string>) => string;
  readonly relative: (from: string, to: string) => string;
  readonly realPath: (path: string) => Promise<string>;
  readonly lstat: (path: string) => Promise<
    | {
        readonly kind: "file" | "directory" | "symbolic-link" | "other";
        readonly mode: number | undefined;
      }
    | undefined
  >;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly writeFileAtomically: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly exists: (path: string) => Promise<boolean>;
  readonly readLink: (path: string) => Promise<string>;
}

export interface WorkspaceMigrationDestinationPort {
  /** Creates new T3 identities and performs one OMP import/load projection. */
  readonly import: (input: {
    readonly request: ScaffoldWorkspaceMigrationImportInput;
    readonly source: SessionTransferSource;
    readonly ompBundle: Uint8Array;
    readonly acquireCommitAuthority: () => Promise<void>;
  }) => Promise<ScaffoldWorkspaceMigrationImportResult>;
  readonly importRetentionClone?: (input: {
    readonly request: ScaffoldRetentionCloneImportInput;
    readonly metadata: ScaffoldRetentionT3Metadata;
    readonly ompBundle: Uint8Array;
    readonly acquireCommitAuthority: () => Promise<void>;
  }) => Promise<ScaffoldRetentionCloneImportResult>;
}

const decodeWorkspaceMigrationPayload = Schema.decodeUnknownSync(ScaffoldWorkspaceMigrationPayload);
const encodeWorkspaceMigrationPayload = Schema.encodeSync(ScaffoldWorkspaceMigrationPayload);
const encodeWorkspaceMigrationImportInput = Schema.encodeSync(
  ScaffoldWorkspaceMigrationImportInput,
);
const encodeRetentionCloneImportInput = Schema.encodeSync(ScaffoldRetentionCloneImportInput);
const decodeRetentionClonePayload = Schema.decodeUnknownSync(ScaffoldRetentionClonePayload);
const encodeRetentionClonePayload = Schema.encodeSync(ScaffoldRetentionClonePayload);
const decodeRetentionT3Metadata = Schema.decodeUnknownSync(ScaffoldRetentionT3Metadata);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function workspaceMigrationPayloadDigest(
  payload:
    | ScaffoldWorkspaceMigrationImportInput["payload"]
    | typeof ScaffoldWorkspaceMigrationPayload.Encoded,
): string {
  const encoded = encodeWorkspaceMigrationPayload(decodeWorkspaceMigrationPayload(payload));
  const { digestSha256: _digestSha256, ...withoutDigest } = encoded;
  return NodeCrypto.createHash("sha256").update(canonicalJson(withoutDigest)).digest("hex");
}

export function retentionClonePayloadDigest(
  payload:
    | ScaffoldRetentionCloneImportInput["payload"]
    | typeof ScaffoldRetentionClonePayload.Encoded,
): string {
  const encoded = encodeRetentionClonePayload(decodeRetentionClonePayload(payload));
  const { digestSha256: _digestSha256, ...withoutDigest } = encoded;
  return NodeCrypto.createHash("sha256").update(canonicalJson(withoutDigest)).digest("hex");
}

/**
 * Ungranted retention restores do not carry the control-plane fingerprint.
 * Derive one from the immutable supervisor envelope while excluding transient
 * commit authority so retries remain stable across authority re-issuance.
 */
export function retentionCloneRequestFingerprint(input: ScaffoldRetentionCloneImportInput): string {
  if (input.requestFingerprintSha256 !== undefined) return input.requestFingerprintSha256;
  const encoded = encodeRetentionCloneImportInput(input);
  const {
    requestFingerprintSha256: _requestFingerprintSha256,
    authority: _authority,
    ...immutableEnvelope
  } = encoded;
  return NodeCrypto.createHash("sha256").update(canonicalJson(immutableEnvelope)).digest("hex");
}

export function validateRetentionCloneImportResult(
  input: ScaffoldRetentionCloneImportInput,
  result: ScaffoldRetentionCloneImportResult,
): ScaffoldRetentionCloneImportResult {
  const ids = [
    [result.t3SessionId, input.source.t3SessionId],
    [result.environmentId, input.source.environmentId],
    [result.projectId, input.source.projectId],
    [result.threadId, input.source.threadId],
    [result.globalSessionId, input.source.globalSessionId],
    [result.ompSessionId, input.source.ompSessionId],
  ];
  if (
    result.version !== "scaffold.t3_workspace_migration.import_result.v2" ||
    result.kind !== "retention-clone.v1" ||
    result.exact !== false ||
    result.operationId !== input.operationId ||
    result.payloadDigestSha256 !== input.payloadDigestSha256 ||
    result.ompBundleSha256 !== input.ompBundleSha256 ||
    result.t3MetadataSha256 !== input.t3MetadataSha256 ||
    result.workspaceArchiveSha256 !== input.workspace.archiveSha256 ||
    result.transcriptSha256 !== input.transcriptSha256 ||
    result.globalSessionId !== `sf:${result.environmentId}:${result.threadId}` ||
    ids.some(([fresh, source]) => fresh === source) ||
    result.provenance.archiveId !== input.archiveId ||
    result.provenance.sourceT3SessionId !== input.source.t3SessionId ||
    result.provenance.sourceEnvironmentId !== input.source.environmentId ||
    result.provenance.sourceProjectId !== input.source.projectId ||
    result.provenance.sourceThreadId !== input.source.threadId ||
    result.provenance.sourceGlobalSessionId !== input.source.globalSessionId ||
    result.provenance.sourceOmpSessionId !== input.source.ompSessionId ||
    JSON.stringify(result.credentialExclusions) !==
      JSON.stringify(SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1) ||
    JSON.stringify(result.unsupportedFilesystemCases) !==
      JSON.stringify(SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1)
  ) {
    throw new WorkspaceMigrationImportError({
      code: "retention_clone_identity_mismatch",
      detail: "Destination did not return six fresh identities bound to this archive.",
    });
  }
  return result;
}

function workspaceMigrationOperationFingerprint(
  input: ScaffoldWorkspaceMigrationImportInput,
): string {
  return NodeCrypto.createHash("sha256")
    .update(canonicalJson(encodeWorkspaceMigrationImportInput(input)))
    .digest("hex");
}

function assertConfinedRelative(relative: string, label: string): void {
  if (
    relative === "" ||
    relative === "." ||
    relative.startsWith("..") ||
    relative.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(relative)
  ) {
    throw new WorkspaceMigrationImportError({
      code: "workspace_migration_path_outside_staging",
      detail: `${label} must be inside the operation staging directory.`,
    });
  }
}

export function makeWorkspaceMigrationImportService(options: {
  readonly runtimeDir: string;
  readonly workspaceRoot: string;
  readonly paths: WorkspaceMigrationPathPort;
  readonly destination: WorkspaceMigrationDestinationPort;
  readonly decodeMetadata: (bytes: Uint8Array) => SessionTransferSource;
  readonly acquireCommitAuthority: (
    authority: ScaffoldWorkspaceMigrationImportInput["authority"],
  ) => Promise<void>;
}) {
  const receipts = new Map<
    string,
    {
      readonly operationFingerprintSha256: string;
      readonly promise: Promise<ScaffoldWorkspaceMigrationImportResult>;
    }
  >();
  const decodeReceipt = Schema.decodeUnknownSync(ScaffoldWorkspaceMigrationImportResult);
  const retentionReceipts = new Map<
    string,
    { readonly fingerprint: string; readonly promise: Promise<ScaffoldRetentionCloneImportResult> }
  >();
  const decodeRetentionReceipt = Schema.decodeUnknownSync(ScaffoldRetentionCloneImportResult);

  const validateResult = (
    input: ScaffoldWorkspaceMigrationImportInput,
    result: ScaffoldWorkspaceMigrationImportResult,
  ) => {
    if (
      result.operationId !== input.operationId ||
      result.payloadDigestSha256 !== input.payloadDigestSha256 ||
      result.ompBundleSha256 !== input.ompBundleSha256 ||
      result.t3MetadataSha256 !== input.t3MetadataSha256 ||
      result.workspaceArchiveSha256 !== input.workspace.archiveSha256 ||
      result.transcriptSha256 !== input.source.transcriptSha256 ||
      JSON.stringify(result.credentialExclusions) !==
        JSON.stringify(SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1) ||
      JSON.stringify(result.unsupportedFilesystemCases) !==
        JSON.stringify(SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1) ||
      result.ompSessionId === input.source.ompSessionId ||
      result.environmentId === input.source.environmentId ||
      result.projectId === input.source.projectId ||
      result.threadId === input.source.threadId ||
      result.globalSessionId !== `sf:${result.environmentId}:${result.threadId}` ||
      result.globalSessionId === input.source.globalSessionId ||
      result.provenance.sourceEnvironmentId !== input.source.environmentId ||
      result.provenance.sourceProjectId !== input.source.projectId ||
      result.provenance.sourceThreadId !== input.source.threadId ||
      result.provenance.sourceGlobalSessionId !== input.source.globalSessionId ||
      result.provenance.sourceOmpSessionId !== input.source.ompSessionId
    ) {
      throw new WorkspaceMigrationImportError({
        code: "workspace_migration_identity_mismatch",
        detail: "Destination did not return a valid copy-with-provenance receipt.",
      });
    }
    return result;
  };

  const importSession = (input: ScaffoldWorkspaceMigrationImportInput) => {
    const operationFingerprintSha256 = workspaceMigrationOperationFingerprint(input);
    const existing = receipts.get(input.operationId);
    if (existing) {
      if (existing.operationFingerprintSha256 !== operationFingerprintSha256) {
        return Promise.reject(
          new WorkspaceMigrationImportError({
            code: "workspace_migration_operation_conflict",
            detail: "The operation id is already bound to a different immutable import request.",
          }),
        );
      }
      return existing.promise;
    }

    const running = Promise.resolve().then(async () => {
      const operationDirectory = options.paths.join(
        options.runtimeDir,
        "workspace-migrations",
        NodeCrypto.createHash("sha256").update(input.operationId).digest("hex").slice(0, 32),
      );
      const receiptPath = options.paths.join(operationDirectory, "t3-import-receipt.json");
      if (await options.paths.exists(receiptPath)) {
        try {
          return validateResult(
            input,
            decodeReceipt(
              JSON.parse(new TextDecoder().decode(await options.paths.readFile(receiptPath))),
            ),
          );
        } catch {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_receipt_invalid",
            detail: "The durable destination receipt is invalid for this operation.",
          });
        }
      }
      const [canonicalDirectory, canonicalOmpPath, canonicalMetadataPath] = await Promise.all([
        options.paths.realPath(operationDirectory),
        options.paths.realPath(input.ompBundlePath),
        options.paths.realPath(input.t3MetadataPath),
      ]);
      assertConfinedRelative(
        options.paths.relative(canonicalDirectory, canonicalOmpPath),
        "OMP bundle path",
      );
      assertConfinedRelative(
        options.paths.relative(canonicalDirectory, canonicalMetadataPath),
        "T3 metadata path",
      );

      const [ompBundle, metadataBytes] = await Promise.all([
        options.paths.readFile(canonicalOmpPath),
        options.paths.readFile(canonicalMetadataPath),
      ]);
      const digest = (bytes: Uint8Array) =>
        NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      if (
        ompBundle.byteLength !== input.ompBundleBytes ||
        digest(ompBundle) !== input.ompBundleSha256 ||
        metadataBytes.byteLength !== input.t3MetadataBytes ||
        digest(metadataBytes) !== input.t3MetadataSha256
      ) {
        throw new WorkspaceMigrationImportError({
          code: "workspace_migration_staged_digest_mismatch",
          detail: "Staged OMP or T3 metadata bytes do not match the signed request.",
        });
      }

      const canonicalWorkspaceRoot = await options.paths.realPath(options.workspaceRoot);
      const requestedWorkspaceRoot = await options.paths.realPath(input.workspace.rootDir);
      if (canonicalWorkspaceRoot !== requestedWorkspaceRoot) {
        throw new WorkspaceMigrationImportError({
          code: "workspace_migration_root_mismatch",
          detail: "Workspace migration targets a different sandbox root.",
        });
      }
      for (const file of input.workspace.files) {
        const path = options.paths.join(canonicalWorkspaceRoot, file.path);
        const entry = await options.paths.lstat(path);
        if (entry?.kind !== "file") {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_workspace_file_type_mismatch",
            detail: `Workspace file ${file.path} is not a regular file.`,
          });
        }
        const canonicalPath = await options.paths.realPath(path);
        assertConfinedRelative(
          options.paths.relative(canonicalWorkspaceRoot, canonicalPath),
          `Workspace file ${file.path}`,
        );
        const bytes = await options.paths.readFile(canonicalPath);
        if (bytes.byteLength !== file.bytes || digest(bytes) !== file.sha256) {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_workspace_digest_mismatch",
            detail: `Workspace file ${file.path} does not match its descriptor.`,
          });
        }
        const expectedExecutable = file.mode === 0o755;
        if (
          file.executable !== expectedExecutable ||
          entry.mode === undefined ||
          (entry.mode & 0o7777) !== file.mode
        ) {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_workspace_mode_mismatch",
            detail: `Workspace file ${file.path} does not match its declared mode and executable state.`,
          });
        }
      }
      for (const tombstone of input.workspace.tombstones) {
        if (
          (await options.paths.lstat(
            options.paths.join(canonicalWorkspaceRoot, tombstone.path),
          )) !== undefined
        ) {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_tombstone_mismatch",
            detail: `Workspace tombstone ${tombstone.path} still exists.`,
          });
        }
      }
      for (const symlink of input.workspace.symlinks) {
        const symlinkPath = options.paths.join(canonicalWorkspaceRoot, symlink.path);
        const entry = await options.paths.lstat(symlinkPath);
        if (entry?.kind !== "symbolic-link") {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_symlink_type_mismatch",
            detail: `Workspace symlink ${symlink.path} is not a symbolic link.`,
          });
        }
        const target = await options.paths.readLink(symlinkPath);
        if (target !== symlink.target) {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_symlink_mismatch",
            detail: `Workspace symlink ${symlink.path} does not match its descriptor.`,
          });
        }
      }

      const expectedPayloadDigest = workspaceMigrationPayloadDigest(input.payload);
      const payloadMismatches = [
        ["request digest", input.payloadDigestSha256, expectedPayloadDigest],
        ["payload digest", input.payload.digestSha256, expectedPayloadDigest],
        ["operation", input.payload.operationId, input.operationId],
        ["source environment", input.payload.source.environmentId, input.source.environmentId],
        ["source project", input.payload.source.projectId, input.source.projectId],
        ["source thread", input.payload.source.threadId, input.source.threadId],
        [
          "source global session",
          input.payload.source.globalSessionId,
          input.source.globalSessionId,
        ],
        ["source OMP session", input.payload.source.ompSessionId, input.source.ompSessionId],
        ["source model", input.payload.source.model, input.source.model],
        ["source effort", input.payload.source.effort, input.source.effort],
        ["source capture timestamp", input.payload.source.capturedAt, input.source.capturedAt],
        ["source transcript", input.payload.source.transcriptSha256, input.source.transcriptSha256],
        ["OMP bundle digest", input.payload.ompBundle.sha256, input.ompBundleSha256],
        ["OMP bundle bytes", input.payload.ompBundle.bytes, input.ompBundleBytes],
        ["OMP export session", input.payload.ompExport.sessionId, input.source.ompSessionId],
        ["OMP export checksum", input.payload.ompExport.sourceChecksum, input.ompBundleSha256],
        ["T3 metadata digest", input.payload.t3Metadata.sha256, input.t3MetadataSha256],
        ["T3 metadata bytes", input.payload.t3Metadata.bytes, input.t3MetadataBytes],
        [
          "credential exclusions",
          JSON.stringify(input.payload.credentialExclusions),
          JSON.stringify(SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1),
        ],
        [
          "unsupported filesystem cases",
          JSON.stringify(input.payload.unsupportedFilesystemCases),
          JSON.stringify(SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1),
        ],
      ].filter(([, actual, expected]) => actual !== expected);
      if (payloadMismatches.length > 0) {
        throw new WorkspaceMigrationImportError({
          code: "workspace_migration_payload_digest_mismatch",
          detail: `Migration payload receipt does not bind its immutable component digests (${payloadMismatches
            .map(([label]) => label)
            .join(", ")}).`,
        });
      }
      const source = options.decodeMetadata(metadataBytes);
      if (
        source.environmentId !== input.source.environmentId ||
        source.projectId !== input.source.projectId ||
        source.threadId !== input.source.threadId ||
        source.continuation.sessionId !== input.source.ompSessionId ||
        source.modelSelection.model !== input.source.model ||
        source.capturedAt !== input.source.capturedAt ||
        source.transcriptSha256 !== input.source.transcriptSha256 ||
        (input.source.title !== undefined && source.title !== input.source.title)
      ) {
        throw new WorkspaceMigrationImportError({
          code: "workspace_migration_metadata_mismatch",
          detail: "Staged T3 metadata does not match the supervisor request.",
        });
      }
      if (
        input.authority.operationId !== input.operationId ||
        input.authority.requestFingerprintSha256 !== input.requestFingerprintSha256 ||
        input.authority.payloadDigestSha256 !== input.payloadDigestSha256 ||
        input.authority.archiveSha256 !== input.workspace.archiveSha256 ||
        input.authority.transcriptSha256 !== input.source.transcriptSha256 ||
        input.authority.ompBundleSha256 !== input.ompBundleSha256 ||
        input.authority.t3MetadataSha256 !== input.t3MetadataSha256 ||
        !Number.isFinite(Date.parse(input.authority.processingDeadlineAt))
      ) {
        throw new WorkspaceMigrationImportError({
          code: "workspace_migration_import_authority_mismatch",
          detail: "Migration import authority does not match the immutable operation.",
        });
      }

      const result = validateResult(
        input,
        await options.destination.import({
          request: {
            ...input,
            ompBundlePath: canonicalOmpPath,
            t3MetadataPath: canonicalMetadataPath,
          },
          source,
          ompBundle,
          acquireCommitAuthority: () => options.acquireCommitAuthority(input.authority),
        }),
      );
      await options.paths.writeFileAtomically(
        receiptPath,
        new TextEncoder().encode(JSON.stringify(result)),
      );
      return result;
    });
    receipts.set(input.operationId, {
      operationFingerprintSha256,
      promise: running,
    });
    void running.catch(() => {
      if (receipts.get(input.operationId)?.promise === running) receipts.delete(input.operationId);
    });
    return running;
  };

  const importRetentionClone = (input: ScaffoldRetentionCloneImportInput) => {
    const requestFingerprintSha256 = retentionCloneRequestFingerprint(input);
    const fingerprint = NodeCrypto.createHash("sha256")
      .update(
        canonicalJson({
          request: encodeRetentionCloneImportInput(input),
          requestFingerprintSha256,
        }),
      )
      .digest("hex");
    const existing = retentionReceipts.get(input.operationId);
    if (existing) {
      return existing.fingerprint === fingerprint
        ? existing.promise
        : Promise.reject(
            new WorkspaceMigrationImportError({
              code: "retention_clone_operation_conflict",
              detail: "The restore operation is already bound to another immutable request.",
            }),
          );
    }
    const running = Promise.resolve().then(async () => {
      const destination = options.destination.importRetentionClone;
      if (!destination) {
        throw new WorkspaceMigrationImportError({
          code: "retention_clone_unavailable",
          detail: "This T3 runtime does not have retention clone restore configured.",
        });
      }
      const operationDirectory = options.paths.join(
        options.runtimeDir,
        "workspace-migrations",
        NodeCrypto.createHash("sha256").update(input.operationId).digest("hex").slice(0, 32),
      );
      const receiptPath = options.paths.join(operationDirectory, "t3-retention-clone-receipt.json");
      const validateResult = (result: ScaffoldRetentionCloneImportResult) =>
        validateRetentionCloneImportResult(input, result);
      if (await options.paths.exists(receiptPath)) {
        return validateResult(
          decodeRetentionReceipt(
            JSON.parse(new TextDecoder().decode(await options.paths.readFile(receiptPath))),
          ),
        );
      }
      const [canonicalDirectory, canonicalOmpPath, canonicalMetadataPath] = await Promise.all([
        options.paths.realPath(operationDirectory),
        options.paths.realPath(input.ompBundlePath),
        options.paths.realPath(input.t3MetadataPath),
      ]);
      assertConfinedRelative(
        options.paths.relative(canonicalDirectory, canonicalOmpPath),
        "OMP bundle path",
      );
      assertConfinedRelative(
        options.paths.relative(canonicalDirectory, canonicalMetadataPath),
        "T3 metadata path",
      );
      const [ompBundle, metadataBytes] = await Promise.all([
        options.paths.readFile(canonicalOmpPath),
        options.paths.readFile(canonicalMetadataPath),
      ]);
      const bytesDigest = (bytes: Uint8Array) =>
        NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      if (
        ompBundle.byteLength !== input.ompBundleBytes ||
        bytesDigest(ompBundle) !== input.ompBundleSha256 ||
        metadataBytes.byteLength !== input.t3MetadataBytes ||
        bytesDigest(metadataBytes) !== input.t3MetadataSha256 ||
        input.transcriptSha256 !== input.source.transcriptSha256
      ) {
        throw new WorkspaceMigrationImportError({
          code: "retention_clone_staged_digest_mismatch",
          detail: "Retention artifacts do not match the immutable restore request.",
        });
      }
      const expectedPayloadDigest = retentionClonePayloadDigest(input.payload);
      if (
        expectedPayloadDigest !== input.payloadDigestSha256 ||
        input.payload.digestSha256 !== expectedPayloadDigest ||
        input.payload.kind !== "retention-clone" ||
        input.payload.exact !== false ||
        input.payload.archiveId !== input.archiveId ||
        input.payload.operationId !== input.operationId ||
        input.payload.source.t3SessionId !== input.source.t3SessionId ||
        input.payload.source.environmentId !== input.source.environmentId ||
        input.payload.source.projectId !== input.source.projectId ||
        input.payload.source.threadId !== input.source.threadId ||
        input.payload.source.globalSessionId !== input.source.globalSessionId ||
        input.payload.source.ompSessionId !== input.source.ompSessionId ||
        input.payload.source.title !== input.source.title ||
        input.payload.source.model !== input.source.model ||
        input.payload.source.effort !== input.source.effort ||
        input.payload.source.capturedAt !== input.source.capturedAt ||
        input.payload.source.transcriptSha256 !== input.transcriptSha256 ||
        input.payload.ompBundle.sha256 !== input.ompBundleSha256 ||
        input.payload.ompBundle.bytes !== input.ompBundleBytes ||
        input.payload.ompExport.sessionId !== input.source.ompSessionId ||
        input.payload.ompExport.sourceChecksum !== input.ompBundleSha256 ||
        input.payload.t3Metadata.sha256 !== input.t3MetadataSha256 ||
        input.payload.t3Metadata.bytes !== input.t3MetadataBytes ||
        JSON.stringify(input.payload.credentialExclusions) !==
          JSON.stringify(SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1) ||
        JSON.stringify(input.payload.unsupportedFilesystemCases) !==
          JSON.stringify(SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1)
      ) {
        throw new WorkspaceMigrationImportError({
          code: "retention_clone_payload_digest_mismatch",
          detail: "Retention payload does not bind its archive provenance and content digests.",
        });
      }
      const canonicalWorkspaceRoot = await options.paths.realPath(options.workspaceRoot);
      const requestedWorkspaceRoot = await options.paths.realPath(input.workspace.rootDir);
      if (canonicalWorkspaceRoot !== requestedWorkspaceRoot) {
        throw new WorkspaceMigrationImportError({
          code: "retention_clone_root_mismatch",
          detail: "Retention clone targets a different sandbox workspace root.",
        });
      }
      for (const file of input.workspace.files) {
        const filePath = options.paths.join(canonicalWorkspaceRoot, file.path);
        const entry = await options.paths.lstat(filePath);
        if (entry?.kind !== "file") {
          throw new WorkspaceMigrationImportError({
            code: "retention_clone_workspace_file_type_mismatch",
            detail: `Workspace file ${file.path} is not a regular file.`,
          });
        }
        const canonicalPath = await options.paths.realPath(filePath);
        assertConfinedRelative(
          options.paths.relative(canonicalWorkspaceRoot, canonicalPath),
          `Workspace file ${file.path}`,
        );
        const bytes = await options.paths.readFile(canonicalPath);
        if (
          bytes.byteLength !== file.bytes ||
          bytesDigest(bytes) !== file.sha256 ||
          entry.mode === undefined ||
          (entry.mode & 0o7777) !== file.mode ||
          file.executable !== (file.mode === 0o755)
        ) {
          throw new WorkspaceMigrationImportError({
            code: "retention_clone_workspace_digest_mismatch",
            detail: `Workspace file ${file.path} does not match its descriptor.`,
          });
        }
      }
      for (const tombstone of input.workspace.tombstones) {
        if (
          (await options.paths.lstat(
            options.paths.join(canonicalWorkspaceRoot, tombstone.path),
          )) !== undefined
        ) {
          throw new WorkspaceMigrationImportError({
            code: "retention_clone_workspace_tombstone_mismatch",
            detail: `Workspace tombstone ${tombstone.path} still exists.`,
          });
        }
      }
      for (const symlink of input.workspace.symlinks) {
        const symlinkPath = options.paths.join(canonicalWorkspaceRoot, symlink.path);
        const entry = await options.paths.lstat(symlinkPath);
        if (
          entry?.kind !== "symbolic-link" ||
          (await options.paths.readLink(symlinkPath)) !== symlink.target
        ) {
          throw new WorkspaceMigrationImportError({
            code: "retention_clone_workspace_symlink_mismatch",
            detail: `Workspace symlink ${symlink.path} does not match its descriptor.`,
          });
        }
      }
      const metadata = decodeRetentionT3Metadata(
        JSON.parse(new TextDecoder().decode(metadataBytes)),
      );
      if (
        metadata.archiveId !== input.archiveId ||
        metadata.operationId !== input.operationId ||
        metadata.source.sessionId !== input.source.t3SessionId ||
        metadata.source.environmentId !== input.source.environmentId ||
        metadata.source.projectId !== input.source.projectId ||
        metadata.source.threadId !== input.source.threadId ||
        metadata.source.globalSessionId !== input.source.globalSessionId ||
        metadata.source.ompSessionId !== input.source.ompSessionId ||
        metadata.source.title !== (input.source.title ?? metadata.source.title) ||
        metadata.source.model !== input.source.model ||
        metadata.source.effort !== input.source.effort ||
        metadata.source.capturedAt !== input.source.capturedAt ||
        metadata.source.transcriptSha256 !== input.transcriptSha256 ||
        metadata.ompExport.sessionId !== input.source.ompSessionId ||
        metadata.ompExport.sourceChecksum !== input.ompBundleSha256
      ) {
        throw new WorkspaceMigrationImportError({
          code: "retention_clone_metadata_mismatch",
          detail: "Retention metadata provenance does not match the restore request.",
        });
      }
      if (input.authority) {
        if (
          input.authority.operationId !== input.operationId ||
          input.authority.payloadDigestSha256 !== input.payloadDigestSha256 ||
          input.authority.archiveSha256 !== input.workspace.archiveSha256 ||
          input.authority.transcriptSha256 !== input.transcriptSha256 ||
          input.authority.ompBundleSha256 !== input.ompBundleSha256 ||
          input.authority.t3MetadataSha256 !== input.t3MetadataSha256 ||
          input.authority.requestFingerprintSha256 !== requestFingerprintSha256
        ) {
          throw new WorkspaceMigrationImportError({
            code: "retention_clone_import_authority_mismatch",
            detail: "Retention clone authority does not match the immutable restore operation.",
          });
        }
        await options.acquireCommitAuthority(input.authority);
      }
      const result = validateResult(
        await destination({
          request: {
            ...input,
            ompBundlePath: canonicalOmpPath,
            t3MetadataPath: canonicalMetadataPath,
          },
          metadata,
          ompBundle,
          acquireCommitAuthority: async () => undefined,
        }),
      );
      await options.paths.writeFileAtomically(
        receiptPath,
        new TextEncoder().encode(JSON.stringify(result)),
      );
      return result;
    });
    retentionReceipts.set(input.operationId, { fingerprint, promise: running });
    void running.catch(() => {
      if (retentionReceipts.get(input.operationId)?.promise === running) {
        retentionReceipts.delete(input.operationId);
      }
    });
    return running;
  };

  return { importSession, importRetentionClone };
}
