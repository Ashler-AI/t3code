import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  destinationOperationFingerprintSha256,
  makeSqlDestinationOperationStore,
  type DestinationOperationFingerprint,
} from "./DestinationOperationFingerprint.ts";

const record = {
  operationId: "operation-1",
  capturedAt: "2026-07-26T00:00:00.000Z",
  sourceEnvironmentId: "source-environment",
  sourceProjectId: "source-project",
  sourceThreadId: "source-thread",
  sourceGlobalSessionId: "sf:source-environment:source-thread",
  sourceOmpSessionId: "omp-private-session",
  transcriptSha256: "1".repeat(64),
  payloadSha256: "2".repeat(64),
  ompBundleSha256: "3".repeat(64),
  t3MetadataSha256: "4".repeat(64),
  workspaceArchiveSha256: "5".repeat(64),
  modelSelection: {
    instanceId: "omp" as never,
    model: "openai/gpt-5.6-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  destinationEnvironmentId: "destination-environment",
  destinationProjectId: "destination-project",
  destinationThreadId: "destination-thread",
  destinationGlobalSessionId: "sf:destination-environment:destination-thread",
  destinationOmpSessionId: "omp-private-session",
  authorityRequestFingerprintSha256: "4".repeat(64),
} as const satisfies DestinationOperationFingerprint;

const TestLayer = SqlitePersistenceMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "destination-operation-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("destination operation fingerprint", (it) => {
  it.effect("accepts an identical retry after the store is recreated", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.promise(() => makeSqlDestinationOperationStore(sql).claim(record));
      yield* Effect.promise(() => makeSqlDestinationOperationStore(sql).claim(record));
      const rows = yield* sql<{ readonly fingerprintSha256: string }>`
        SELECT fingerprint_sha256 AS "fingerprintSha256"
        FROM scaffold_workspace_migration_operations
        WHERE operation_id = ${record.operationId}
      `;
      assert.deepStrictEqual(rows, [
        { fingerprintSha256: destinationOperationFingerprintSha256(record) },
      ]);
    }),
  );

  it.effect("rejects a same-operation retry with a conflicting bound digest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = makeSqlDestinationOperationStore(sql);
      yield* Effect.promise(() => store.claim({ ...record, operationId: "operation-conflict" }));
      yield* Effect.promise(() =>
        expect(
          makeSqlDestinationOperationStore(sql).claim({
            ...record,
            operationId: "operation-conflict",
            transcriptSha256: "9".repeat(64),
          }),
        ).rejects.toMatchObject({
          code: "workspace_migration_destination_operation_conflict",
        }),
      );
    }),
  );
});
