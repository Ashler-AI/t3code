import type { OrchestrationCommand, OrchestrationEventMetadata } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";

export const SOURCE_TRANSFER_LEASE_MS = 2 * 60 * 1000;
export const SOURCE_TRANSFER_HEARTBEAT_MS = 30 * 1000;

/**
 * Every client-dispatchable thread command is fenced. Internal projection
 * commands remain admissible so the transfer's direct ProviderService
 * stop/restart can publish its own session state without deadlocking.
 */
export const SOURCE_TRANSFER_BLOCKED_COMMAND_TYPES = [
  "project.meta.update",
  "project.delete",
  "thread.create",
  "thread.delete",
  "thread.archive",
  "thread.unarchive",
  "thread.settle",
  "thread.unsettle",
  "thread.snooze",
  "thread.unsnooze",
  "thread.meta.update",
  "thread.runtime-mode.set",
  "thread.interaction-mode.set",
  "thread.turn.start",
  "thread.turn.interrupt",
  "thread.approval.respond",
  "thread.user-input.respond",
  "thread.checkpoint.revert",
  "thread.session.stop",
] as const satisfies ReadonlyArray<OrchestrationCommand["type"]>;

export type SourceMutationCommand = Extract<
  OrchestrationCommand,
  { readonly type: (typeof SOURCE_TRANSFER_BLOCKED_COMMAND_TYPES)[number] }
>;

const sourceTransferBlockedCommandTypes = new Set<string>(SOURCE_TRANSFER_BLOCKED_COMMAND_TYPES);

export function isSourceMutationCommand(
  command: OrchestrationCommand,
): command is SourceMutationCommand {
  return sourceTransferBlockedCommandTypes.has(command.type);
}

function isCanonicalProviderMetadataUpdate(
  command: SourceMutationCommand,
  metadata: OrchestrationEventMetadata | undefined,
): boolean {
  return (
    command.type === "thread.meta.update" &&
    metadata?.providerEventId !== undefined &&
    metadata.providerEnvironmentId !== undefined &&
    metadata.providerThreadId === command.threadId &&
    metadata.providerSourceSequence !== undefined &&
    metadata.providerInstanceId !== undefined
  );
}

/** Must run in the same SQL transaction that commits the command's events. */
export const rejectSourceMutationWhileTransferIsActive = Effect.fn(
  "rejectSourceMutationWhileTransferIsActive",
)(function* (
  sql: SqlClient.SqlClient,
  command: SourceMutationCommand,
  metadata?: OrchestrationEventMetadata,
) {
  if (isCanonicalProviderMetadataUpdate(command, metadata)) {
    return;
  }
  const active =
    command.type === "project.meta.update" || command.type === "project.delete"
      ? yield* sql<{ readonly operationId: string }>`
          SELECT fences.operation_id AS "operationId"
          FROM scaffold_session_transfer_fences AS fences
          INNER JOIN projection_threads AS threads
            ON threads.thread_id = fences.source_thread_id
          WHERE threads.project_id = ${command.projectId}
            AND fences.status = 'active'
          LIMIT 1
        `
      : yield* sql<{ readonly operationId: string }>`
          SELECT operation_id AS "operationId"
          FROM scaffold_session_transfer_fences
          WHERE source_thread_id = ${command.threadId}
            AND status = 'active'
          LIMIT 1
        `;
  if (active.length > 0) {
    const aggregateId = "threadId" in command ? command.threadId : command.projectId;
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Source authority for '${aggregateId}' is temporarily fenced for a session transfer.`,
    });
  }
});

export interface SourceTransferFenceRecord {
  readonly operationId: string;
  readonly seriesOperationId?: string;
  readonly attemptGeneration?: number;
  readonly sourceThreadId: string;
  readonly requestFingerprintSha256: string;
  readonly leaseOwner: string;
}

export interface SourceTransferAuthorityBinding {
  readonly lifecycleEpoch: number;
  readonly grantId: string;
  readonly sandboxId: string;
  readonly sessionId: string;
  readonly payloadDigestSha256: string;
  readonly archiveSha256: string;
  readonly transcriptSha256: string;
  readonly ompBundleSha256: string;
  readonly t3MetadataSha256: string;
}

export interface SourceTransferSourceIdentity {
  readonly sourceProjectId: string;
  readonly sourceOmpSessionId: string;
}

export type SourceTransferFenceAcquireResult<Receipt> =
  | { readonly kind: "acquired"; readonly capturedAt: string }
  | { readonly kind: "completed"; readonly receipt: Receipt }
  | { readonly kind: "aborted" }
  | { readonly kind: "reconcile-required" }
  | { readonly kind: "operation-conflict" }
  | { readonly kind: "thread-conflict" }
  | { readonly kind: "in-progress" }
  | { readonly kind: "source-busy" };

export interface SourceTransferFenceStore<Receipt> {
  readonly resolveAttempt: (input: {
    readonly seriesOperationId: string;
    readonly sourceThreadId: string;
    readonly allocateAfterAbort: boolean;
  }) => Promise<{ readonly operationId: string; readonly generation: number }>;
  readonly acquire: (
    record: SourceTransferFenceRecord & {
      readonly now: string;
      readonly leaseExpiresAt: string;
    },
  ) => Promise<SourceTransferFenceAcquireResult<Receipt>>;
  readonly renew: (
    record: SourceTransferFenceRecord & {
      readonly now: string;
      readonly leaseExpiresAt: string;
    },
  ) => Promise<boolean>;
  /** Persists the captured source identity before any destination upload begins. */
  readonly bindSourceIdentity: (
    record: SourceTransferFenceRecord & {
      readonly now: string;
      readonly sourceIdentity: SourceTransferSourceIdentity;
    },
  ) => Promise<boolean>;
  /** Reads the immutable captured identity used to validate direct or recovered receipts. */
  readonly getSourceIdentity: (
    record: Pick<
      SourceTransferFenceRecord,
      "operationId" | "sourceThreadId" | "requestFingerprintSha256"
    >,
  ) => Promise<SourceTransferSourceIdentity | undefined>;
  /** Persists the immutable destination authority before remote upload begins. */
  readonly bindAuthority: (
    record: SourceTransferFenceRecord & {
      readonly now: string;
      readonly authority: SourceTransferAuthorityBinding;
    },
  ) => Promise<boolean>;
  readonly complete: (
    record: SourceTransferFenceRecord & { readonly now: string; readonly receipt: Receipt },
  ) => Promise<boolean>;
  /** Settles an ambiguous operation from destination-issued completion proof. */
  readonly reconcileCompleted: (
    record: Omit<SourceTransferFenceRecord, "leaseOwner"> & {
      readonly now: string;
      readonly receipt: Receipt;
      readonly authorityLifecycleEpoch: number;
      readonly authorityGrantId: string;
      readonly authoritySandboxId: string;
      readonly authoritySessionId: string;
      readonly authorityPayloadDigestSha256: string;
      readonly authorityArchiveSha256: string;
      readonly authorityTranscriptSha256: string;
      readonly authorityOmpBundleSha256: string;
      readonly authorityT3MetadataSha256: string;
      readonly authorityProofJson: string;
    },
  ) => Promise<boolean>;
  /**
   * Releases source authority only after the destination has durably revoked
   * this exact operation. This transition must atomically invalidate any
   * outstanding source lease so a stale worker cannot complete afterward.
   */
  readonly abort: (
    record: Omit<SourceTransferFenceRecord, "leaseOwner"> & {
      readonly now: string;
      readonly authorityLifecycleEpoch: number;
      readonly authorityGrantId: string;
      readonly authoritySandboxId: string;
      readonly authoritySessionId: string;
      readonly authorityPayloadDigestSha256: string;
      readonly authorityArchiveSha256: string;
      readonly authorityTranscriptSha256: string;
      readonly authorityOmpBundleSha256: string;
      readonly authorityT3MetadataSha256: string;
      readonly authorityProofJson: string;
    },
  ) => Promise<boolean>;
  /** Settles an operation that was durably revoked before any grant was bound. */
  readonly abortUnbound: (
    record: Omit<SourceTransferFenceRecord, "leaseOwner"> & {
      readonly now: string;
      readonly authorityProofJson: string;
    },
  ) => Promise<boolean>;
  /** Retains recovery authority but expires this owner's lease immediately. */
  readonly abandon: (record: SourceTransferFenceRecord & { readonly now: string }) => Promise<void>;
}

export function sourceTransferLeaseDeadline(nowMs: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(nowMs + SOURCE_TRANSFER_LEASE_MS));
}
