import * as NodeCrypto from "node:crypto";

import {
  ProviderDriverKind,
  SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
  SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
  scaffoldSessionTransferOperationIdentity,
  scaffoldSessionTransferOperationIdFromSha256,
  type EnvironmentId,
  type ModelSelection,
  type ProviderSessionStartInput,
  type RuntimeMode,
  ScaffoldSessionTransferStartInput,
  ScaffoldWorkspaceMigrationCommand,
  ScaffoldWorkspaceMigrationReceipt,
  SessionTransferSource,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { parseOmpResume } from "../provider/Layers/OmpAdapter.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeOmpSessionTransferRuntime } from "./OmpSessionTransferRuntime.ts";
import { canonicalTranscriptSha256 } from "./CanonicalTranscript.ts";
import { makeLiveScaffoldWorkspaceMigrationCli } from "./ScaffoldWorkspaceMigrationCli.ts";
import { WorkspaceMigrationImportError } from "./WorkspaceMigrationImportService.ts";
import {
  SOURCE_TRANSFER_HEARTBEAT_MS,
  type SourceTransferFenceAcquireResult,
  type SourceTransferAuthorityBinding,
  type SourceTransferFenceRecord,
  type SourceTransferFenceStore,
  type SourceTransferSourceIdentity,
  sourceTransferLeaseDeadline,
} from "./ThreadTransferFence.ts";

const encodeSessionTransferSource = Schema.encodeEffect(
  Schema.fromJsonString(SessionTransferSource),
);
const encodeTransferStartInput = Schema.encodeSync(
  Schema.fromJsonString(ScaffoldSessionTransferStartInput),
);
const SourceTransferReceiptRecord = Schema.Struct({
  version: Schema.Literal("scaffold.session_transfer.source_receipt.v1"),
  operationId: Schema.String,
  requestFingerprintSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  receipt: ScaffoldWorkspaceMigrationReceipt,
});
type SourceTransferReceiptRecord = typeof SourceTransferReceiptRecord.Type;
const decodeSourceTransferReceiptRecordJson = Schema.decodeSync(
  Schema.fromJsonString(SourceTransferReceiptRecord),
);
const encodeSourceTransferReceiptRecordJson = Schema.encodeSync(
  Schema.fromJsonString(SourceTransferReceiptRecord),
);
const encodeAuthorityProofJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

function selectedEffort(source: SessionTransferSource): string | undefined {
  const value = source.modelSelection.options?.find((option) =>
    ["reasoningEffort", "effort", "thinking"].includes(option.id),
  )?.value;
  return typeof value === "string" ? value : undefined;
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateTransferReceiptIdentity(input: {
  readonly receipt: ScaffoldWorkspaceMigrationReceipt;
  readonly transfer: ScaffoldSessionTransferStartInput;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceIdentity: SourceTransferSourceIdentity;
  readonly authority?: SourceTransferAuthorityIdentity;
}): void {
  const { receipt, transfer, sourceEnvironmentId, sourceIdentity, authority } = input;
  if (
    receipt.operationId !== transfer.operationId ||
    receipt.binding.deployment !== transfer.deployment ||
    receipt.source.environmentId !== sourceEnvironmentId ||
    receipt.source.projectId !== sourceIdentity.sourceProjectId ||
    receipt.source.threadId !== transfer.sourceThreadId ||
    receipt.source.globalSessionId !== `sf:${sourceEnvironmentId}:${transfer.sourceThreadId}` ||
    receipt.source.ompSessionId !== sourceIdentity.sourceOmpSessionId ||
    receipt.destination.environmentId === sourceEnvironmentId ||
    receipt.destination.projectId === sourceIdentity.sourceProjectId ||
    receipt.destination.threadId === transfer.sourceThreadId ||
    receipt.destination.globalSessionId !==
      `sf:${receipt.destination.environmentId}:${receipt.destination.threadId}` ||
    receipt.destination.ompSessionId === sourceIdentity.sourceOmpSessionId ||
    receipt.binding.environmentId !== receipt.destination.environmentId ||
    receipt.binding.sessionId !== receipt.sessionId ||
    receipt.archiveSha256 !== receipt.workspaceArchiveSha256 ||
    !sameStrings(
      receipt.credentialExclusions,
      SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
    ) ||
    !sameStrings(
      receipt.unsupportedFilesystemCases,
      SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
    ) ||
    (authority !== undefined &&
      (receipt.payloadDigestSha256 !== authority.payloadDigestSha256 ||
        receipt.archiveSha256 !== authority.archiveSha256 ||
        receipt.workspaceArchiveSha256 !== authority.archiveSha256 ||
        receipt.transcriptSha256 !== authority.transcriptSha256 ||
        receipt.ompBundleSha256 !== authority.ompBundleSha256 ||
        receipt.t3MetadataSha256 !== authority.t3MetadataSha256 ||
        receipt.sessionId !== authority.sessionId ||
        receipt.binding.sessionId !== authority.sessionId ||
        receipt.binding.lifecycleEpoch !== authority.lifecycleEpoch))
  ) {
    throw new WorkspaceMigrationImportError({
      code: "workspace_migration_source_authority_mismatch",
      detail: "Destination completion proof returned a receipt for another operation.",
    });
  }
}

export interface ScaffoldSessionTransferSourcePort {
  readonly start: (
    input: ScaffoldSessionTransferStartInput,
  ) => Effect.Effect<ScaffoldWorkspaceMigrationReceipt, WorkspaceMigrationImportError>;
  readonly reconcile: (
    input: ScaffoldSessionTransferStartInput,
  ) => Effect.Effect<ScaffoldWorkspaceMigrationReceipt, WorkspaceMigrationImportError>;
  readonly abort: (
    input: ScaffoldSessionTransferStartInput,
  ) => Effect.Effect<void, WorkspaceMigrationImportError>;
}

type SourceTransferAuthorityIdentity = {
  readonly operationId: string;
  readonly requestFingerprintSha256: string;
  readonly lifecycleEpoch: number;
  readonly grantId: string;
  readonly sandboxId: string;
  readonly sessionId: string;
  readonly payloadDigestSha256: string;
  readonly archiveSha256: string;
  readonly transcriptSha256: string;
  readonly ompBundleSha256: string;
  readonly t3MetadataSha256: string;
};

type SourceTransferPrebindNoncommittable = {
  readonly state: "noncommittable";
  readonly operationId: string;
  readonly requestFingerprintSha256: string;
  readonly proof: {
    readonly version: "scaffold.workspace_migration.noncommittable.v1";
    readonly scope: "prebind";
    readonly operationId: string;
    readonly requestFingerprintSha256: string;
    readonly revokedAt: string;
    readonly reason: string;
  };
};

type SourceTransferPrebindPending = {
  readonly state: "pending";
  readonly operationId: string;
  readonly requestFingerprintSha256: string;
};

const SourceTransferAuthorityIdentitySchema = Schema.Struct({
  operationId: Schema.String,
  requestFingerprintSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  lifecycleEpoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  grantId: Schema.String,
  sandboxId: Schema.String,
  sessionId: Schema.String,
  payloadDigestSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  archiveSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  transcriptSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  ompBundleSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  t3MetadataSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
const SourceTransferBoundNoncommittableProofSchema = Schema.Struct({
  version: Schema.Literal("scaffold.workspace_migration.noncommittable.v1"),
  scope: Schema.Literal("bound"),
  operationId: Schema.String,
  requestFingerprintSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  sessionId: Schema.String,
  sandboxId: Schema.String,
  lifecycleEpoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  grantId: Schema.String,
  revokedAt: Schema.String,
  reason: Schema.String,
});
const SourceTransferPrebindNoncommittableProofSchema = Schema.Struct({
  version: Schema.Literal("scaffold.workspace_migration.noncommittable.v1"),
  scope: Schema.Literal("prebind"),
  operationId: Schema.String,
  requestFingerprintSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  revokedAt: Schema.String,
  reason: Schema.String,
});
const SourceTransferAuthorityResolutionSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    version: Schema.Literal("scaffold.workspace_migration.operation_status.v1"),
    state: Schema.Literal("pending"),
    binding: SourceTransferAuthorityIdentitySchema,
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    version: Schema.Literal("scaffold.workspace_migration.operation_status.v1"),
    state: Schema.Literal("admitted"),
    binding: SourceTransferAuthorityIdentitySchema,
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    version: Schema.Literal("scaffold.workspace_migration.operation_status.v1"),
    state: Schema.Literal("completed"),
    binding: SourceTransferAuthorityIdentitySchema,
    receipt: ScaffoldWorkspaceMigrationReceipt,
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    version: Schema.Literal("scaffold.workspace_migration.operation_status.v1"),
    state: Schema.Literal("noncommittable"),
    binding: SourceTransferAuthorityIdentitySchema,
    proof: SourceTransferBoundNoncommittableProofSchema,
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    version: Schema.Literal("scaffold.workspace_migration.operation_status.v1"),
    state: Schema.Literal("noncommittable"),
    proof: SourceTransferPrebindNoncommittableProofSchema,
  }),
]);
const decodeSourceTransferAuthorityResolutionRaw = Schema.decodeUnknownSync(
  SourceTransferAuthorityResolutionSchema,
);

export function decodeSourceTransferAuthorityResolution(
  input: unknown,
  expected: { readonly operationId: string; readonly requestFingerprintSha256: string },
): SourceTransferAuthorityResolution {
  if (
    input !== null &&
    typeof input === "object" &&
    "error" in input &&
    input.error === "workspace_migration_operation_unknown"
  ) {
    return { state: "pending", ...expected };
  }
  const resolution = decodeSourceTransferAuthorityResolutionRaw(input);
  if (resolution.state === "noncommittable" && !("binding" in resolution)) {
    return {
      state: "noncommittable",
      operationId: resolution.proof.operationId,
      requestFingerprintSha256: resolution.proof.requestFingerprintSha256,
      proof: resolution.proof,
    };
  }
  return {
    ...resolution.binding,
    state: resolution.state === "admitted" ? "pending" : resolution.state,
    ...(resolution.state === "completed" ? { receipt: resolution.receipt } : {}),
    ...(resolution.state === "noncommittable" ? { proof: resolution.proof } : {}),
  } as SourceTransferAuthorityResolution;
}

export type SourceTransferAuthorityResolution =
  | (SourceTransferAuthorityIdentity &
      (
        | {
            readonly state: "pending";
          }
        | {
            readonly state: "completed";
            readonly receipt: ScaffoldWorkspaceMigrationReceipt;
          }
        | {
            readonly state: "noncommittable";
            readonly proof: {
              readonly version: "scaffold.workspace_migration.noncommittable.v1";
              readonly scope: "bound";
              readonly operationId: string;
              readonly requestFingerprintSha256: string;
              readonly sessionId: string;
              readonly sandboxId: string;
              readonly lifecycleEpoch: number;
              readonly grantId: string;
              readonly revokedAt: string;
              readonly reason: string;
            };
          }
      ))
  | SourceTransferPrebindNoncommittable
  | SourceTransferPrebindPending;

function isPrebindNoncommittable(
  resolution: SourceTransferAuthorityResolution,
): resolution is SourceTransferPrebindNoncommittable {
  return resolution.state === "noncommittable" && resolution.proof.scope === "prebind";
}

export interface SourceTransferAuthorityPort {
  readonly reconcile: (
    input: ScaffoldSessionTransferStartInput & { readonly requestFingerprintSha256: string },
  ) => Promise<SourceTransferAuthorityResolution>;
  /** Requests revocation, then returns the authoritative serialized result. */
  readonly abort: (
    input: ScaffoldSessionTransferStartInput & { readonly requestFingerprintSha256: string },
  ) => Promise<SourceTransferAuthorityResolution>;
}

export type SourceTransferReceiptStore =
  SourceTransferFenceStore<ScaffoldWorkspaceMigrationReceipt>;

export function sourceTransferRequestFingerprint(input: ScaffoldSessionTransferStartInput): string {
  return NodeCrypto.createHash("sha256").update(encodeTransferStartInput(input)).digest("hex");
}

export function sourceTransferOperationId(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly deployment: ScaffoldSessionTransferStartInput["deployment"];
}): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(scaffoldSessionTransferOperationIdentity(input))
    .digest("hex");
  return scaffoldSessionTransferOperationIdFromSha256(digest);
}

export function sourceTransferAttemptOperationId(
  seriesOperationId: string,
  generation: number,
): string {
  return generation === 1 ? seriesOperationId : `${seriesOperationId}:attempt:${generation}`;
}

function epochMillisToIso(epochMillis: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(epochMillis));
}

export function makeIdempotentScaffoldSessionTransferSource(options: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly execute: (
    input: ScaffoldSessionTransferStartInput,
    durableCapture: { readonly capturedAt: string },
    authorityJournal: {
      readonly requestFingerprintSha256: string;
      readonly bindSourceIdentity: (
        sourceIdentity: SourceTransferSourceIdentity,
      ) => Effect.Effect<void, WorkspaceMigrationImportError>;
      readonly bind: (
        authority: SourceTransferAuthorityBinding,
      ) => Effect.Effect<void, WorkspaceMigrationImportError>;
    },
  ) => Effect.Effect<ScaffoldWorkspaceMigrationReceipt, WorkspaceMigrationImportError>;
  readonly store: SourceTransferReceiptStore;
  readonly authority?: SourceTransferAuthorityPort;
  readonly now?: () => number;
  readonly leaseOwner?: () => string;
}): ScaffoldSessionTransferSourcePort {
  const operations = new Map<
    string,
    {
      readonly requestFingerprintSha256: string;
      readonly promise: Promise<ScaffoldWorkspaceMigrationReceipt>;
    }
  >();

  const startPhysical = (input: ScaffoldSessionTransferStartInput) => {
    const requestFingerprintSha256 = sourceTransferRequestFingerprint(input);
    const existing = operations.get(input.operationId);
    if (existing) {
      if (existing.requestFingerprintSha256 !== requestFingerprintSha256) {
        return Effect.fail(
          new WorkspaceMigrationImportError({
            code: "workspace_migration_source_operation_conflict",
            detail: "The operation id is already bound to a different source transfer request.",
          }),
        );
      }
      return Effect.tryPromise({
        try: () => existing.promise,
        catch: (error) =>
          error instanceof WorkspaceMigrationImportError
            ? error
            : new WorkspaceMigrationImportError({
                code: "workspace_migration_source_failed",
                detail: "The source transfer operation failed.",
              }),
      });
    }

    const promise = Promise.resolve().then(async () => {
      const now = options.now ?? Date.now;
      const leaseOwner = options.leaseOwner?.() ?? NodeCrypto.randomUUID();
      const fence: SourceTransferFenceRecord = {
        operationId: input.operationId,
        seriesOperationId: sourceTransferOperationId({
          sourceEnvironmentId: options.sourceEnvironmentId,
          sourceThreadId: input.sourceThreadId,
          deployment: input.deployment,
        }),
        attemptGeneration:
          input.operationId ===
          sourceTransferOperationId({
            sourceEnvironmentId: options.sourceEnvironmentId,
            sourceThreadId: input.sourceThreadId,
            deployment: input.deployment,
          })
            ? 1
            : Number(input.operationId.split(":attempt:").at(-1)),
        sourceThreadId: input.sourceThreadId,
        requestFingerprintSha256,
        leaseOwner,
      };
      const acquired = await options.store.acquire({
        ...fence,
        now: epochMillisToIso(now()),
        leaseExpiresAt: sourceTransferLeaseDeadline(now()),
      });
      switch (acquired.kind) {
        case "completed": {
          const sourceIdentity = await options.store.getSourceIdentity(fence);
          if (!sourceIdentity) {
            throw new WorkspaceMigrationImportError({
              code: "workspace_migration_source_authority_mismatch",
              detail: "The completed transfer is missing its captured source identity.",
            });
          }
          validateTransferReceiptIdentity({
            receipt: acquired.receipt,
            transfer: input,
            sourceEnvironmentId: options.sourceEnvironmentId,
            sourceIdentity,
          });
          return acquired.receipt;
        }
        case "aborted":
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_source_operation_aborted",
            detail: "The destination revoked authority for this transfer operation.",
          });
        case "reconcile-required": {
          try {
            const reconciled = await settleFromAuthority(input, "reconcile").pipe(
              Effect.runPromise,
            );
            if (reconciled) return reconciled;
          } catch (error) {
            if (
              !(error instanceof WorkspaceMigrationImportError) ||
              error.code !== "workspace_migration_source_reconciliation_pending"
            ) {
              throw error;
            }
          }
          const aborted = await settleFromAuthority(input, "abort").pipe(Effect.runPromise);
          if (aborted) return aborted;
          return start(
            new ScaffoldSessionTransferStartInput({
              ...input,
              operationId: fence.seriesOperationId ?? input.operationId,
            }),
          ).pipe(Effect.runPromise);
        }
        case "operation-conflict":
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_source_operation_conflict",
            detail: "The operation id is already bound to a different source transfer request.",
          });
        case "thread-conflict":
        case "in-progress":
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_source_transfer_in_progress",
            detail: "The source thread already has a session transfer in progress.",
          });
        case "source-busy":
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_source_busy",
            detail: "Wait for the source agent turn to finish before transferring it.",
          });
        case "acquired":
          break;
      }

      const heartbeat = Effect.forever(
        Effect.sleep(Duration.millis(SOURCE_TRANSFER_HEARTBEAT_MS)).pipe(
          Effect.flatMap(() => {
            const renewedAt = now();
            return Effect.tryPromise(() =>
              options.store.renew({
                ...fence,
                now: epochMillisToIso(renewedAt),
                leaseExpiresAt: sourceTransferLeaseDeadline(renewedAt),
              }),
            );
          }),
          Effect.flatMap((renewed) =>
            renewed
              ? Effect.void
              : Effect.fail(
                  new WorkspaceMigrationImportError({
                    code: "workspace_migration_source_lease_lost",
                    detail: "The source transfer lost its durable thread lease.",
                  }),
                ),
          ),
        ),
      );

      let completed = false;
      try {
        let boundAuthority: SourceTransferAuthorityIdentity | undefined;
        const receipt = await Effect.raceFirst(
          options.execute(
            input,
            { capturedAt: acquired.capturedAt },
            {
              requestFingerprintSha256,
              bindSourceIdentity: (sourceIdentity) =>
                Effect.tryPromise(() =>
                  options.store.bindSourceIdentity({
                    ...fence,
                    now: epochMillisToIso(now()),
                    sourceIdentity,
                  }),
                ).pipe(
                  Effect.mapError(
                    () =>
                      new WorkspaceMigrationImportError({
                        code: "workspace_migration_source_identity_bind_failed",
                        detail: "The captured source identity could not be durably recorded.",
                      }),
                  ),
                  Effect.flatMap((bound) =>
                    bound
                      ? Effect.void
                      : Effect.fail(
                          new WorkspaceMigrationImportError({
                            code: "workspace_migration_source_identity_bind_failed",
                            detail: "The captured source identity could not be durably recorded.",
                          }),
                        ),
                  ),
                ),
              bind: (authority) =>
                Effect.tryPromise(() =>
                  options.store.bindAuthority({
                    ...fence,
                    now: epochMillisToIso(now()),
                    authority,
                  }),
                ).pipe(
                  Effect.mapError(
                    () =>
                      new WorkspaceMigrationImportError({
                        code: "workspace_migration_source_authority_bind_failed",
                        detail: "Destination authority could not be durably bound before upload.",
                      }),
                  ),
                  Effect.flatMap((bound) => {
                    if (bound)
                      boundAuthority = {
                        ...authority,
                        operationId: input.operationId,
                        requestFingerprintSha256,
                      };
                    return bound
                      ? Effect.void
                      : Effect.fail(
                          new WorkspaceMigrationImportError({
                            code: "workspace_migration_source_authority_bind_failed",
                            detail:
                              "Destination authority could not be durably bound before upload.",
                          }),
                        );
                  }),
                ),
            },
          ),
          heartbeat,
        ).pipe(Effect.runPromise);
        const sourceIdentity = await options.store.getSourceIdentity(fence);
        if (!sourceIdentity || !boundAuthority) {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_source_authority_mismatch",
            detail:
              "The completed transfer is missing its captured source or destination identity.",
          });
        }
        validateTransferReceiptIdentity({
          receipt,
          transfer: input,
          sourceEnvironmentId: options.sourceEnvironmentId,
          sourceIdentity,
          authority: boundAuthority,
        });
        completed = await options.store.complete({
          ...fence,
          now: epochMillisToIso(now()),
          receipt,
        });
        if (!completed) {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_source_lease_lost",
            detail: "The source transfer completed after losing its durable thread lease.",
          });
        }
        return receipt;
      } finally {
        if (!completed) {
          // Fail closed: execute errors may occur after the destination committed
          // but before its receipt reached this process. Keep the operation row,
          // expire only this owner, and require a same-operation reconciliation.
          await options.store.abandon({ ...fence, now: epochMillisToIso(now()) });
        }
      }
    });
    operations.set(input.operationId, { requestFingerprintSha256, promise });
    void promise.catch(() => {
      if (operations.get(input.operationId)?.promise === promise) {
        operations.delete(input.operationId);
      }
    });
    return Effect.tryPromise({
      try: () => promise,
      catch: (error) =>
        error instanceof WorkspaceMigrationImportError
          ? error
          : new WorkspaceMigrationImportError({
              code: "workspace_migration_source_failed",
              detail: "The source transfer operation failed.",
            }),
    });
  };

  function resolvePhysicalInput(
    input: ScaffoldSessionTransferStartInput,
    allocateAfterAbort: boolean,
  ): Effect.Effect<ScaffoldSessionTransferStartInput, WorkspaceMigrationImportError> {
    const seriesOperationId = sourceTransferOperationId({
      sourceEnvironmentId: options.sourceEnvironmentId,
      sourceThreadId: input.sourceThreadId,
      deployment: input.deployment,
    });
    if (input.operationId !== seriesOperationId) {
      return Effect.fail(
        new WorkspaceMigrationImportError({
          code: "workspace_migration_source_operation_id_mismatch",
          detail: "The transfer operation id does not match this source and deployment.",
        }),
      );
    }
    return Effect.tryPromise(() =>
      options.store.resolveAttempt({
        seriesOperationId,
        sourceThreadId: input.sourceThreadId,
        allocateAfterAbort,
      }),
    ).pipe(
      Effect.map(
        (attempt) =>
          new ScaffoldSessionTransferStartInput({
            ...input,
            operationId: attempt.operationId,
          }),
      ),
      Effect.mapError(
        () =>
          new WorkspaceMigrationImportError({
            code: "workspace_migration_source_attempt_resolution_failed",
            detail: "The source transfer attempt could not be resolved.",
          }),
      ),
    );
  }

  const start: ScaffoldSessionTransferSourcePort["start"] = (input) =>
    resolvePhysicalInput(input, true).pipe(Effect.flatMap(startPhysical));

  function settleFromAuthority(
    input: ScaffoldSessionTransferStartInput,
    intent: "reconcile" | "abort",
  ): Effect.Effect<ScaffoldWorkspaceMigrationReceipt | undefined, WorkspaceMigrationImportError> {
    return Effect.tryPromise({
      try: async () => {
        if (!options.authority) {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_source_reconciliation_unavailable",
            detail: "Destination transfer authority is unavailable for reconciliation.",
          });
        }
        const requestFingerprintSha256 = sourceTransferRequestFingerprint(input);
        const resolution = await options.authority[intent]({
          ...input,
          requestFingerprintSha256,
        });
        if (
          resolution.operationId !== input.operationId ||
          resolution.requestFingerprintSha256 !== requestFingerprintSha256
        ) {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_source_authority_mismatch",
            detail: "Destination authority did not match this transfer operation.",
          });
        }
        if (isPrebindNoncommittable(resolution)) {
          if (
            resolution.state !== "noncommittable" ||
            resolution.proof.operationId !== input.operationId ||
            resolution.proof.requestFingerprintSha256 !== requestFingerprintSha256
          ) {
            throw new WorkspaceMigrationImportError({
              code: "workspace_migration_source_authority_mismatch",
              detail: "Pre-bind revocation proof did not match this transfer operation.",
            });
          }
          const aborted = await options.store.abortUnbound({
            operationId: input.operationId,
            sourceThreadId: input.sourceThreadId,
            requestFingerprintSha256,
            now: epochMillisToIso((options.now ?? Date.now)()),
            authorityProofJson: encodeAuthorityProofJson(resolution),
          });
          if (!aborted) {
            throw new WorkspaceMigrationImportError({
              code: "workspace_migration_source_reconciliation_raced",
              detail: "The source transfer changed while applying pre-bind revocation proof.",
            });
          }
          return undefined;
        }
        if (resolution.state === "pending" && !("lifecycleEpoch" in resolution)) {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_source_reconciliation_pending",
            detail: "Destination commit authority is unresolved; the source remains fenced.",
          });
        }
        if (
          !Number.isSafeInteger(resolution.lifecycleEpoch) ||
          resolution.lifecycleEpoch < 1 ||
          resolution.grantId.length === 0 ||
          resolution.sandboxId.length === 0 ||
          resolution.sessionId.length === 0 ||
          !/^[a-f0-9]{64}$/.test(resolution.payloadDigestSha256)
        ) {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_source_authority_mismatch",
            detail: "Destination authority did not match this transfer operation and grant.",
          });
        }
        if (resolution.state === "pending") {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_source_reconciliation_pending",
            detail: "Destination commit authority is still live; the source remains fenced.",
          });
        }
        if (
          resolution.state === "noncommittable" &&
          (resolution.proof.scope !== "bound" ||
            resolution.proof.operationId !== input.operationId ||
            resolution.proof.requestFingerprintSha256 !== requestFingerprintSha256 ||
            resolution.proof.lifecycleEpoch !== resolution.lifecycleEpoch ||
            resolution.proof.grantId !== resolution.grantId ||
            resolution.proof.sandboxId !== resolution.sandboxId ||
            resolution.proof.sessionId !== resolution.sessionId)
        ) {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_source_authority_mismatch",
            detail: "Destination revocation proof did not match the bound transfer grant.",
          });
        }
        const record = {
          operationId: input.operationId,
          sourceThreadId: input.sourceThreadId,
          requestFingerprintSha256,
          now: epochMillisToIso((options.now ?? Date.now)()),
          authorityLifecycleEpoch: resolution.lifecycleEpoch,
          authorityGrantId: resolution.grantId,
          authoritySandboxId: resolution.sandboxId,
          authoritySessionId: resolution.sessionId,
          authorityPayloadDigestSha256: resolution.payloadDigestSha256,
          authorityArchiveSha256: resolution.archiveSha256,
          authorityTranscriptSha256: resolution.transcriptSha256,
          authorityOmpBundleSha256: resolution.ompBundleSha256,
          authorityT3MetadataSha256: resolution.t3MetadataSha256,
          authorityProofJson: encodeAuthorityProofJson(resolution),
        };
        if (resolution.state === "completed") {
          const sourceIdentity = await options.store.getSourceIdentity({
            operationId: input.operationId,
            sourceThreadId: input.sourceThreadId,
            requestFingerprintSha256,
          });
          if (!sourceIdentity) {
            throw new WorkspaceMigrationImportError({
              code: "workspace_migration_source_authority_mismatch",
              detail: "Destination completion proof is missing its captured source identity.",
            });
          }
          validateTransferReceiptIdentity({
            receipt: resolution.receipt,
            transfer: input,
            sourceEnvironmentId: options.sourceEnvironmentId,
            sourceIdentity,
            authority: resolution,
          });
          const settled = await options.store.reconcileCompleted({
            ...record,
            receipt: resolution.receipt,
          });
          if (!settled) {
            throw new WorkspaceMigrationImportError({
              code: "workspace_migration_source_reconciliation_raced",
              detail: "The source transfer changed while applying destination completion proof.",
            });
          }
          return resolution.receipt;
        }
        const aborted = await options.store.abort(record);
        if (!aborted) {
          throw new WorkspaceMigrationImportError({
            code: "workspace_migration_source_reconciliation_raced",
            detail: "The source transfer changed while applying destination revocation proof.",
          });
        }
        return undefined;
      },
      catch: (error) =>
        error instanceof WorkspaceMigrationImportError
          ? error
          : new WorkspaceMigrationImportError({
              code: "workspace_migration_source_reconciliation_failed",
              detail: "Destination transfer authority could not be reconciled.",
            }),
    });
  }

  return {
    start,
    reconcile: (input) =>
      resolvePhysicalInput(input, false).pipe(
        Effect.flatMap((physicalInput) => settleFromAuthority(physicalInput, "reconcile")),
        Effect.flatMap((result) =>
          result
            ? Effect.succeed(result)
            : Effect.fail(
                new WorkspaceMigrationImportError({
                  code: "workspace_migration_source_operation_aborted",
                  detail: "The destination revoked authority for this transfer operation.",
                }),
              ),
        ),
      ),
    abort: (input) =>
      resolvePhysicalInput(input, false).pipe(
        Effect.flatMap((physicalInput) => settleFromAuthority(physicalInput, "abort")),
        Effect.asVoid,
      ),
  };
}

export function makeSqlSourceTransferFenceStore(
  sql: SqlClient.SqlClient,
): SourceTransferReceiptStore {
  return {
    resolveAttempt: (input) =>
      sql<{
        readonly operationId: string;
        readonly sourceThreadId: string;
        readonly generation: number;
        readonly status: "active" | "completed" | "aborted";
      }>`
        SELECT
          operation_id AS "operationId",
          source_thread_id AS "sourceThreadId",
          attempt_generation AS "generation",
          status
        FROM scaffold_session_transfer_fences
        WHERE series_operation_id = ${input.seriesOperationId}
        ORDER BY attempt_generation DESC
        LIMIT 1
      `.pipe(
        Effect.map((rows) => {
          const latest = rows[0];
          if (!latest) {
            return {
              operationId: sourceTransferAttemptOperationId(input.seriesOperationId, 1),
              generation: 1,
            };
          }
          if (latest.sourceThreadId !== input.sourceThreadId) {
            return { operationId: latest.operationId, generation: latest.generation };
          }
          if (latest.status === "aborted" && input.allocateAfterAbort) {
            const generation = latest.generation + 1;
            return {
              operationId: sourceTransferAttemptOperationId(input.seriesOperationId, generation),
              generation,
            };
          }
          return { operationId: latest.operationId, generation: latest.generation };
        }),
        Effect.runPromise,
      ),
    acquire: (record) =>
      sql
        .withTransaction(
          Effect.gen(function* (): Effect.fn.Return<
            SourceTransferFenceAcquireResult<ScaffoldWorkspaceMigrationReceipt>,
            SqlError
          > {
            const existingOperation = yield* sql<{
              readonly sourceThreadId: string;
              readonly requestFingerprintSha256: string;
              readonly status: "active" | "completed" | "aborted";
              readonly capturedAt: string;
              readonly leaseExpiresAt: string | null;
              readonly receiptJson: string | null;
            }>`
              SELECT
                source_thread_id AS "sourceThreadId",
                request_fingerprint_sha256 AS "requestFingerprintSha256",
                status,
                captured_at AS "capturedAt",
                lease_expires_at AS "leaseExpiresAt",
                receipt_json AS "receiptJson"
              FROM scaffold_session_transfer_fences
              WHERE operation_id = ${record.operationId}
              LIMIT 1
            `;
            const existing = existingOperation[0];
            if (existing) {
              if (
                existing.sourceThreadId !== record.sourceThreadId ||
                existing.requestFingerprintSha256 !== record.requestFingerprintSha256
              ) {
                return { kind: "operation-conflict" };
              }
              if (existing.status === "completed" && existing.receiptJson !== null) {
                return {
                  kind: "completed",
                  receipt: decodeSourceTransferReceiptRecordJson(existing.receiptJson).receipt,
                };
              }
              if (existing.status === "aborted") return { kind: "aborted" };
              if (existing.leaseExpiresAt !== null && existing.leaseExpiresAt <= record.now) {
                return { kind: "reconcile-required" };
              }
              return { kind: "in-progress" };
            }

            const activeThreadFence = yield* sql`
              SELECT operation_id
              FROM scaffold_session_transfer_fences
              WHERE source_thread_id = ${record.sourceThreadId} AND status = 'active'
              LIMIT 1
            `;
            if (activeThreadFence.length > 0) return { kind: "thread-conflict" };

            const sourceWork = yield* sql`
              SELECT 1
              FROM projection_turns
              WHERE thread_id = ${record.sourceThreadId}
                AND state IN ('pending', 'running')
              UNION ALL
              SELECT 1
              FROM projection_thread_sessions
              WHERE thread_id = ${record.sourceThreadId}
                AND (status IN ('starting', 'running') OR active_turn_id IS NOT NULL)
              LIMIT 1
            `;
            if (sourceWork.length > 0) return { kind: "source-busy" };

            const inserted = yield* sql<{ readonly operationId: string }>`
              INSERT OR IGNORE INTO scaffold_session_transfer_fences (
                operation_id,
                series_operation_id,
                attempt_generation,
                source_thread_id,
                source_project_id,
                source_omp_session_id,
                request_fingerprint_sha256,
                captured_at,
                status,
                lease_owner,
                lease_expires_at,
                receipt_json,
                authority_lifecycle_epoch,
                authority_grant_id,
                authority_sandbox_id,
                authority_session_id,
                authority_payload_digest_sha256,
                authority_archive_sha256,
                authority_transcript_sha256,
                authority_omp_bundle_sha256,
                authority_t3_metadata_sha256,
                authority_proof_json,
                created_at,
                updated_at
              ) VALUES (
                ${record.operationId},
                ${record.seriesOperationId ?? record.operationId},
                ${record.attemptGeneration ?? 1},
                ${record.sourceThreadId},
                NULL,
                NULL,
                ${record.requestFingerprintSha256},
                ${record.now},
                'active',
                ${record.leaseOwner},
                ${record.leaseExpiresAt},
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                ${record.now},
                ${record.now}
              )
              RETURNING operation_id AS "operationId"
            `;
            if (inserted.length === 0) return { kind: "in-progress" };
            return { kind: "acquired", capturedAt: record.now };
          }),
        )
        .pipe(Effect.runPromise),
    renew: (record) =>
      sql<{ readonly operationId: string }>`
        UPDATE scaffold_session_transfer_fences
        SET lease_expires_at = ${record.leaseExpiresAt}, updated_at = ${record.now}
        WHERE operation_id = ${record.operationId}
          AND source_thread_id = ${record.sourceThreadId}
          AND request_fingerprint_sha256 = ${record.requestFingerprintSha256}
          AND status = 'active'
          AND lease_owner = ${record.leaseOwner}
          AND lease_expires_at > ${record.now}
        RETURNING operation_id AS "operationId"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.runPromise,
      ),
    bindSourceIdentity: (record) =>
      sql<{ readonly operationId: string }>`
        UPDATE scaffold_session_transfer_fences
        SET
          source_project_id = ${record.sourceIdentity.sourceProjectId},
          source_omp_session_id = ${record.sourceIdentity.sourceOmpSessionId},
          updated_at = ${record.now}
        WHERE operation_id = ${record.operationId}
          AND source_thread_id = ${record.sourceThreadId}
          AND request_fingerprint_sha256 = ${record.requestFingerprintSha256}
          AND status = 'active'
          AND lease_owner = ${record.leaseOwner}
          AND lease_expires_at > ${record.now}
          AND (
            (source_project_id IS NULL AND source_omp_session_id IS NULL)
            OR (
              source_project_id = ${record.sourceIdentity.sourceProjectId}
              AND source_omp_session_id = ${record.sourceIdentity.sourceOmpSessionId}
            )
          )
        RETURNING operation_id AS "operationId"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.runPromise,
      ),
    getSourceIdentity: (record) =>
      sql<{
        readonly sourceProjectId: string | null;
        readonly sourceOmpSessionId: string | null;
      }>`
        SELECT
          source_project_id AS "sourceProjectId",
          source_omp_session_id AS "sourceOmpSessionId"
        FROM scaffold_session_transfer_fences
        WHERE operation_id = ${record.operationId}
          AND source_thread_id = ${record.sourceThreadId}
          AND request_fingerprint_sha256 = ${record.requestFingerprintSha256}
        LIMIT 1
      `.pipe(
        Effect.map((rows) => {
          const identity = rows[0];
          return identity?.sourceProjectId && identity.sourceOmpSessionId
            ? {
                sourceProjectId: identity.sourceProjectId,
                sourceOmpSessionId: identity.sourceOmpSessionId,
              }
            : undefined;
        }),
        Effect.runPromise,
      ),
    bindAuthority: (record) =>
      sql<{ readonly operationId: string }>`
        UPDATE scaffold_session_transfer_fences
        SET
          authority_lifecycle_epoch = ${record.authority.lifecycleEpoch},
          authority_grant_id = ${record.authority.grantId},
          authority_sandbox_id = ${record.authority.sandboxId},
          authority_session_id = ${record.authority.sessionId},
          authority_payload_digest_sha256 = ${record.authority.payloadDigestSha256},
          authority_archive_sha256 = ${record.authority.archiveSha256},
          authority_transcript_sha256 = ${record.authority.transcriptSha256},
          authority_omp_bundle_sha256 = ${record.authority.ompBundleSha256},
          authority_t3_metadata_sha256 = ${record.authority.t3MetadataSha256},
          updated_at = ${record.now}
        WHERE operation_id = ${record.operationId}
          AND source_thread_id = ${record.sourceThreadId}
          AND request_fingerprint_sha256 = ${record.requestFingerprintSha256}
          AND status = 'active'
          AND lease_owner = ${record.leaseOwner}
          AND lease_expires_at > ${record.now}
          AND (
            authority_grant_id IS NULL
            OR (
              authority_lifecycle_epoch = ${record.authority.lifecycleEpoch}
              AND authority_grant_id = ${record.authority.grantId}
              AND authority_sandbox_id = ${record.authority.sandboxId}
              AND authority_session_id = ${record.authority.sessionId}
              AND authority_payload_digest_sha256 = ${record.authority.payloadDigestSha256}
              AND authority_archive_sha256 = ${record.authority.archiveSha256}
              AND authority_transcript_sha256 = ${record.authority.transcriptSha256}
              AND authority_omp_bundle_sha256 = ${record.authority.ompBundleSha256}
              AND authority_t3_metadata_sha256 = ${record.authority.t3MetadataSha256}
            )
          )
        RETURNING operation_id AS "operationId"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.runPromise,
      ),
    complete: (record) => {
      const encodedReceipt = encodeSourceTransferReceiptRecordJson({
        version: "scaffold.session_transfer.source_receipt.v1",
        operationId: record.operationId,
        requestFingerprintSha256: record.requestFingerprintSha256,
        receipt: record.receipt,
      });
      return sql<{ readonly operationId: string }>`
        UPDATE scaffold_session_transfer_fences
        SET
          status = 'completed',
          lease_owner = NULL,
          lease_expires_at = NULL,
          receipt_json = ${encodedReceipt},
          authority_proof_json = ${encodedReceipt},
          updated_at = ${record.now}
        WHERE operation_id = ${record.operationId}
          AND source_thread_id = ${record.sourceThreadId}
          AND request_fingerprint_sha256 = ${record.requestFingerprintSha256}
          AND status = 'active'
          AND source_project_id = ${record.receipt.source.projectId}
          AND source_omp_session_id = ${record.receipt.source.ompSessionId}
          AND (
            authority_lifecycle_epoch = ${record.receipt.binding.lifecycleEpoch}
            AND authority_session_id = ${record.receipt.sessionId}
            AND authority_payload_digest_sha256 = ${record.receipt.payloadDigestSha256}
            AND authority_archive_sha256 = ${record.receipt.archiveSha256}
            AND authority_transcript_sha256 = ${record.receipt.transcriptSha256}
            AND authority_omp_bundle_sha256 = ${record.receipt.ompBundleSha256}
            AND authority_t3_metadata_sha256 = ${record.receipt.t3MetadataSha256}
          )
          AND lease_owner = ${record.leaseOwner}
          AND lease_expires_at > ${record.now}
        RETURNING operation_id AS "operationId"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.runPromise,
      );
    },
    reconcileCompleted: (record) => {
      const encodedReceipt = encodeSourceTransferReceiptRecordJson({
        version: "scaffold.session_transfer.source_receipt.v1",
        operationId: record.operationId,
        requestFingerprintSha256: record.requestFingerprintSha256,
        receipt: record.receipt,
      });
      return sql<{ readonly operationId: string }>`
        UPDATE scaffold_session_transfer_fences
        SET
          status = 'completed',
          lease_owner = NULL,
          lease_expires_at = NULL,
          receipt_json = ${encodedReceipt},
          authority_lifecycle_epoch = ${record.authorityLifecycleEpoch},
          authority_grant_id = ${record.authorityGrantId},
          authority_sandbox_id = ${record.authoritySandboxId},
          authority_session_id = ${record.authoritySessionId},
          authority_payload_digest_sha256 = ${record.authorityPayloadDigestSha256},
          authority_archive_sha256 = ${record.authorityArchiveSha256},
          authority_transcript_sha256 = ${record.authorityTranscriptSha256},
          authority_omp_bundle_sha256 = ${record.authorityOmpBundleSha256},
          authority_t3_metadata_sha256 = ${record.authorityT3MetadataSha256},
          authority_proof_json = ${record.authorityProofJson},
          updated_at = ${record.now}
        WHERE operation_id = ${record.operationId}
          AND source_thread_id = ${record.sourceThreadId}
          AND request_fingerprint_sha256 = ${record.requestFingerprintSha256}
          AND source_project_id = ${record.receipt.source.projectId}
          AND source_omp_session_id = ${record.receipt.source.ompSessionId}
          AND (
            (
              status = 'active'
              AND (
                authority_grant_id IS NULL
                OR (
                  authority_lifecycle_epoch = ${record.authorityLifecycleEpoch}
                  AND authority_grant_id = ${record.authorityGrantId}
                  AND authority_sandbox_id = ${record.authoritySandboxId}
                  AND authority_session_id = ${record.authoritySessionId}
                  AND authority_payload_digest_sha256 = ${record.authorityPayloadDigestSha256}
                  AND authority_archive_sha256 = ${record.authorityArchiveSha256}
                  AND authority_transcript_sha256 = ${record.authorityTranscriptSha256}
                  AND authority_omp_bundle_sha256 = ${record.authorityOmpBundleSha256}
                  AND authority_t3_metadata_sha256 = ${record.authorityT3MetadataSha256}
                )
              )
            )
            OR (
              status = 'completed'
              AND receipt_json = ${encodedReceipt}
              AND authority_lifecycle_epoch = ${record.authorityLifecycleEpoch}
              AND authority_grant_id = ${record.authorityGrantId}
              AND authority_sandbox_id = ${record.authoritySandboxId}
              AND authority_session_id = ${record.authoritySessionId}
              AND authority_payload_digest_sha256 = ${record.authorityPayloadDigestSha256}
              AND authority_archive_sha256 = ${record.authorityArchiveSha256}
              AND authority_transcript_sha256 = ${record.authorityTranscriptSha256}
              AND authority_omp_bundle_sha256 = ${record.authorityOmpBundleSha256}
              AND authority_t3_metadata_sha256 = ${record.authorityT3MetadataSha256}
              AND authority_proof_json = ${record.authorityProofJson}
            )
          )
        RETURNING operation_id AS "operationId"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.runPromise,
      );
    },
    abort: (record) =>
      sql<{ readonly operationId: string }>`
        UPDATE scaffold_session_transfer_fences
        SET
          status = 'aborted',
          lease_owner = NULL,
          lease_expires_at = NULL,
          authority_lifecycle_epoch = ${record.authorityLifecycleEpoch},
          authority_grant_id = ${record.authorityGrantId},
          authority_sandbox_id = ${record.authoritySandboxId},
          authority_session_id = ${record.authoritySessionId},
          authority_payload_digest_sha256 = ${record.authorityPayloadDigestSha256},
          authority_archive_sha256 = ${record.authorityArchiveSha256},
          authority_transcript_sha256 = ${record.authorityTranscriptSha256},
          authority_omp_bundle_sha256 = ${record.authorityOmpBundleSha256},
          authority_t3_metadata_sha256 = ${record.authorityT3MetadataSha256},
          authority_proof_json = ${record.authorityProofJson},
          updated_at = ${record.now}
        WHERE operation_id = ${record.operationId}
          AND source_thread_id = ${record.sourceThreadId}
          AND request_fingerprint_sha256 = ${record.requestFingerprintSha256}
          AND (
            (
              status = 'active'
              AND (
                authority_grant_id IS NULL
                OR (
                  authority_lifecycle_epoch = ${record.authorityLifecycleEpoch}
                  AND authority_grant_id = ${record.authorityGrantId}
                  AND authority_sandbox_id = ${record.authoritySandboxId}
                  AND authority_session_id = ${record.authoritySessionId}
                  AND authority_payload_digest_sha256 = ${record.authorityPayloadDigestSha256}
                  AND authority_archive_sha256 = ${record.authorityArchiveSha256}
                  AND authority_transcript_sha256 = ${record.authorityTranscriptSha256}
                  AND authority_omp_bundle_sha256 = ${record.authorityOmpBundleSha256}
                  AND authority_t3_metadata_sha256 = ${record.authorityT3MetadataSha256}
                )
              )
            )
            OR (
              status = 'aborted'
              AND authority_lifecycle_epoch = ${record.authorityLifecycleEpoch}
              AND authority_grant_id = ${record.authorityGrantId}
              AND authority_sandbox_id = ${record.authoritySandboxId}
              AND authority_session_id = ${record.authoritySessionId}
              AND authority_payload_digest_sha256 = ${record.authorityPayloadDigestSha256}
              AND authority_archive_sha256 = ${record.authorityArchiveSha256}
              AND authority_transcript_sha256 = ${record.authorityTranscriptSha256}
              AND authority_omp_bundle_sha256 = ${record.authorityOmpBundleSha256}
              AND authority_t3_metadata_sha256 = ${record.authorityT3MetadataSha256}
              AND authority_proof_json = ${record.authorityProofJson}
            )
          )
        RETURNING operation_id AS "operationId"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.runPromise,
      ),
    abortUnbound: (record) =>
      sql<{ readonly operationId: string }>`
        UPDATE scaffold_session_transfer_fences
        SET
          status = 'aborted',
          lease_owner = NULL,
          lease_expires_at = NULL,
          authority_proof_json = ${record.authorityProofJson},
          updated_at = ${record.now}
        WHERE operation_id = ${record.operationId}
          AND source_thread_id = ${record.sourceThreadId}
          AND request_fingerprint_sha256 = ${record.requestFingerprintSha256}
          AND authority_grant_id IS NULL
          AND (
            status = 'active'
            OR (status = 'aborted' AND authority_proof_json = ${record.authorityProofJson})
          )
        RETURNING operation_id AS "operationId"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.runPromise,
      ),
    abandon: (record) =>
      sql`
        UPDATE scaffold_session_transfer_fences
        SET lease_expires_at = ${record.now}, updated_at = ${record.now}
        WHERE operation_id = ${record.operationId}
          AND source_thread_id = ${record.sourceThreadId}
          AND request_fingerprint_sha256 = ${record.requestFingerprintSha256}
          AND status = 'active'
          AND lease_owner = ${record.leaseOwner}
      `.pipe(Effect.asVoid, Effect.runPromise),
  };
}

export function makeSourceSessionRestorePlan(input: {
  readonly threadId: ThreadId;
  readonly rootPath: string;
  readonly modelSelection: ModelSelection;
  readonly resumeCursor: unknown;
  readonly runtimeMode: RuntimeMode;
}): { readonly threadId: ThreadId; readonly startInput: ProviderSessionStartInput } {
  return {
    threadId: input.threadId,
    startInput: {
      threadId: input.threadId,
      provider: ProviderDriverKind.make("omp"),
      providerInstanceId: input.modelSelection.instanceId,
      cwd: input.rootPath,
      modelSelection: input.modelSelection,
      resumeCursor: input.resumeCursor,
      runtimeMode: input.runtimeMode,
    },
  };
}

export function captureThenMigrateWithSourceRestore<A, B, E1, E2, E3, E4>(options: {
  readonly stop: Effect.Effect<void, E1>;
  readonly capture: Effect.Effect<A, E2>;
  readonly restart: Effect.Effect<void, E3>;
  readonly migrate: (captured: A) => Effect.Effect<B, E4>;
}): Effect.Effect<B, E1 | E2 | E3 | E4> {
  return Effect.acquireUseRelease(
    options.stop,
    () => options.capture,
    () => options.restart,
  ).pipe(Effect.flatMap(options.migrate));
}

/**
 * Captures an idle local OMP session and its worktree without transplanting T3
 * projection state. Source stop/export/restart is bracketed, so failure leaves
 * the original thread available for rollback.
 */
export const makeLiveScaffoldSessionTransferSource = Effect.fn(
  "makeLiveScaffoldSessionTransferSource",
)(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory;
  const provider = yield* ProviderService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const sourceEnvironmentId = yield* environment.getEnvironmentId;
  const cli = yield* makeLiveScaffoldWorkspaceMigrationCli();
  // A transfer briefly closes the source OMP session for a cold export. A
  // process-wide fence is intentionally stronger than a per-thread fence and
  // prevents any two export/restart sequences from interleaving.
  const transferFence = yield* Semaphore.make(1);

  const capture = (
    input: ScaffoldSessionTransferStartInput,
    durableCapture: { readonly capturedAt: string },
    authorityJournal: {
      readonly requestFingerprintSha256: string;
      readonly bindSourceIdentity: (
        sourceIdentity: SourceTransferSourceIdentity,
      ) => Effect.Effect<void, WorkspaceMigrationImportError>;
      readonly bind: (
        authority: SourceTransferAuthorityBinding,
      ) => Effect.Effect<void, WorkspaceMigrationImportError>;
    },
  ) =>
    transferFence
      .withPermits(1)(
        Effect.gen(function* () {
          const [snapshot, threadDetailOption, bindingOption, environmentId, settings] =
            yield* Effect.all([
              snapshots.getSnapshot(),
              snapshots.getThreadDetailSnapshot(input.sourceThreadId),
              directory.getBinding(input.sourceThreadId),
              Effect.succeed(sourceEnvironmentId),
              settingsService.getSettings,
            ]).pipe(
              Effect.mapError(
                () =>
                  new WorkspaceMigrationImportError({
                    code: "workspace_migration_source_unavailable",
                    detail: "The local source session could not be read.",
                  }),
              ),
            );
          const thread = Option.getOrUndefined(threadDetailOption)?.thread;
          const project = thread
            ? snapshot.projects.find((candidate) => candidate.id === thread.projectId)
            : undefined;
          const binding = Option.getOrUndefined(bindingOption);
          const resume = binding ? parseOmpResume(binding.resumeCursor) : undefined;
          if (
            !thread ||
            !project ||
            !binding ||
            binding.provider !== ProviderDriverKind.make("omp") ||
            !resume
          ) {
            return yield* new WorkspaceMigrationImportError({
              code: "workspace_migration_source_not_omp",
              detail: "The source must be an existing OMP-backed T3 thread.",
            });
          }
          if (thread.latestTurn?.state === "running" || resume.activeTurnId !== undefined) {
            return yield* new WorkspaceMigrationImportError({
              code: "workspace_migration_source_busy",
              detail: "Wait for the source agent turn to finish before transferring it.",
            });
          }

          const rootPath = thread.worktreePath ?? project.workspaceRoot;
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
                prefix: "t3-scaffold-transfer-",
              });
              const ompBundlePath = path.join(temporaryDirectory, "omp-session.zip");
              const t3MetadataPath = path.join(temporaryDirectory, "t3-metadata.json");
              const authorityProposalPath = path.join(
                temporaryDirectory,
                "authority-proposal.json",
              );
              const authorityAcknowledgementPath = path.join(
                temporaryDirectory,
                "authority-acknowledgement.json",
              );
              const ompTransfer = yield* makeOmpSessionTransferRuntime({
                cwd: rootPath,
                ompSettings: settings.providers.omp,
              }).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                Effect.provideService(Crypto.Crypto, crypto),
              );
              let restorePlan = makeSourceSessionRestorePlan({
                threadId: thread.id,
                rootPath,
                modelSelection: thread.modelSelection,
                resumeCursor: binding.resumeCursor,
                runtimeMode: thread.runtimeMode,
              });

              return yield* captureThenMigrateWithSourceRestore({
                stop: provider.stopSession({ threadId: restorePlan.threadId }),
                capture: Effect.gen(function* () {
                  const [stoppedDetailOption, stoppedBindingOption] = yield* Effect.all([
                    snapshots.getThreadDetailSnapshot(thread.id),
                    directory.getBinding(thread.id),
                  ]);
                  const stoppedThread = Option.getOrUndefined(stoppedDetailOption)?.thread;
                  const stoppedBinding = Option.getOrUndefined(stoppedBindingOption);
                  const stoppedResume = stoppedBinding
                    ? parseOmpResume(stoppedBinding.resumeCursor)
                    : undefined;
                  if (
                    !stoppedThread ||
                    stoppedThread.projectId !== project.id ||
                    stoppedThread.modelSelection.instanceId !== thread.modelSelection.instanceId ||
                    stoppedThread.modelSelection.model !== thread.modelSelection.model ||
                    stoppedThread.runtimeMode !== thread.runtimeMode ||
                    !stoppedBinding ||
                    stoppedBinding.provider !== ProviderDriverKind.make("omp") ||
                    !stoppedResume ||
                    stoppedResume.sessionId !== resume.sessionId ||
                    stoppedResume.activeTurnId !== undefined
                  ) {
                    return yield* new WorkspaceMigrationImportError({
                      code: "workspace_migration_source_changed_during_stop",
                      detail: "The source session changed while establishing its export boundary.",
                    });
                  }
                  restorePlan = makeSourceSessionRestorePlan({
                    threadId: stoppedThread.id,
                    rootPath,
                    modelSelection: stoppedThread.modelSelection,
                    resumeCursor: stoppedBinding.resumeCursor,
                    runtimeMode: stoppedThread.runtimeMode,
                  });
                  const source = new SessionTransferSource({
                    environmentId,
                    projectId: project.id,
                    threadId: stoppedThread.id,
                    rootPath,
                    title: stoppedThread.title,
                    modelSelection: stoppedThread.modelSelection,
                    runtimeMode: stoppedThread.runtimeMode,
                    interactionMode: stoppedThread.interactionMode,
                    continuation: {
                      provider: "omp",
                      sessionId: stoppedResume.sessionId,
                      eventSequence: stoppedResume.eventSequence,
                      acpSequence: stoppedResume.acpSequence,
                    },
                    capturedAt: durableCapture.capturedAt,
                    transcriptSha256: canonicalTranscriptSha256(stoppedThread),
                  });
                  yield* authorityJournal.bindSourceIdentity({
                    sourceProjectId: source.projectId,
                    sourceOmpSessionId: source.continuation.sessionId,
                  });
                  yield* fileSystem.writeFileString(
                    t3MetadataPath,
                    yield* encodeSessionTransferSource(source),
                  );
                  const exported = yield* ompTransfer.exportSession({
                    sessionId: stoppedResume.sessionId,
                    archivePath: ompBundlePath,
                  });
                  return { exported, source };
                }),
                restart: Effect.suspend(() =>
                  provider
                    .startSession(restorePlan.threadId, restorePlan.startInput)
                    .pipe(Effect.asVoid),
                ),
                migrate: ({ exported, source }) =>
                  Effect.gen(function* () {
                    if (
                      exported.sessionId !== source.continuation.sessionId ||
                      exported.archivePath !== ompBundlePath
                    ) {
                      return yield* new WorkspaceMigrationImportError({
                        code: "workspace_migration_omp_export_mismatch",
                        detail: "OMP exported a different logical session or archive path.",
                      });
                    }
                    const archiveChecksum = NodeCrypto.createHash("sha256")
                      .update(yield* fileSystem.readFile(ompBundlePath))
                      .digest("hex");
                    if (exported.sourceChecksum !== archiveChecksum) {
                      return yield* new WorkspaceMigrationImportError({
                        code: "workspace_migration_omp_export_checksum_mismatch",
                        detail: "OMP export checksum does not match the portable session bundle.",
                      });
                    }
                    const t3MetadataChecksum = NodeCrypto.createHash("sha256")
                      .update(yield* fileSystem.readFile(t3MetadataPath))
                      .digest("hex");
                    const effort = selectedEffort(source);
                    const command = new ScaffoldWorkspaceMigrationCommand({
                      version: "scaffold.workspace_migration.command.v1",
                      operationId: input.operationId,
                      requestFingerprintSha256: authorityJournal.requestFingerprintSha256,
                      cwd: rootPath,
                      source: {
                        environmentId: source.environmentId,
                        projectId: source.projectId,
                        threadId: source.threadId,
                        globalSessionId: `sf:${source.environmentId}:${source.threadId}`,
                        ompSessionId: source.continuation.sessionId,
                        model: source.modelSelection.model,
                        ...(effort ? { effort } : {}),
                        capturedAt: source.capturedAt,
                        transcriptSha256: source.transcriptSha256,
                      },
                      ompBundlePath,
                      ompExport: {
                        version: exported.version,
                        sessionId: exported.sessionId,
                        sourceChecksum: exported.sourceChecksum,
                        files: exported.files,
                      },
                      t3MetadataPath,
                      t3MetadataSha256: t3MetadataChecksum,
                      credentialExclusions: [
                        ...SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
                      ],
                      unsupportedFilesystemCases: [
                        ...SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
                      ],
                      authorityHandshake: {
                        proposalPath: authorityProposalPath,
                        acknowledgementPath: authorityAcknowledgementPath,
                      },
                    });
                    return yield* Effect.tryPromise(() =>
                      cli.migrate(command, (authority) =>
                        authorityJournal
                          .bind({
                            lifecycleEpoch: authority.lifecycleEpoch,
                            grantId: authority.grantId,
                            sandboxId: authority.sandboxId,
                            sessionId: authority.sessionId,
                            payloadDigestSha256: authority.payloadDigestSha256,
                            archiveSha256: authority.archiveSha256,
                            transcriptSha256: authority.transcriptSha256,
                            ompBundleSha256: authority.ompBundleSha256,
                            t3MetadataSha256: authority.t3MetadataSha256,
                          })
                          .pipe(Effect.runPromise),
                      ),
                    ).pipe(
                      Effect.mapError(
                        () =>
                          new WorkspaceMigrationImportError({
                            code: "workspace_migration_transport_failed",
                            detail: "The Scaffold workspace migration command failed.",
                          }),
                      ),
                    );
                  }),
              });
            }),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof WorkspaceMigrationImportError
            ? error
            : new WorkspaceMigrationImportError({
                code: "workspace_migration_source_failed",
                detail: "The local session could not be captured and restored safely.",
              }),
        ),
      );

  return makeIdempotentScaffoldSessionTransferSource({
    sourceEnvironmentId,
    execute: capture,
    store: makeSqlSourceTransferFenceStore(sql),
    authority: {
      reconcile: async ({ operationId, requestFingerprintSha256 }) =>
        decodeSourceTransferAuthorityResolution(
          await cli.reconcile({ operationId, requestFingerprintSha256 }),
          { operationId, requestFingerprintSha256 },
        ),
      abort: async ({ operationId, requestFingerprintSha256 }) =>
        decodeSourceTransferAuthorityResolution(
          await cli.abort({ operationId, requestFingerprintSha256 }),
          { operationId, requestFingerprintSha256 },
        ),
    },
  });
});
