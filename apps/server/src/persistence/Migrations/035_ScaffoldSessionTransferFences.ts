import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scaffold_session_transfer_fences (
      operation_id TEXT PRIMARY KEY,
      series_operation_id TEXT NOT NULL,
      attempt_generation INTEGER NOT NULL CHECK (attempt_generation >= 1),
      source_thread_id TEXT NOT NULL,
      source_project_id TEXT,
      source_omp_session_id TEXT,
      request_fingerprint_sha256 TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'aborted')),
      lease_owner TEXT,
      lease_expires_at TEXT,
      receipt_json TEXT,
      authority_lifecycle_epoch INTEGER,
      authority_grant_id TEXT,
      authority_sandbox_id TEXT,
      authority_session_id TEXT,
      authority_payload_digest_sha256 TEXT,
      authority_archive_sha256 TEXT,
      authority_transcript_sha256 TEXT,
      authority_omp_bundle_sha256 TEXT,
      authority_t3_metadata_sha256 TEXT,
      authority_proof_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (status = 'active' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND receipt_json IS NULL AND authority_proof_json IS NULL AND ((source_project_id IS NULL AND source_omp_session_id IS NULL) OR (source_project_id IS NOT NULL AND source_omp_session_id IS NOT NULL)) AND ((authority_lifecycle_epoch IS NULL AND authority_grant_id IS NULL AND authority_sandbox_id IS NULL AND authority_session_id IS NULL AND authority_payload_digest_sha256 IS NULL AND authority_archive_sha256 IS NULL AND authority_transcript_sha256 IS NULL AND authority_omp_bundle_sha256 IS NULL AND authority_t3_metadata_sha256 IS NULL) OR (authority_lifecycle_epoch IS NOT NULL AND authority_grant_id IS NOT NULL AND authority_sandbox_id IS NOT NULL AND authority_session_id IS NOT NULL AND authority_payload_digest_sha256 IS NOT NULL AND authority_archive_sha256 IS NOT NULL AND authority_transcript_sha256 IS NOT NULL AND authority_omp_bundle_sha256 IS NOT NULL AND authority_t3_metadata_sha256 IS NOT NULL)))
        OR
        (status = 'completed' AND source_project_id IS NOT NULL AND source_omp_session_id IS NOT NULL AND lease_owner IS NULL AND lease_expires_at IS NULL AND receipt_json IS NOT NULL AND authority_proof_json IS NOT NULL AND authority_lifecycle_epoch IS NOT NULL AND authority_grant_id IS NOT NULL AND authority_sandbox_id IS NOT NULL AND authority_session_id IS NOT NULL AND authority_payload_digest_sha256 IS NOT NULL AND authority_archive_sha256 IS NOT NULL AND authority_transcript_sha256 IS NOT NULL AND authority_omp_bundle_sha256 IS NOT NULL AND authority_t3_metadata_sha256 IS NOT NULL)
        OR
        (status = 'aborted' AND ((source_project_id IS NULL AND source_omp_session_id IS NULL) OR (source_project_id IS NOT NULL AND source_omp_session_id IS NOT NULL)) AND lease_owner IS NULL AND lease_expires_at IS NULL AND receipt_json IS NULL AND authority_proof_json IS NOT NULL AND ((authority_lifecycle_epoch IS NULL AND authority_grant_id IS NULL AND authority_sandbox_id IS NULL AND authority_session_id IS NULL AND authority_payload_digest_sha256 IS NULL AND authority_archive_sha256 IS NULL AND authority_transcript_sha256 IS NULL AND authority_omp_bundle_sha256 IS NULL AND authority_t3_metadata_sha256 IS NULL) OR (authority_lifecycle_epoch IS NOT NULL AND authority_grant_id IS NOT NULL AND authority_sandbox_id IS NOT NULL AND authority_session_id IS NOT NULL AND authority_payload_digest_sha256 IS NOT NULL AND authority_archive_sha256 IS NOT NULL AND authority_transcript_sha256 IS NOT NULL AND authority_omp_bundle_sha256 IS NOT NULL AND authority_t3_metadata_sha256 IS NOT NULL)))
      )
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scaffold_session_transfer_series_generation
    ON scaffold_session_transfer_fences(series_operation_id, attempt_generation)
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scaffold_session_transfer_active_thread
    ON scaffold_session_transfer_fences(source_thread_id)
    WHERE status = 'active'
  `;
});
