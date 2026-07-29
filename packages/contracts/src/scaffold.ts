import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1 = [
  "v1:omp-export:agent.db",
  "v1:omp-export:auth",
  "v1:omp-export:settings",
  "v1:path-basename:.claude.json",
  "v1:path-basename:.dev.vars",
  "v1:path-basename:.envrc",
  "v1:path-basename:.git-credentials",
  "v1:path-basename:.netrc",
  "v1:path-basename:.npmrc",
  "v1:path-basename:.pypirc",
  "v1:path-basename:auth.json",
  "v1:path-basename:credentials.json",
  "v1:path-basename:id_dsa",
  "v1:path-basename:id_ecdsa",
  "v1:path-basename:id_ed25519",
  "v1:path-basename:id_rsa",
  "v1:path-basename:mcp-credentials.json",
  "v1:path-basename:oauth.json",
  "v1:path-basename:state.sqlite",
  "v1:portable-root:auth",
  "v1:portable-root:credentials",
  "v1:portable-root:oauth",
  "v1:portable-root:settings",
  "v1:t3-metadata:auth",
  "v1:t3-metadata:browser-session",
  "v1:t3-metadata:capability",
  "v1:t3-metadata:cookies",
  "v1:t3-metadata:pairing",
  "v1:workspace-env:.env",
  "v1:workspace-env:.env.*:except=.env.example,.env.sample,.env.template",
  "v1:workspace-tree:.anthropic",
  "v1:workspace-tree:.aws",
  "v1:workspace-tree:.claude",
  "v1:workspace-tree:.codex",
  "v1:workspace-tree:.config/gcloud",
  "v1:workspace-tree:.config/gh",
  "v1:workspace-tree:.config/github-copilot",
  "v1:workspace-tree:.config/omp",
  "v1:workspace-tree:.config/opencode",
  "v1:workspace-tree:.docker",
  "v1:workspace-tree:.kube",
  "v1:workspace-tree:.omp",
  "v1:workspace-tree:.openai",
  "v1:workspace-tree:.ssh",
] as const;

export const SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1 = [
  "v1:acls",
  "v1:additional-workspace-roots",
  "v1:device-fifo-socket-entries",
  "v1:empty-directories",
  "v1:hardlink-topology",
  "v1:ignored-files-outside-selected-.omx-context",
  "v1:modes-other-than-exact-0644-0755",
  "v1:ownership",
  "v1:timestamps",
  "v1:unsafe-dangling-cyclic-symlinks",
  "v1:xattrs",
] as const;

const ScaffoldWorkspaceMigrationCredentialExclusions = Schema.Array(
  Schema.Literals(SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1),
).check(
  Schema.isLengthBetween(
    SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1.length,
    SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1.length,
  ),
  Schema.isUnique(),
  Schema.makeFilter(
    (entries) =>
      entries.every(
        (entry, index) => entry === SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1[index],
      ) || "Credential exclusions must use the canonical v1 order.",
  ),
);

const ScaffoldWorkspaceMigrationUnsupportedFilesystemCases = Schema.Array(
  Schema.Literals(SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1),
).check(
  Schema.isLengthBetween(
    SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1.length,
    SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1.length,
  ),
  Schema.isUnique(),
  Schema.makeFilter(
    (entries) =>
      entries.every(
        (entry, index) =>
          entry === SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1[index],
      ) || "Unsupported filesystem cases must use the canonical v1 order.",
  ),
);

export const ScaffoldDeployment = Schema.Literals(["staging", "production"]);
export type ScaffoldDeployment = typeof ScaffoldDeployment.Type;

export const ScaffoldDeploymentCapabilityStatus = Schema.Literals([
  "available",
  "unsupported",
  "unavailable",
]);
export type ScaffoldDeploymentCapabilityStatus = typeof ScaffoldDeploymentCapabilityStatus.Type;

export class ScaffoldDeploymentCapability extends Schema.Class<ScaffoldDeploymentCapability>(
  "ScaffoldDeploymentCapability",
)({
  deployment: ScaffoldDeployment,
  status: ScaffoldDeploymentCapabilityStatus,
  description: TrimmedNonEmptyString,
}) {}

export const ScaffoldDeploymentCapabilities = Schema.Struct({
  deployments: Schema.Array(ScaffoldDeploymentCapability),
});
export type ScaffoldDeploymentCapabilities = typeof ScaffoldDeploymentCapabilities.Type;

export const ScaffoldAgentEffort = Schema.Literals([
  "off",
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ScaffoldAgentEffort = typeof ScaffoldAgentEffort.Type;

/**
 * Stable source-owned idempotency key for copying one local thread into one
 * Scaffold deployment. The browser is not an authority for this identity: it
 * derives the same value after reload, and the source server independently
 * validates it before acquiring a transfer fence.
 */
export const SCAFFOLD_SESSION_TRANSFER_OPERATION_ID_PREFIX =
  "scaffold.session-transfer.operation.v1:";

export function scaffoldSessionTransferOperationIdentity(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly deployment: ScaffoldDeployment;
}): string {
  const version = "scaffold.session-transfer.operation.v1";
  return JSON.stringify([
    version,
    input.sourceEnvironmentId,
    input.sourceThreadId,
    input.deployment,
  ]);
}

export function scaffoldSessionTransferOperationIdFromSha256(sha256Hex: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256Hex)) {
    throw new Error("A Scaffold session transfer operation requires a SHA-256 hex digest.");
  }
  return `${SCAFFOLD_SESSION_TRANSFER_OPERATION_ID_PREFIX}${sha256Hex}`;
}

export const ScaffoldSessionStatus = Schema.Literals([
  "creating",
  "restoring_snapshot",
  "starting",
  "ready",
  "agent_running",
  "paused",
  "resuming",
  "stopped",
  "failed",
]);
export type ScaffoldSessionStatus = typeof ScaffoldSessionStatus.Type;

export const ScaffoldAttachCredential = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9._~-]+$/),
);
export type ScaffoldAttachCredential = typeof ScaffoldAttachCredential.Type;

export class ScaffoldSessionObservation extends Schema.Class<ScaffoldSessionObservation>(
  "ScaffoldSessionObservation",
)({
  sessionId: TrimmedNonEmptyString,
  status: ScaffoldSessionStatus,
  lifecycleEpoch: NonNegativeInt,
  updatedAt: Schema.optionalKey(TrimmedNonEmptyString),
}) {}

export class ScaffoldSessionLinks extends Schema.Class<ScaffoldSessionLinks>(
  "ScaffoldSessionLinks",
)({
  session: TrimmedNonEmptyString,
  web: TrimmedNonEmptyString,
  tilt: TrimmedNonEmptyString,
}) {}

/** Safe to cache. This projection deliberately cannot represent transport authority. */
export class ScaffoldEnvironmentBinding extends Schema.Class<ScaffoldEnvironmentBinding>(
  "ScaffoldEnvironmentBinding",
)({
  deployment: ScaffoldDeployment,
  environmentId: EnvironmentId,
  sessionId: TrimmedNonEmptyString,
  lifecycleEpoch: NonNegativeInt,
  status: ScaffoldSessionStatus,
  links: ScaffoldSessionLinks,
  lastKnownAt: TrimmedNonEmptyString,
}) {}

export class ScaffoldCreateParameters extends Schema.Class<ScaffoldCreateParameters>(
  "ScaffoldCreateParameters",
)({
  sourceRef: Schema.optionalKey(TrimmedNonEmptyString),
  snapshotId: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  modelRouteId: Schema.optionalKey(TrimmedNonEmptyString),
  agentEffort: Schema.optionalKey(ScaffoldAgentEffort),
}) {}

export class ScaffoldCreateAndPrepareInput extends Schema.TaggedClass<ScaffoldCreateAndPrepareInput>()(
  "ScaffoldCreateAndPrepareInput",
  {
    deployment: ScaffoldDeployment,
    operationId: TrimmedNonEmptyString,
    sessionId: Schema.optionalKey(TrimmedNonEmptyString),
    create: ScaffoldCreateParameters,
  },
) {}

export class ScaffoldResumeAndPrepareInput extends Schema.TaggedClass<ScaffoldResumeAndPrepareInput>()(
  "ScaffoldResumeAndPrepareInput",
  {
    deployment: ScaffoldDeployment,
    operationId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    sessionId: TrimmedNonEmptyString,
    expectedLifecycleEpoch: NonNegativeInt,
  },
) {}

export const ScaffoldPrepareConnectionInput = Schema.Union([
  ScaffoldCreateAndPrepareInput,
  ScaffoldResumeAndPrepareInput,
]);
export type ScaffoldPrepareConnectionInput = typeof ScaffoldPrepareConnectionInput.Type;

/** Read-only lookup used to reconcile a saved UI projection with Scaffold. */
export class ScaffoldObserveInput extends Schema.Class<ScaffoldObserveInput>(
  "ScaffoldObserveInput",
)({
  deployment: ScaffoldDeployment,
  sessionId: TrimmedNonEmptyString,
}) {}

export class ScaffoldPauseInput extends Schema.Class<ScaffoldPauseInput>("ScaffoldPauseInput")({
  deployment: ScaffoldDeployment,
  operationId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  sessionId: TrimmedNonEmptyString,
  expectedLifecycleEpoch: NonNegativeInt,
}) {}

/**
 * Ephemeral RPC result. `bootstrapCredential` must be exchanged directly with
 * the sandbox and must never be written to a client cache or connection profile.
 */
export class ScaffoldPreparedConnection extends Schema.Class<ScaffoldPreparedConnection>(
  "ScaffoldPreparedConnection",
)({
  binding: ScaffoldEnvironmentBinding,
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  bootstrapCredential: TrimmedNonEmptyString,
  attachCredential: ScaffoldAttachCredential,
  expiresAt: TrimmedNonEmptyString,
}) {}

export const ScaffoldLifecycleErrorReason = Schema.Literals([
  "configuration",
  "authentication",
  "network",
  "conflict",
  "not_found",
  "terminal",
  "invalid_response",
  "unavailable",
]);
export type ScaffoldLifecycleErrorReason = typeof ScaffoldLifecycleErrorReason.Type;

export class ScaffoldLifecycleError extends Schema.TaggedErrorClass<ScaffoldLifecycleError>()(
  "ScaffoldLifecycleError",
  {
    reason: ScaffoldLifecycleErrorReason,
    message: Schema.String,
    status: NonNegativeInt,
    code: TrimmedNonEmptyString,
    retryAfterMs: Schema.optionalKey(NonNegativeInt),
    observation: Schema.optionalKey(ScaffoldSessionObservation),
  },
) {}

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const GitCommitId = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));
export class SessionTransferContinuation extends Schema.Class<SessionTransferContinuation>(
  "SessionTransferContinuation",
)({
  provider: Schema.Literal("omp"),
  sessionId: TrimmedNonEmptyString,
  eventSequence: NonNegativeInt,
  acpSequence: NonNegativeInt,
}) {}

/**
 * Immutable source identity and user intent copied into a new destination
 * thread. Destination orchestration ids and event sequences are deliberately
 * absent: a handoff never transplants T3 projection authority.
 */
export class SessionTransferSource extends Schema.Class<SessionTransferSource>(
  "SessionTransferSource",
)({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  rootPath: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  continuation: SessionTransferContinuation,
  capturedAt: TrimmedNonEmptyString,
  transcriptSha256: Sha256Hex,
}) {}

export const SessionTransferKind = Schema.Literals(["exact-omp", "contextual-native"]);
export type SessionTransferKind = typeof SessionTransferKind.Type;

/** Credential-free provenance for a contextual native-provider handoff. */
export class ContextualNativeSessionTransferSource extends Schema.Class<ContextualNativeSessionTransferSource>(
  "ContextualNativeSessionTransferSource",
)({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  globalSessionId: TrimmedNonEmptyString,
  rootPath: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  provider: ProviderDriverKind,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  capturedAt: TrimmedNonEmptyString,
  visibleContextSha256: Sha256Hex,
}) {}

export class ContextualNativeSessionTransferArtifact extends Schema.Class<ContextualNativeSessionTransferArtifact>(
  "ContextualNativeSessionTransferArtifact",
)({
  path: Schema.Literal(".__scaffold_workspace_migration__/contextual-handoff.md"),
  bytes: PositiveInt,
  sha256: Sha256Hex,
  mediaType: Schema.Literal("text/markdown; charset=utf-8"),
}) {}

/**
 * Opt-in discriminated envelope. Legacy exact OMP schemas remain unchanged;
 * native handoffs cannot represent a provider session id or resume cursor.
 */
export const ScaffoldSessionTransferDescriptor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("exact-omp"), source: SessionTransferSource }),
  Schema.Struct({
    kind: Schema.Literal("contextual-native"),
    continuation: Schema.Struct({
      exact: Schema.Literal(false),
      destinationProvider: Schema.Literal("omp"),
      nativeSessionStateTransferred: Schema.Literal(false),
    }),
    source: ContextualNativeSessionTransferSource,
    contextArtifact: ContextualNativeSessionTransferArtifact,
  }),
]);
export type ScaffoldSessionTransferDescriptor = typeof ScaffoldSessionTransferDescriptor.Type;

export class ScaffoldSessionTransferStartInput extends Schema.Class<ScaffoldSessionTransferStartInput>(
  "ScaffoldSessionTransferStartInput",
)({
  operationId: TrimmedNonEmptyString,
  deployment: ScaffoldDeployment,
  sourceThreadId: ThreadId,
  create: ScaffoldCreateParameters,
}) {}

const WorkspaceMigrationRelativePath = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?!\/)(?![A-Za-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/),
);

export class ScaffoldWorkspaceMigrationFile extends Schema.Class<ScaffoldWorkspaceMigrationFile>(
  "ScaffoldWorkspaceMigrationFile",
)({
  path: WorkspaceMigrationRelativePath,
  bytes: NonNegativeInt,
  sha256: Sha256Hex,
  mode: Schema.Literals([0o644, 0o755]),
  executable: Schema.Boolean,
}) {}

export class ScaffoldWorkspaceMigrationTombstone extends Schema.Class<ScaffoldWorkspaceMigrationTombstone>(
  "ScaffoldWorkspaceMigrationTombstone",
)({ path: WorkspaceMigrationRelativePath }) {}

export class ScaffoldWorkspaceMigrationSymlink extends Schema.Class<ScaffoldWorkspaceMigrationSymlink>(
  "ScaffoldWorkspaceMigrationSymlink",
)({
  path: WorkspaceMigrationRelativePath,
  target: TrimmedNonEmptyString,
}) {}

export class OmpWorkspaceMigrationExport extends Schema.Class<OmpWorkspaceMigrationExport>(
  "OmpWorkspaceMigrationExport",
)({
  version: Schema.Literal(1),
  sessionId: TrimmedNonEmptyString,
  sourceChecksum: Sha256Hex,
  files: Schema.Array(
    Schema.Struct({
      path: WorkspaceMigrationRelativePath,
      size: NonNegativeInt,
      sha256: Sha256Hex,
    }),
  ),
}) {}

export class ScaffoldRetentionCaptureInput extends Schema.Class<ScaffoldRetentionCaptureInput>(
  "ScaffoldRetentionCaptureInput",
)({
  version: Schema.Literal("scaffold.retention.capture.v1"),
  archiveId: TrimmedNonEmptyString.check(Schema.isPattern(/^(?!\.\.?$)[^/\\]+$/)),
  operationId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  sourceSandboxId: TrimmedNonEmptyString,
  sourcePauseLifecycleEpoch: NonNegativeInt,
}) {}

export class ScaffoldRetentionVisibleTranscript extends Schema.Class<ScaffoldRetentionVisibleTranscript>(
  "ScaffoldRetentionVisibleTranscript",
)({
  version: Schema.Literal(1),
  messages: Schema.Array(
    Schema.Struct({
      role: TrimmedNonEmptyString,
      text: Schema.String,
      attachments: Schema.Array(Schema.Unknown),
    }),
  ),
  activities: Schema.Array(
    Schema.Struct({
      tone: TrimmedNonEmptyString,
      kind: TrimmedNonEmptyString,
      summary: Schema.String,
      payload: Schema.Unknown,
    }),
  ),
}) {}

const ScaffoldRetentionSourceIdentity = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  sandboxId: TrimmedNonEmptyString,
  pauseLifecycleEpoch: NonNegativeInt,
  environmentId: EnvironmentId,
  globalSessionId: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  ompSessionId: TrimmedNonEmptyString,
  rootPath: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  effort: Schema.optionalKey(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  capturedAt: TrimmedNonEmptyString,
  transcriptSha256: Sha256Hex,
});

export class ScaffoldRetentionT3Metadata extends Schema.Class<ScaffoldRetentionT3Metadata>(
  "ScaffoldRetentionT3Metadata",
)({
  version: Schema.Literal("scaffold.retention.t3_metadata.v1"),
  archiveId: TrimmedNonEmptyString,
  operationId: TrimmedNonEmptyString,
  source: ScaffoldRetentionSourceIdentity,
  visibleTranscript: ScaffoldRetentionVisibleTranscript,
  ompExport: OmpWorkspaceMigrationExport,
}) {}

export class ScaffoldRetentionCaptureReceipt extends Schema.Class<ScaffoldRetentionCaptureReceipt>(
  "ScaffoldRetentionCaptureReceipt",
)({
  ok: Schema.Literal(true),
  version: Schema.Literal("scaffold.retention.capture.receipt.v1"),
  archiveId: TrimmedNonEmptyString,
  operationId: TrimmedNonEmptyString,
  source: ScaffoldRetentionSourceIdentity,
  ompBundle: Schema.Struct({
    path: TrimmedNonEmptyString,
    bytes: PositiveInt,
    sha256: Sha256Hex,
  }),
  t3Metadata: Schema.Struct({
    path: TrimmedNonEmptyString,
    bytes: PositiveInt,
    sha256: Sha256Hex,
  }),
}) {}

export class ScaffoldWorkspaceMigrationPayload extends Schema.Class<ScaffoldWorkspaceMigrationPayload>(
  "ScaffoldWorkspaceMigrationPayload",
)({
  version: Schema.Literal("scaffold.workspace_migration.payload.v1"),
  operationId: TrimmedNonEmptyString,
  source: Schema.Struct({
    environmentId: EnvironmentId,
    projectId: ProjectId,
    threadId: ThreadId,
    globalSessionId: TrimmedNonEmptyString,
    ompSessionId: TrimmedNonEmptyString,
    model: TrimmedNonEmptyString,
    effort: Schema.optionalKey(TrimmedNonEmptyString),
    capturedAt: TrimmedNonEmptyString,
    transcriptSha256: Sha256Hex,
  }),
  ompBundle: Schema.Struct({
    path: Schema.Literal(".__scaffold_workspace_migration__/omp-session.zip"),
    bytes: PositiveInt,
    sha256: Sha256Hex,
  }),
  ompExport: OmpWorkspaceMigrationExport,
  t3Metadata: Schema.Struct({
    path: Schema.Literal(".__scaffold_workspace_migration__/t3-metadata.json"),
    bytes: PositiveInt,
    sha256: Sha256Hex,
  }),
  credentialExclusions: ScaffoldWorkspaceMigrationCredentialExclusions,
  unsupportedFilesystemCases: ScaffoldWorkspaceMigrationUnsupportedFilesystemCases,
  digestSha256: Sha256Hex,
}) {}

const ScaffoldRetentionCloneSourceIdentity = Schema.Struct({
  t3SessionId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  globalSessionId: TrimmedNonEmptyString,
  ompSessionId: TrimmedNonEmptyString,
  title: Schema.optionalKey(TrimmedNonEmptyString),
  model: TrimmedNonEmptyString,
  effort: Schema.optionalKey(TrimmedNonEmptyString),
  capturedAt: TrimmedNonEmptyString,
  transcriptSha256: Sha256Hex,
  eventSequence: Schema.optionalKey(Schema.Never),
  acpSequence: Schema.optionalKey(Schema.Never),
  resumeCursor: Schema.optionalKey(Schema.Never),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const ScaffoldRetentionCloneArchiveId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^sra_[A-Za-z0-9_-]{8,120}$/),
);

/** Archive-bound retention payload emitted by the Scaffold sandbox supervisor. */
export class ScaffoldRetentionClonePayload extends Schema.Class<ScaffoldRetentionClonePayload>(
  "ScaffoldRetentionClonePayload",
)(
  Schema.Struct({
    version: Schema.Literal("scaffold.workspace_migration.payload.v3"),
    kind: Schema.Literal("retention-clone"),
    exact: Schema.Literal(false),
    archiveId: ScaffoldRetentionCloneArchiveId,
    operationId: TrimmedNonEmptyString,
    source: ScaffoldRetentionCloneSourceIdentity,
    ompBundle: Schema.Struct({
      path: Schema.Literal(".__scaffold_workspace_migration__/omp-session.zip"),
      bytes: PositiveInt,
      sha256: Sha256Hex,
    }),
    ompExport: OmpWorkspaceMigrationExport,
    t3Metadata: Schema.Struct({
      path: Schema.Literal(".__scaffold_workspace_migration__/t3-metadata.json"),
      bytes: PositiveInt,
      sha256: Sha256Hex,
    }),
    credentialExclusions: ScaffoldWorkspaceMigrationCredentialExclusions,
    unsupportedFilesystemCases: ScaffoldWorkspaceMigrationUnsupportedFilesystemCases,
    digestSha256: Sha256Hex,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
) {}

/** Sandbox-local supervisor -> T3 import request. Archive bytes never cross the browser. */
export class ScaffoldWorkspaceMigrationImportInput extends Schema.Class<ScaffoldWorkspaceMigrationImportInput>(
  "ScaffoldWorkspaceMigrationImportInput",
)({
  version: Schema.Literal("scaffold.t3_workspace_migration.import.v1"),
  operationId: TrimmedNonEmptyString,
  requestFingerprintSha256: Sha256Hex,
  payloadDigestSha256: Sha256Hex,
  payload: ScaffoldWorkspaceMigrationPayload,
  authority: Schema.Struct({
    version: Schema.Literal("scaffold.workspace_migration.import_authority.v1"),
    authorityId: TrimmedNonEmptyString,
    grantId: TrimmedNonEmptyString,
    secret: TrimmedNonEmptyString,
    sandboxId: TrimmedNonEmptyString,
    sessionId: TrimmedNonEmptyString,
    lifecycleEpoch: PositiveInt,
    operationId: TrimmedNonEmptyString,
    payloadDigestSha256: Sha256Hex,
    archiveSha256: Sha256Hex,
    transcriptSha256: Sha256Hex,
    ompBundleSha256: Sha256Hex,
    t3MetadataSha256: Sha256Hex,
    requestFingerprintSha256: Sha256Hex,
    processingDeadlineAt: TrimmedNonEmptyString,
  }),
  source: Schema.Struct({
    environmentId: EnvironmentId,
    projectId: ProjectId,
    threadId: ThreadId,
    globalSessionId: TrimmedNonEmptyString,
    ompSessionId: TrimmedNonEmptyString,
    title: Schema.optionalKey(TrimmedNonEmptyString),
    model: TrimmedNonEmptyString,
    effort: Schema.optionalKey(TrimmedNonEmptyString),
    capturedAt: TrimmedNonEmptyString,
    transcriptSha256: Sha256Hex,
  }),
  ompBundlePath: TrimmedNonEmptyString,
  ompBundleSha256: Sha256Hex,
  ompBundleBytes: PositiveInt,
  t3MetadataPath: TrimmedNonEmptyString,
  t3MetadataSha256: Sha256Hex,
  t3MetadataBytes: PositiveInt,
  workspace: Schema.Struct({
    rootDir: TrimmedNonEmptyString,
    baseSha: Schema.optionalKey(GitCommitId),
    archiveSha256: Sha256Hex,
    files: Schema.Array(ScaffoldWorkspaceMigrationFile),
    tombstones: Schema.Array(ScaffoldWorkspaceMigrationTombstone),
    symlinks: Schema.Array(ScaffoldWorkspaceMigrationSymlink),
  }),
}) {}

export class ScaffoldWorkspaceMigrationImportResult extends Schema.Class<ScaffoldWorkspaceMigrationImportResult>(
  "ScaffoldWorkspaceMigrationImportResult",
)({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  globalSessionId: TrimmedNonEmptyString,
  ompSessionId: TrimmedNonEmptyString,
  operationId: TrimmedNonEmptyString,
  payloadDigestSha256: Sha256Hex,
  ompBundleSha256: Sha256Hex,
  t3MetadataSha256: Sha256Hex,
  workspaceArchiveSha256: Sha256Hex,
  transcriptSha256: Sha256Hex,
  credentialExclusions: ScaffoldWorkspaceMigrationCredentialExclusions,
  unsupportedFilesystemCases: ScaffoldWorkspaceMigrationUnsupportedFilesystemCases,
  provenance: Schema.Struct({
    sourceEnvironmentId: EnvironmentId,
    sourceProjectId: ProjectId,
    sourceThreadId: ThreadId,
    sourceGlobalSessionId: TrimmedNonEmptyString,
    sourceOmpSessionId: TrimmedNonEmptyString,
  }),
}) {}

/**
 * Retention restore is a clone, not an exact handoff. Source ids are audit-only
 * and the request cannot represent a destination identity or resume cursor.
 */
export class ScaffoldRetentionCloneImportInput extends Schema.Class<ScaffoldRetentionCloneImportInput>(
  "ScaffoldRetentionCloneImportInput",
)(
  Schema.Struct({
    version: Schema.Literal("scaffold.t3_workspace_migration.import.v3"),
    kind: Schema.Literal("retention-clone.v1"),
    exact: Schema.Literal(false),
    archiveId: ScaffoldRetentionCloneArchiveId,
    operationId: TrimmedNonEmptyString,
    requestFingerprintSha256: Schema.optionalKey(Sha256Hex),
    payloadDigestSha256: Sha256Hex,
    transcriptSha256: Sha256Hex,
    payload: ScaffoldRetentionClonePayload,
    authority: Schema.optionalKey(ScaffoldWorkspaceMigrationImportInput.fields.authority),
    source: ScaffoldRetentionCloneSourceIdentity,
    ompBundlePath: TrimmedNonEmptyString,
    ompBundleSha256: Sha256Hex,
    ompBundleBytes: PositiveInt,
    t3MetadataPath: TrimmedNonEmptyString,
    t3MetadataSha256: Sha256Hex,
    t3MetadataBytes: PositiveInt,
    workspace: ScaffoldWorkspaceMigrationImportInput.fields.workspace,
    destinationEnvironmentId: Schema.optionalKey(Schema.Never),
    destinationProjectId: Schema.optionalKey(Schema.Never),
    destinationThreadId: Schema.optionalKey(Schema.Never),
    destinationGlobalSessionId: Schema.optionalKey(Schema.Never),
    destinationOmpSessionId: Schema.optionalKey(Schema.Never),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
) {}

export class ScaffoldRetentionCloneImportResult extends Schema.Class<ScaffoldRetentionCloneImportResult>(
  "ScaffoldRetentionCloneImportResult",
)({
  version: Schema.Literal("scaffold.t3_workspace_migration.import_result.v2"),
  kind: Schema.Literal("retention-clone.v1"),
  exact: Schema.Literal(false),
  t3SessionId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  globalSessionId: TrimmedNonEmptyString,
  ompSessionId: TrimmedNonEmptyString,
  operationId: TrimmedNonEmptyString,
  payloadDigestSha256: Sha256Hex,
  ompBundleSha256: Sha256Hex,
  t3MetadataSha256: Sha256Hex,
  workspaceArchiveSha256: Sha256Hex,
  transcriptSha256: Sha256Hex,
  credentialExclusions: ScaffoldWorkspaceMigrationCredentialExclusions,
  unsupportedFilesystemCases: ScaffoldWorkspaceMigrationUnsupportedFilesystemCases,
  provenance: Schema.Struct({
    archiveId: TrimmedNonEmptyString,
    sourceT3SessionId: TrimmedNonEmptyString,
    sourceEnvironmentId: EnvironmentId,
    sourceProjectId: ProjectId,
    sourceThreadId: ThreadId,
    sourceGlobalSessionId: TrimmedNonEmptyString,
    sourceOmpSessionId: TrimmedNonEmptyString,
  }),
}) {}

/** Local T3 -> scaffold-handoff command. File bytes stay on the host filesystem. */
export class ScaffoldWorkspaceMigrationCommand extends Schema.Class<ScaffoldWorkspaceMigrationCommand>(
  "ScaffoldWorkspaceMigrationCommand",
)({
  version: Schema.Literal("scaffold.workspace_migration.command.v1"),
  operationId: TrimmedNonEmptyString,
  requestFingerprintSha256: Schema.optionalKey(Sha256Hex),
  cwd: TrimmedNonEmptyString,
  source: Schema.Struct({
    environmentId: EnvironmentId,
    projectId: ProjectId,
    threadId: ThreadId,
    globalSessionId: TrimmedNonEmptyString,
    ompSessionId: TrimmedNonEmptyString,
    model: TrimmedNonEmptyString,
    effort: Schema.optionalKey(TrimmedNonEmptyString),
    capturedAt: TrimmedNonEmptyString,
    transcriptSha256: Sha256Hex,
  }),
  ompBundlePath: TrimmedNonEmptyString,
  ompExport: OmpWorkspaceMigrationExport,
  t3MetadataPath: TrimmedNonEmptyString,
  t3MetadataSha256: Sha256Hex,
  credentialExclusions: ScaffoldWorkspaceMigrationCredentialExclusions,
  unsupportedFilesystemCases: ScaffoldWorkspaceMigrationUnsupportedFilesystemCases,
  secretOverrideReason: Schema.optionalKey(TrimmedNonEmptyString),
  authorityHandshake: Schema.optionalKey(
    Schema.Struct({
      proposalPath: TrimmedNonEmptyString,
      acknowledgementPath: TrimmedNonEmptyString,
    }),
  ),
}) {}

export class ScaffoldWorkspaceMigrationAuthorityProposal extends Schema.Class<ScaffoldWorkspaceMigrationAuthorityProposal>(
  "ScaffoldWorkspaceMigrationAuthorityProposal",
)({
  version: Schema.Literal("scaffold.workspace_migration.authority_proposal.v1"),
  operationId: TrimmedNonEmptyString,
  requestFingerprintSha256: Sha256Hex,
  binding: Schema.Struct({
    operationId: TrimmedNonEmptyString,
    requestFingerprintSha256: Sha256Hex,
    sessionId: TrimmedNonEmptyString,
    sandboxId: TrimmedNonEmptyString,
    lifecycleEpoch: PositiveInt,
    grantId: TrimmedNonEmptyString,
    payloadDigestSha256: Sha256Hex,
    archiveSha256: Sha256Hex,
    transcriptSha256: Sha256Hex,
    ompBundleSha256: Sha256Hex,
    t3MetadataSha256: Sha256Hex,
    state: Schema.Literal("pending"),
    processingDeadlineAt: TrimmedNonEmptyString,
  }),
}) {}

export class ScaffoldWorkspaceMigrationAuthorityAcknowledgement extends Schema.Class<ScaffoldWorkspaceMigrationAuthorityAcknowledgement>(
  "ScaffoldWorkspaceMigrationAuthorityAcknowledgement",
)({
  version: Schema.Literal("scaffold.workspace_migration.authority_ack.v1"),
  operationId: TrimmedNonEmptyString,
  requestFingerprintSha256: Sha256Hex,
  grantId: TrimmedNonEmptyString,
}) {}

/** Credential-free receipt emitted by scaffold-handoff after destination import. */
export class ScaffoldWorkspaceMigrationReceipt extends Schema.Class<ScaffoldWorkspaceMigrationReceipt>(
  "ScaffoldWorkspaceMigrationReceipt",
)({
  ok: Schema.Literal(true),
  version: Schema.Literal("scaffold.workspace_migration.receipt.v1"),
  sessionId: TrimmedNonEmptyString,
  operationId: TrimmedNonEmptyString,
  payloadDigestSha256: Sha256Hex,
  archiveSha256: Sha256Hex,
  ompBundleSha256: Sha256Hex,
  t3MetadataSha256: Sha256Hex,
  workspaceArchiveSha256: Sha256Hex,
  transcriptSha256: Sha256Hex,
  credentialExclusions: ScaffoldWorkspaceMigrationCredentialExclusions,
  unsupportedFilesystemCases: ScaffoldWorkspaceMigrationUnsupportedFilesystemCases,
  binding: ScaffoldEnvironmentBinding,
  source: Schema.Struct({
    environmentId: EnvironmentId,
    projectId: ProjectId,
    threadId: ThreadId,
    globalSessionId: TrimmedNonEmptyString,
    ompSessionId: TrimmedNonEmptyString,
  }),
  destination: Schema.Struct({
    environmentId: EnvironmentId,
    projectId: ProjectId,
    threadId: ThreadId,
    globalSessionId: TrimmedNonEmptyString,
    ompSessionId: TrimmedNonEmptyString,
  }),
}) {}
