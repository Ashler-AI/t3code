import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  isSourceMutationCommand,
  rejectSourceMutationWhileTransferIsActive,
  SOURCE_TRANSFER_BLOCKED_COMMAND_TYPES,
  type SourceMutationCommand,
} from "./ThreadTransferFence.ts";

const now = "2026-07-26T00:00:00.000Z";
const threadId = ThreadId.make("thread-source-transfer-fenced");
const modelSelectionJson = '{"instanceId":"omp-primary","model":"openai/gpt-5.4"}';

const turnStart: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-source-transfer-fenced-turn"),
  threadId,
  message: {
    messageId: MessageId.make("msg-source-transfer-fenced-turn"),
    role: "user",
    text: "Do not race the export",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};
const turnInterrupt: Extract<OrchestrationCommand, { type: "thread.turn.interrupt" }> = {
  type: "thread.turn.interrupt",
  commandId: CommandId.make("cmd-source-transfer-fenced-interrupt"),
  threadId,
  createdAt: now,
};

const SAFE_COMMAND_TYPES = [
  "project.create",
  "thread.session.set",
  "thread.message.assistant.delta",
  "thread.message.assistant.complete",
  "thread.proposed-plan.upsert",
  "thread.turn.diff.complete",
  "thread.activity.append",
  "thread.revert.complete",
  "thread.title.regeneration.complete",
] as const satisfies ReadonlyArray<OrchestrationCommand["type"]>;

type UnclassifiedCommandType = Exclude<
  OrchestrationCommand["type"],
  (typeof SOURCE_TRANSFER_BLOCKED_COMMAND_TYPES)[number] | (typeof SAFE_COMMAND_TYPES)[number]
>;
const allCommandsAreClassified: UnclassifiedCommandType extends never ? true : never = true;

describe("ThreadTransferFence", () => {
  it("classifies every client thread mutation as blocked and internal/provider commands as safe", () => {
    assert.isTrue(allCommandsAreClassified);
    for (const type of SOURCE_TRANSFER_BLOCKED_COMMAND_TYPES) {
      assert.isTrue(
        isSourceMutationCommand({
          type,
          threadId,
          projectId: "project-source",
        } as OrchestrationCommand),
        type,
      );
    }
    for (const type of SAFE_COMMAND_TYPES) {
      assert.isFalse(isSourceMutationCommand({ type, threadId } as OrchestrationCommand), type);
    }
  });

  it.effect("rejects a concurrent new turn while source capture holds the durable fence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at,
          runtime_mode,
          interaction_mode,
          model_selection_json
        ) VALUES (
          ${threadId},
          'project-source',
          'Source thread',
          NULL,
          NULL,
          NULL,
          ${now},
          ${now},
          NULL,
          'approval-required',
          'default',
          ${modelSelectionJson}
        )
      `;
      yield* sql`
        INSERT INTO scaffold_session_transfer_fences (
          operation_id,
          series_operation_id,
          attempt_generation,
          source_thread_id,
          request_fingerprint_sha256,
          captured_at,
          status,
          lease_owner,
          lease_expires_at,
          receipt_json,
          created_at,
          updated_at
        ) VALUES (
          'operation-fenced',
          'operation-fenced',
          1,
          ${threadId},
          ${"a".repeat(64)},
          ${now},
          'active',
          'owner-fenced',
          '2026-07-26T00:03:00.000Z',
          NULL,
          ${now},
          ${now}
        )
      `;

      const error = yield* sql
        .withTransaction(rejectSourceMutationWhileTransferIsActive(sql, turnStart))
        .pipe(Effect.flip);
      if (error._tag !== "OrchestrationCommandInvariantError") {
        return yield* Effect.die(error);
      }
      assert.match(error.detail, /temporarily fenced/);

      const interruptError = yield* sql
        .withTransaction(rejectSourceMutationWhileTransferIsActive(sql, turnInterrupt))
        .pipe(Effect.flip);
      if (interruptError._tag !== "OrchestrationCommandInvariantError") {
        return yield* Effect.die(interruptError);
      }

      for (const type of SOURCE_TRANSFER_BLOCKED_COMMAND_TYPES) {
        const aggregate =
          type === "project.meta.update" || type === "project.delete"
            ? { type, projectId: "project-source" }
            : { type, threadId };
        const blockedError = yield* sql
          .withTransaction(
            rejectSourceMutationWhileTransferIsActive(sql, aggregate as SourceMutationCommand),
          )
          .pipe(Effect.flip);
        assert.strictEqual(blockedError._tag, "OrchestrationCommandInvariantError", type);
      }
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("keeps a crashed owner's stale fence blocking unrelated source mutations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO scaffold_session_transfer_fences (
          operation_id,
          series_operation_id,
          attempt_generation,
          source_thread_id,
          request_fingerprint_sha256,
          captured_at,
          status,
          lease_owner,
          lease_expires_at,
          receipt_json,
          created_at,
          updated_at
        ) VALUES (
          'operation-stale',
          'operation-stale',
          1,
          ${threadId},
          ${"b".repeat(64)},
          '2026-07-25T23:55:00.000Z',
          'active',
          'owner-crashed',
          '2026-07-25T23:59:00.000Z',
          NULL,
          '2026-07-25T23:55:00.000Z',
          '2026-07-25T23:55:00.000Z'
        )
      `;

      const error = yield* sql
        .withTransaction(rejectSourceMutationWhileTransferIsActive(sql, turnStart))
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "OrchestrationCommandInvariantError");
      const remaining = yield* sql<{
        readonly operationId: string;
        readonly seriesOperationId: string;
        readonly attemptGeneration: number;
      }>`
        SELECT
          operation_id AS "operationId",
          series_operation_id AS "seriesOperationId",
          attempt_generation AS "attemptGeneration"
        FROM scaffold_session_transfer_fences
        WHERE operation_id = 'operation-stale'
      `;
      assert.deepStrictEqual(remaining, [
        {
          operationId: "operation-stale",
          seriesOperationId: "operation-stale",
          attemptGeneration: 1,
        },
      ]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
