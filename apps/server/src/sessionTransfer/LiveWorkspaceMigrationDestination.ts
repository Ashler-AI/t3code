// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type RuntimeMode,
  ThreadId,
  type ScaffoldWorkspaceMigrationImportResult,
  type ScaffoldRetentionCloneImportInput,
  type ScaffoldRetentionCloneImportResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { makeOmpEventId, parseOmpResume } from "../provider/Layers/OmpAdapter.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type {
  OmpSessionImport,
  OmpSessionTransferRuntimeOptions,
} from "./OmpSessionTransferRuntime.ts";
import { makeOmpSessionTransferRuntime } from "./OmpSessionTransferRuntime.ts";
import { canonicalTranscriptSha256 } from "./CanonicalTranscript.ts";
import { makeSqlDestinationOperationStore } from "./DestinationOperationFingerprint.ts";
import {
  WorkspaceMigrationImportError,
  type WorkspaceMigrationDestinationPort,
} from "./WorkspaceMigrationImportService.ts";

function stableId(prefix: string, operationId: string): string {
  return `${prefix}-${NodeCrypto.createHash("sha256").update(operationId).digest("hex").slice(0, 24)}`;
}

function workspaceMigrationOmpSessionId(operationId: string): string {
  const bytes = NodeCrypto.createHash("sha256")
    .update(`transfer-omp\0${operationId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildRetentionCloneDestinationPlan(input: {
  readonly request: ScaffoldRetentionCloneImportInput;
  readonly destinationT3SessionId: string;
  readonly destinationEnvironmentId: EnvironmentId;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}) {
  const projectId = ProjectId.make(stableId("retention-project", input.request.operationId));
  const threadId = ThreadId.make(stableId("retention-thread", input.request.operationId));
  const ompSessionId = stableId("retention-omp", input.request.operationId);
  const globalSessionId = `sf:${input.destinationEnvironmentId}:${threadId}`;
  if (
    input.destinationT3SessionId === input.request.source.t3SessionId ||
    input.destinationEnvironmentId === input.request.source.environmentId ||
    projectId === input.request.source.projectId ||
    threadId === input.request.source.threadId ||
    globalSessionId === input.request.source.globalSessionId ||
    ompSessionId === input.request.source.ompSessionId
  ) {
    throw new WorkspaceMigrationImportError({
      code: "retention_clone_identity_reuse",
      detail: "A retention clone must mint all six destination identities.",
    });
  }
  const modelSelection =
    input.modelSelection ??
    ({
      instanceId: ProviderInstanceId.make("omp"),
      model: input.request.source.model,
      ...(input.request.source.effort
        ? { options: [{ id: "reasoningEffort", value: input.request.source.effort }] }
        : {}),
    } as ModelSelection);
  const runtimeMode = input.runtimeMode ?? "full-access";
  const interactionMode = input.interactionMode ?? "default";
  const resumeCursor = {
    schemaVersion: 3 as const,
    sessionId: ompSessionId,
    eventSequence: 0,
    acpSequence: 0,
  };
  return {
    projectCommand: {
      type: "project.create" as const,
      commandId: CommandId.make(stableId("retention-project-command", input.request.operationId)),
      projectId,
      title: input.request.source.title ?? "Restored Scaffold session",
      workspaceRoot: input.request.workspace.rootDir,
      defaultModelSelection: modelSelection,
      createdAt: input.request.source.capturedAt,
    },
    threadCommand: {
      type: "thread.create" as const,
      commandId: CommandId.make(stableId("retention-thread-command", input.request.operationId)),
      threadId,
      projectId,
      title: input.request.source.title ?? "Restored Scaffold session",
      modelSelection,
      runtimeMode,
      interactionMode,
      branch: null,
      worktreePath: null,
      createdAt: input.request.source.capturedAt,
    },
    resumeCursor,
    result: {
      version: "scaffold.t3_workspace_migration.import_result.v2",
      kind: "retention-clone.v1",
      exact: false,
      t3SessionId: input.destinationT3SessionId,
      environmentId: input.destinationEnvironmentId,
      projectId,
      threadId,
      globalSessionId,
      ompSessionId,
      operationId: input.request.operationId,
      payloadDigestSha256: input.request.payloadDigestSha256,
      ompBundleSha256: input.request.ompBundleSha256,
      t3MetadataSha256: input.request.t3MetadataSha256,
      workspaceArchiveSha256: input.request.workspace.archiveSha256,
      transcriptSha256: input.request.transcriptSha256,
      credentialExclusions: input.request.payload.credentialExclusions,
      unsupportedFilesystemCases: input.request.payload.unsupportedFilesystemCases,
      provenance: {
        archiveId: input.request.archiveId,
        sourceT3SessionId: input.request.source.t3SessionId,
        sourceEnvironmentId: input.request.source.environmentId,
        sourceProjectId: input.request.source.projectId,
        sourceThreadId: input.request.source.threadId,
        sourceGlobalSessionId: input.request.source.globalSessionId,
        sourceOmpSessionId: input.request.source.ompSessionId,
      },
    } satisfies ScaffoldRetentionCloneImportResult,
  };
}

function workspaceMigrationLifecycleCommandId(
  environmentId: string,
  threadId: string,
  eventId: string,
) {
  return CommandId.make(
    [
      "provider",
      encodeURIComponent(environmentId),
      encodeURIComponent(threadId),
      encodeURIComponent(eventId),
      "thread-session-set",
      "0",
    ].join(":"),
  );
}

export function buildWorkspaceMigrationDestinationPlan(input: {
  readonly request: Parameters<WorkspaceMigrationDestinationPort["import"]>[0]["request"];
  readonly source: Parameters<WorkspaceMigrationDestinationPort["import"]>[0]["source"];
  readonly destinationEnvironmentId: EnvironmentId;
  readonly importedOmpSessionId: string;
}) {
  const projectId = ProjectId.make(stableId("transfer-project", input.request.operationId));
  const threadId = ThreadId.make(stableId("transfer-thread", input.request.operationId));
  const ompSessionId = workspaceMigrationOmpSessionId(input.request.operationId);
  const globalSessionId = `sf:${input.destinationEnvironmentId}:${threadId}`;
  if (
    input.destinationEnvironmentId === input.source.environmentId ||
    projectId === input.source.projectId ||
    threadId === input.source.threadId ||
    globalSessionId === input.request.source.globalSessionId ||
    ompSessionId === input.source.continuation.sessionId
  ) {
    throw new WorkspaceMigrationImportError({
      code: "workspace_migration_identity_reuse",
      detail: "A workspace migration must mint every destination identity.",
    });
  }
  if (input.importedOmpSessionId !== ompSessionId) {
    throw new WorkspaceMigrationImportError({
      code: "workspace_migration_omp_identity_mismatch",
      detail: "Imported OMP bundle was not installed under the deterministic destination identity.",
    });
  }

  const resumeCursor = {
    schemaVersion: 3 as const,
    sessionId: input.importedOmpSessionId,
    eventSequence: 0,
    acpSequence: 0,
  };
  return {
    projectCommand: {
      type: "project.create" as const,
      commandId: CommandId.make(stableId("transfer-project-command", input.request.operationId)),
      projectId,
      title: input.source.title,
      workspaceRoot: input.request.workspace.rootDir,
      defaultModelSelection: input.source.modelSelection,
      createdAt: input.source.capturedAt,
    },
    threadCommand: {
      type: "thread.create" as const,
      commandId: CommandId.make(stableId("transfer-thread-command", input.request.operationId)),
      threadId,
      projectId,
      title: input.source.title,
      modelSelection: input.source.modelSelection,
      runtimeMode: input.source.runtimeMode,
      interactionMode: input.source.interactionMode,
      branch: null,
      worktreePath: null,
      createdAt: input.source.capturedAt,
    },
    binding: {
      threadId,
      provider: ProviderDriverKind.make("omp"),
      providerInstanceId: input.source.modelSelection.instanceId,
      status: "starting" as const,
      resumeCursor,
      runtimeMode: input.source.runtimeMode,
    },
    startInput: {
      threadId,
      provider: ProviderDriverKind.make("omp"),
      providerInstanceId: input.source.modelSelection.instanceId,
      cwd: input.request.workspace.rootDir,
      modelSelection: input.source.modelSelection,
      resumeCursor,
      runtimeMode: input.source.runtimeMode,
    },
    result: {
      environmentId: input.destinationEnvironmentId,
      projectId,
      threadId,
      globalSessionId,
      ompSessionId: input.importedOmpSessionId,
      operationId: input.request.operationId,
      payloadDigestSha256: input.request.payloadDigestSha256,
      ompBundleSha256: input.request.ompBundleSha256,
      t3MetadataSha256: input.request.t3MetadataSha256,
      workspaceArchiveSha256: input.request.workspace.archiveSha256,
      transcriptSha256: input.source.transcriptSha256,
      credentialExclusions: input.request.payload.credentialExclusions,
      unsupportedFilesystemCases: input.request.payload.unsupportedFilesystemCases,
      provenance: {
        sourceEnvironmentId: input.source.environmentId,
        sourceProjectId: input.source.projectId,
        sourceThreadId: input.source.threadId,
        sourceGlobalSessionId: input.request.source.globalSessionId,
        sourceOmpSessionId: input.source.continuation.sessionId,
      },
    } satisfies ScaffoldWorkspaceMigrationImportResult,
  };
}

export interface WorkspaceMigrationCommitProof {
  readonly snapshot:
    | {
        readonly snapshotSequence: number;
        readonly thread: {
          readonly projectId: string;
          readonly modelSelection: ModelSelection;
          readonly runtimeMode: RuntimeMode;
          readonly interactionMode: ProviderInteractionMode;
          readonly session: null | { readonly status: string; readonly runtimeMode: RuntimeMode };
          readonly messages: Parameters<typeof canonicalTranscriptSha256>[0]["messages"];
          readonly activities: Parameters<typeof canonicalTranscriptSha256>[0]["activities"];
        };
      }
    | undefined;
  readonly binding: ProviderRuntimeBinding | undefined;
  readonly receipt:
    | {
        readonly commandId: string;
        readonly status: string;
        readonly aggregateKind: string;
        readonly aggregateId: string;
        readonly resultSequence: number;
      }
    | undefined;
}

function runtimeCanonicalEvent(
  binding: ProviderRuntimeBinding,
): { readonly sourceSequence: number; readonly eventId: string } | undefined {
  const payload = binding.runtimePayload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const sourceSequence = Reflect.get(payload, "canonicalSourceSequence");
  const eventId = Reflect.get(payload, "canonicalEventId");
  return typeof sourceSequence === "number" &&
    Number.isSafeInteger(sourceSequence) &&
    sourceSequence >= 0 &&
    typeof eventId === "string"
    ? { sourceSequence, eventId }
    : undefined;
}

export function isWorkspaceMigrationDestinationCommitted(input: {
  readonly proof: WorkspaceMigrationCommitProof;
  readonly projectId: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly ompSessionId: string;
  readonly importedAcpSequence: number;
  readonly transcriptSha256: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): boolean {
  const { snapshot, binding, receipt } = input.proof;
  if (!snapshot || !binding || !receipt) return false;
  const cursor = parseOmpResume(binding.resumeCursor);
  const canonical = runtimeCanonicalEvent(binding);
  return (
    snapshot.thread.projectId === input.projectId &&
    snapshot.thread.modelSelection.instanceId === input.modelSelection.instanceId &&
    snapshot.thread.modelSelection.model === input.modelSelection.model &&
    JSON.stringify(snapshot.thread.modelSelection.options ?? []) ===
      JSON.stringify(input.modelSelection.options ?? []) &&
    snapshot.thread.runtimeMode === input.runtimeMode &&
    snapshot.thread.interactionMode === input.interactionMode &&
    snapshot.thread.session?.status === "ready" &&
    snapshot.thread.session.runtimeMode === input.runtimeMode &&
    canonicalTranscriptSha256(snapshot.thread) === input.transcriptSha256 &&
    binding.provider === ProviderDriverKind.make("omp") &&
    binding.providerInstanceId === input.modelSelection.instanceId &&
    binding.runtimeMode === input.runtimeMode &&
    binding.status === "running" &&
    cursor !== undefined &&
    cursor.sessionId === input.ompSessionId &&
    cursor.activeTurnId === undefined &&
    // This is the exact portable OMP history boundary at initial import, not a
    // destination continuation watermark. Later ACP history cannot prove the import.
    cursor.acpSequence === input.importedAcpSequence &&
    canonical !== undefined &&
    canonical.sourceSequence === cursor.eventSequence &&
    canonical.eventId === makeOmpEventId(cursor.sessionId, cursor.eventSequence) &&
    receipt.commandId ===
      workspaceMigrationLifecycleCommandId(
        input.environmentId,
        input.threadId,
        canonical.eventId,
      ) &&
    receipt.status === "accepted" &&
    receipt.aggregateKind === "thread" &&
    receipt.aggregateId === input.threadId &&
    snapshot.snapshotSequence >= receipt.resultSequence
  );
}

export async function awaitWorkspaceMigrationProjection(input: {
  readonly read: () => Promise<WorkspaceMigrationCommitProof>;
  readonly expected: Omit<Parameters<typeof isWorkspaceMigrationDestinationCommitted>[0], "proof">;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly attempts?: number;
}): Promise<void> {
  const sleep =
    input.sleep ?? ((milliseconds: number) => NodeTimersPromises.setTimeout(milliseconds));
  const attempts = input.attempts ?? 100;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (
      isWorkspaceMigrationDestinationCommitted({ proof: await input.read(), ...input.expected })
    ) {
      return;
    }
    if (attempt + 1 < attempts) await sleep(100);
  }
  throw new WorkspaceMigrationImportError({
    code: "workspace_migration_projection_timeout",
    detail: "Imported OMP history was not committed to the destination projection in time.",
  });
}

/**
 * Live destination implementation. Deterministic command/identity allocation
 * makes a supervisor retry converge after a process restart, while all ids
 * remain distinct from the source T3 projection.
 */
export const makeLiveWorkspaceMigrationDestination = Effect.fn(
  "makeLiveWorkspaceMigrationDestination",
)(function* (
  options: OmpSessionTransferRuntimeOptions & {
    readonly destinationT3SessionId?: string;
    readonly transferRuntime?: {
      readonly importSession: (input: {
        readonly archivePath: string;
        readonly cwd: string;
        readonly sessionDir?: string;
        readonly sourceChecksum?: string;
        readonly additionalDirectories?: ReadonlyArray<string>;
        readonly destinationSessionId?: string;
      }) => Effect.Effect<OmpSessionImport>;
    };
  },
) {
  const engine = yield* OrchestrationEngineService;
  const directory = yield* ProviderSessionDirectory;
  const provider = yield* ProviderService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const commandReceipts = yield* OrchestrationCommandReceiptRepository;
  const sql = yield* SqlClient.SqlClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const ompTransfer = options.transferRuntime ?? (yield* makeOmpSessionTransferRuntime(options));
  const operationStore = makeSqlDestinationOperationStore(sql);

  const importSession: WorkspaceMigrationDestinationPort["import"] = (input) =>
    Effect.gen(function* () {
      const environmentId = yield* environment.getEnvironmentId;
      const destinationOmpSessionId = workspaceMigrationOmpSessionId(input.request.operationId);
      const recoveryPlan = buildWorkspaceMigrationDestinationPlan({
        request: input.request,
        source: input.source,
        destinationEnvironmentId: environmentId,
        importedOmpSessionId: destinationOmpSessionId,
      });
      const operationFingerprint = {
        operationId: input.request.operationId,
        capturedAt: input.source.capturedAt,
        sourceEnvironmentId: input.source.environmentId,
        sourceProjectId: input.source.projectId,
        sourceThreadId: input.source.threadId,
        sourceGlobalSessionId: input.request.source.globalSessionId,
        sourceOmpSessionId: input.source.continuation.sessionId,
        transcriptSha256: input.source.transcriptSha256,
        payloadSha256: input.request.payloadDigestSha256,
        ompBundleSha256: input.request.ompBundleSha256,
        t3MetadataSha256: input.request.t3MetadataSha256,
        workspaceArchiveSha256: input.request.workspace.archiveSha256,
        modelSelection: input.source.modelSelection,
        runtimeMode: input.source.runtimeMode,
        interactionMode: input.source.interactionMode,
        destinationEnvironmentId: environmentId,
        destinationProjectId: recoveryPlan.projectCommand.projectId,
        destinationThreadId: recoveryPlan.threadCommand.threadId,
        destinationGlobalSessionId: recoveryPlan.result.globalSessionId,
        destinationOmpSessionId: recoveryPlan.result.ompSessionId,
        authorityRequestFingerprintSha256: input.request.authority.requestFingerprintSha256,
      } as const;
      yield* Effect.tryPromise(() => operationStore.assertCompatible(operationFingerprint));
      const readCommitProof = Effect.fn("readWorkspaceMigrationCommitProof")(function* () {
        const [snapshotOption, bindingOption] = yield* Effect.all([
          snapshots.getThreadDetailSnapshot(recoveryPlan.threadCommand.threadId),
          directory.getBinding(recoveryPlan.threadCommand.threadId),
        ]);
        const snapshot = Option.getOrUndefined(snapshotOption);
        const binding = Option.getOrUndefined(bindingOption);
        const cursor = binding ? parseOmpResume(binding.resumeCursor) : undefined;
        const canonical = binding ? runtimeCanonicalEvent(binding) : undefined;
        const receipt =
          cursor && canonical
            ? Option.getOrUndefined(
                yield* commandReceipts.getByCommandId({
                  commandId: workspaceMigrationLifecycleCommandId(
                    environmentId,
                    recoveryPlan.threadCommand.threadId,
                    canonical.eventId,
                  ),
                }),
              )
            : undefined;
        return { snapshot, binding, receipt } satisfies WorkspaceMigrationCommitProof;
      });
      const expectedCommit = {
        projectId: recoveryPlan.threadCommand.projectId,
        threadId: recoveryPlan.threadCommand.threadId,
        environmentId,
        ompSessionId: recoveryPlan.result.ompSessionId,
        importedAcpSequence: input.source.continuation.acpSequence,
        transcriptSha256: input.source.transcriptSha256,
        modelSelection: input.source.modelSelection,
        runtimeMode: input.source.runtimeMode,
        interactionMode: input.source.interactionMode,
      } as const;
      const initialProof = yield* readCommitProof();
      if (isWorkspaceMigrationDestinationCommitted({ proof: initialProof, ...expectedCommit })) {
        yield* Effect.tryPromise(() =>
          operationStore.setAuthorityState(operationFingerprint, "completed"),
        );
        return recoveryPlan.result;
      }
      if (
        initialProof.snapshot !== undefined &&
        (initialProof.snapshot.thread.projectId !== expectedCommit.projectId ||
          initialProof.snapshot.thread.modelSelection.instanceId !==
            expectedCommit.modelSelection.instanceId ||
          initialProof.snapshot.thread.modelSelection.model !==
            expectedCommit.modelSelection.model ||
          initialProof.snapshot.thread.runtimeMode !== expectedCommit.runtimeMode ||
          initialProof.snapshot.thread.interactionMode !== expectedCommit.interactionMode)
      ) {
        return yield* new WorkspaceMigrationImportError({
          code: "workspace_migration_recovery_mismatch",
          detail: "Existing deterministic destination projection does not match this operation.",
        });
      }
      const initialCursor = initialProof.binding
        ? parseOmpResume(initialProof.binding.resumeCursor)
        : undefined;
      if (
        initialProof.binding !== undefined &&
        (initialProof.binding.provider !== ProviderDriverKind.make("omp") ||
          initialProof.binding.providerInstanceId !== expectedCommit.modelSelection.instanceId ||
          initialProof.binding.runtimeMode !== expectedCommit.runtimeMode ||
          initialCursor?.sessionId !== expectedCommit.ompSessionId)
      ) {
        return yield* new WorkspaceMigrationImportError({
          code: "workspace_migration_recovery_mismatch",
          detail: "Existing deterministic destination runtime does not match this operation.",
        });
      }
      const sourceChecksum = NodeCrypto.createHash("sha256").update(input.ompBundle).digest("hex");
      const stagingSessionDir = NodePath.join(
        NodePath.dirname(input.request.ompBundlePath),
        "omp-import-staging",
      );
      yield* Effect.tryPromise(() => operationStore.claim(operationFingerprint));
      yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen(function* () {
            const staged = yield* ompTransfer.importSession({
              archivePath: input.request.ompBundlePath,
              cwd: input.request.workspace.rootDir,
              sessionDir: stagingSessionDir,
              sourceChecksum,
              destinationSessionId: recoveryPlan.result.ompSessionId,
            });
            if (
              staged.sourceChecksum !== sourceChecksum ||
              staged.sessionId !== recoveryPlan.result.ompSessionId
            ) {
              return yield* new WorkspaceMigrationImportError({
                code: "workspace_migration_omp_import_checksum_mismatch",
                detail: "OMP import did not confirm the staged portable session boundary.",
              });
            }
            yield* Effect.tryPromise(input.acquireCommitAuthority).pipe(
              Effect.mapError(
                () =>
                  new WorkspaceMigrationImportError({
                    code: "workspace_migration_import_authority_stale",
                    detail:
                      "Supervisor authority expired or was revoked before destination commit.",
                  }),
              ),
            );
            yield* Effect.tryPromise(() =>
              operationStore.setAuthorityState(operationFingerprint, "admitted"),
            );
            const imported = yield* ompTransfer.importSession({
              archivePath: input.request.ompBundlePath,
              cwd: input.request.workspace.rootDir,
              sourceChecksum,
              destinationSessionId: recoveryPlan.result.ompSessionId,
            });
            if (
              imported.sourceChecksum !== sourceChecksum ||
              imported.sessionId !== recoveryPlan.result.ompSessionId
            ) {
              return yield* new WorkspaceMigrationImportError({
                code: "workspace_migration_omp_import_checksum_mismatch",
                detail: "OMP import did not confirm the canonical portable session boundary.",
              });
            }
          }),
        () => Effect.promise(() => NodeFSP.rm(stagingSessionDir, { recursive: true, force: true })),
      ).pipe(
        Effect.catch((error) =>
          Effect.tryPromise(() => operationStore.deletePrepared(operationFingerprint)).pipe(
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );
      yield* engine.dispatch(recoveryPlan.projectCommand);
      yield* engine.dispatch(recoveryPlan.threadCommand);
      // A provider checkpoint can be persisted ahead of the projection and its
      // lifecycle receipt. Reset incomplete recovery to zero; OMP event ids and
      // orchestration command ids are deterministic, so replay is idempotent.
      yield* directory.upsert(recoveryPlan.binding);
      yield* provider.startSession(recoveryPlan.threadCommand.threadId, recoveryPlan.startInput);
      yield* Effect.tryPromise(() =>
        awaitWorkspaceMigrationProjection({
          read: () => readCommitProof().pipe(Effect.runPromise),
          expected: expectedCommit,
        }),
      );
      yield* Effect.tryPromise(() =>
        operationStore.setAuthorityState(operationFingerprint, "completed"),
      );
      return recoveryPlan.result;
    }).pipe(Effect.runPromise);

  const importRetentionClone: NonNullable<
    WorkspaceMigrationDestinationPort["importRetentionClone"]
  > = (input) =>
    Effect.gen(function* () {
      const environmentId = yield* environment.getEnvironmentId;
      const destinationT3SessionId = options.destinationT3SessionId?.trim();
      if (!destinationT3SessionId) {
        return yield* new WorkspaceMigrationImportError({
          code: "retention_clone_t3_session_unavailable",
          detail: "Retention restore requires the destination Scaffold session identity.",
        });
      }
      const plan = buildRetentionCloneDestinationPlan({
        request: input.request,
        destinationT3SessionId,
        destinationEnvironmentId: environmentId,
        modelSelection: input.metadata.source.modelSelection,
        runtimeMode: input.metadata.source.runtimeMode,
        interactionMode: input.metadata.source.interactionMode,
      });
      const sourceChecksum = NodeCrypto.createHash("sha256").update(input.ompBundle).digest("hex");
      const imported = yield* ompTransfer.importSession({
        archivePath: input.request.ompBundlePath,
        cwd: input.request.workspace.rootDir,
        sourceChecksum,
        destinationSessionId: plan.result.ompSessionId,
      });
      if (
        imported.sourceChecksum !== sourceChecksum ||
        imported.sessionId !== plan.result.ompSessionId ||
        imported.sessionId === input.request.source.ompSessionId
      ) {
        return yield* new WorkspaceMigrationImportError({
          code: "retention_clone_omp_identity_mismatch",
          detail: "OMP did not install retained content under the fresh destination identity.",
        });
      }
      yield* Effect.tryPromise(input.acquireCommitAuthority);
      yield* engine.dispatch(plan.projectCommand);
      yield* engine.dispatch(plan.threadCommand);
      yield* directory.upsert({
        threadId: plan.threadCommand.threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: plan.threadCommand.modelSelection.instanceId,
        status: "starting",
        resumeCursor: plan.resumeCursor,
        runtimeMode: plan.threadCommand.runtimeMode,
      });
      yield* provider.startSession(plan.threadCommand.threadId, {
        threadId: plan.threadCommand.threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: plan.threadCommand.modelSelection.instanceId,
        cwd: input.request.workspace.rootDir,
        modelSelection: plan.threadCommand.modelSelection,
        resumeCursor: plan.resumeCursor,
        runtimeMode: plan.threadCommand.runtimeMode,
      });
      yield* Effect.tryPromise(() =>
        awaitWorkspaceMigrationProjection({
          read: () =>
            Effect.gen(function* () {
              const [snapshotOption, bindingOption] = yield* Effect.all([
                snapshots.getThreadDetailSnapshot(plan.threadCommand.threadId),
                directory.getBinding(plan.threadCommand.threadId),
              ]);
              const snapshot = Option.getOrUndefined(snapshotOption);
              const binding = Option.getOrUndefined(bindingOption);
              const cursor = binding ? parseOmpResume(binding.resumeCursor) : undefined;
              const canonical = binding ? runtimeCanonicalEvent(binding) : undefined;
              const receipt =
                cursor && canonical
                  ? Option.getOrUndefined(
                      yield* commandReceipts.getByCommandId({
                        commandId: workspaceMigrationLifecycleCommandId(
                          environmentId,
                          plan.threadCommand.threadId,
                          canonical.eventId,
                        ),
                      }),
                    )
                  : undefined;
              return { snapshot, binding, receipt };
            }).pipe(Effect.runPromise),
          expected: {
            projectId: plan.projectCommand.projectId,
            threadId: plan.threadCommand.threadId,
            environmentId,
            ompSessionId: plan.result.ompSessionId,
            importedAcpSequence: 0,
            transcriptSha256: input.request.transcriptSha256,
            modelSelection: plan.threadCommand.modelSelection,
            runtimeMode: plan.threadCommand.runtimeMode,
            interactionMode: plan.threadCommand.interactionMode,
          },
        }),
      );
      return plan.result;
    }).pipe(Effect.runPromise);

  return {
    import: importSession,
    importRetentionClone,
  } satisfies WorkspaceMigrationDestinationPort;
});
