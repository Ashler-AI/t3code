// @effect-diagnostics globalDateInEffect:off
import * as NodeCrypto from "node:crypto";

import type { ModelSelection, ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { WorkspaceMigrationImportError } from "./WorkspaceMigrationImportService.ts";

export interface DestinationOperationFingerprint {
  readonly operationId: string;
  readonly capturedAt: string;
  readonly sourceEnvironmentId: string;
  readonly sourceProjectId: string;
  readonly sourceThreadId: string;
  readonly sourceGlobalSessionId: string;
  readonly sourceOmpSessionId: string;
  readonly transcriptSha256: string;
  readonly payloadSha256: string;
  readonly ompBundleSha256: string;
  readonly t3MetadataSha256: string;
  readonly workspaceArchiveSha256: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly destinationEnvironmentId: string;
  readonly destinationProjectId: string;
  readonly destinationThreadId: string;
  readonly destinationGlobalSessionId: string;
  readonly destinationOmpSessionId: string;
  readonly authorityRequestFingerprintSha256: string;
}

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

export function destinationOperationFingerprintSha256(
  record: DestinationOperationFingerprint,
): string {
  return NodeCrypto.createHash("sha256").update(canonicalJson(record)).digest("hex");
}

export function makeSqlDestinationOperationStore(sql: SqlClient.SqlClient) {
  const assertCompatible = (record: DestinationOperationFingerprint) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly fingerprintSha256: string }>`
            SELECT fingerprint_sha256 AS "fingerprintSha256"
            FROM scaffold_workspace_migration_operations
            WHERE operation_id = ${record.operationId}
            LIMIT 1
          `;
          if (
            rows[0] !== undefined &&
            rows[0].fingerprintSha256 !== destinationOperationFingerprintSha256(record)
          ) {
            return yield* new WorkspaceMigrationImportError({
              code: "workspace_migration_destination_operation_conflict",
              detail: "The operation id is already bound to a different destination migration.",
            });
          }
        }),
      )
      .pipe(Effect.runPromise);

  const claim = (record: DestinationOperationFingerprint) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const fingerprintSha256 = destinationOperationFingerprintSha256(record);
          const modelSelectionJson = canonicalJson(record.modelSelection);
          yield* sql`
            INSERT OR IGNORE INTO scaffold_workspace_migration_operations (
              operation_id,
              fingerprint_sha256,
              captured_at,
              source_environment_id,
              source_project_id,
              source_thread_id,
              source_global_session_id,
              source_omp_session_id,
              transcript_sha256,
              payload_sha256,
              omp_bundle_sha256,
              t3_metadata_sha256,
              workspace_archive_sha256,
              model_selection_json,
              runtime_mode,
              interaction_mode,
              destination_environment_id,
              destination_project_id,
              destination_thread_id,
              destination_global_session_id,
              destination_omp_session_id,
              authority_request_fingerprint_sha256,
              authority_state,
              authority_updated_at,
              created_at
            ) VALUES (
              ${record.operationId},
              ${fingerprintSha256},
              ${record.capturedAt},
              ${record.sourceEnvironmentId},
              ${record.sourceProjectId},
              ${record.sourceThreadId},
              ${record.sourceGlobalSessionId},
              ${record.sourceOmpSessionId},
              ${record.transcriptSha256},
              ${record.payloadSha256},
              ${record.ompBundleSha256},
              ${record.t3MetadataSha256},
              ${record.workspaceArchiveSha256},
              ${modelSelectionJson},
              ${record.runtimeMode},
              ${record.interactionMode},
              ${record.destinationEnvironmentId},
              ${record.destinationProjectId},
              ${record.destinationThreadId},
              ${record.destinationGlobalSessionId},
              ${record.destinationOmpSessionId},
              ${record.authorityRequestFingerprintSha256},
              'prepared',
              ${record.capturedAt},
              ${record.capturedAt}
            )
          `;
          const rows = yield* sql<{ readonly fingerprintSha256: string }>`
            SELECT fingerprint_sha256 AS "fingerprintSha256"
            FROM scaffold_workspace_migration_operations
            WHERE operation_id = ${record.operationId}
            LIMIT 1
          `;
          if (rows[0]?.fingerprintSha256 !== fingerprintSha256) {
            return yield* new WorkspaceMigrationImportError({
              code: "workspace_migration_destination_operation_conflict",
              detail: "The operation id is already bound to a different destination migration.",
            });
          }
        }),
      )
      .pipe(Effect.runPromise);

  const setAuthorityState = (
    record: DestinationOperationFingerprint,
    state: "admitted" | "completed",
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const allowedPrior =
            state === "admitted" ? ["prepared", "admitted"] : ["prepared", "admitted", "completed"];
          const rows = yield* sql<{ readonly operationId: string }>`
            UPDATE scaffold_workspace_migration_operations
            SET authority_state = ${state}, authority_updated_at = ${new Date().toISOString()}
            WHERE operation_id = ${record.operationId}
              AND fingerprint_sha256 = ${destinationOperationFingerprintSha256(record)}
              AND authority_state IN (${allowedPrior[0]}, ${allowedPrior[1]}, ${allowedPrior[2] ?? allowedPrior[1]})
            RETURNING operation_id AS "operationId"
          `;
          if (rows.length !== 1) {
            return yield* new WorkspaceMigrationImportError({
              code: "workspace_migration_destination_authority_state_conflict",
              detail: "Destination authority state cannot move backwards or change identity.",
            });
          }
        }),
      )
      .pipe(Effect.runPromise);

  const deletePrepared = (record: DestinationOperationFingerprint) =>
    sql`
      DELETE FROM scaffold_workspace_migration_operations
      WHERE operation_id = ${record.operationId}
        AND fingerprint_sha256 = ${destinationOperationFingerprintSha256(record)}
        AND authority_state = 'prepared'
    `.pipe(Effect.asVoid, Effect.runPromise);

  return { assertCompatible, claim, setAuthorityState, deletePrepared };
}
