import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ScaffoldSessionTransferFences from "./035_ScaffoldSessionTransferFences.ts";
import ScaffoldWorkspaceMigrationOperations from "./036_ScaffoldWorkspaceMigrationOperations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_ProjectionThreadTitleRegenerationCompatibility", (it) => {
  it.effect("repairs databases that used migration 35 before the upstream title migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          scripts_json,
          created_at,
          updated_at
        ) VALUES (
          'project-existing',
          'Existing project',
          '/tmp/existing',
          '{}',
          '2026-07-29T00:00:00.000Z',
          '2026-07-29T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          created_at,
          updated_at
        ) VALUES (
          'thread-existing',
          'project-existing',
          'Existing thread',
          '2026-07-29T00:00:00.000Z',
          '2026-07-29T00:00:00.000Z'
        )
      `;

      // The pre-rebase Ashler fork already shipped migrations 35 and 36 under
      // these names, so Effect's monotonic migrator skips upstream's new 35.
      yield* ScaffoldSessionTransferFences;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (35, 'ScaffoldSessionTransferFences')
      `;
      yield* ScaffoldWorkspaceMigrationOperations;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (36, 'ScaffoldWorkspaceMigrationOperations')
      `;

      yield* runMigrations({ toMigrationInclusive: 37 });

      const columnsBeforeRepair = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(
        !columnsBeforeRepair.some((column) => column.name === "title_regeneration_request_id"),
      );

      yield* runMigrations({ toMigrationInclusive: 38 });

      const columnsAfterRepair = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = new Set(columnsAfterRepair.map((column) => column.name));
      assert.ok(names.has("title_regeneration_request_id"));
      assert.ok(names.has("title_regeneration_started_at"));

      const existingThreads = yield* sql<{ readonly threadId: string; readonly title: string }>`
        SELECT thread_id AS "threadId", title
        FROM projection_threads
        WHERE thread_id = 'thread-existing'
      `;
      assert.deepStrictEqual(existingThreads, [
        {
          threadId: "thread-existing",
          title: "Existing thread",
        },
      ]);
    }),
  );
});
