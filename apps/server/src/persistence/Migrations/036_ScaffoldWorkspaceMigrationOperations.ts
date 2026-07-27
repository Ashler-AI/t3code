import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scaffold_workspace_migration_operations (
      operation_id TEXT PRIMARY KEY,
      fingerprint_sha256 TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      source_environment_id TEXT NOT NULL,
      source_project_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      source_global_session_id TEXT NOT NULL,
      source_omp_session_id TEXT NOT NULL,
      transcript_sha256 TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      omp_bundle_sha256 TEXT NOT NULL,
      t3_metadata_sha256 TEXT NOT NULL,
      workspace_archive_sha256 TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      destination_environment_id TEXT NOT NULL,
      destination_project_id TEXT NOT NULL,
      destination_thread_id TEXT NOT NULL,
      destination_global_session_id TEXT NOT NULL,
      destination_omp_session_id TEXT NOT NULL,
      authority_request_fingerprint_sha256 TEXT NOT NULL,
      authority_state TEXT NOT NULL CHECK (authority_state IN ('prepared', 'admitted', 'completed')),
      authority_updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
