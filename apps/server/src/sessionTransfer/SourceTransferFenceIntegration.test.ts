import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
  SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
  ScaffoldSessionTransferStartInput,
  ScaffoldWorkspaceMigrationReceipt,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  makeIdempotentScaffoldSessionTransferSource,
  makeSqlSourceTransferFenceStore,
  sourceTransferOperationId,
  sourceTransferRequestFingerprint,
  type SourceTransferReceiptStore,
} from "./ScaffoldSessionTransferSource.ts";

const now = "2026-07-26T00:00:00.000Z";
const leaseExpiresAt = "2099-07-26T00:00:00.000Z";
const decodeReceipt = Schema.decodeUnknownSync(ScaffoldWorkspaceMigrationReceipt);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const decodeStartInput = Schema.decodeUnknownSync(ScaffoldSessionTransferStartInput);
const sourceEnvironmentId = EnvironmentId.make("env-source");
const receipt = decodeReceipt({
  ok: true,
  version: "scaffold.workspace_migration.receipt.v1",
  sessionId: "ses-destination",
  operationId: "operation-replay",
  payloadDigestSha256: "a".repeat(64),
  archiveSha256: "d".repeat(64),
  ompBundleSha256: "b".repeat(64),
  t3MetadataSha256: "c".repeat(64),
  workspaceArchiveSha256: "d".repeat(64),
  transcriptSha256: "e".repeat(64),
  credentialExclusions: [...SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1],
  unsupportedFilesystemCases: [...SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1],
  binding: {
    deployment: "staging",
    environmentId: "env-destination",
    sessionId: "ses-destination",
    lifecycleEpoch: 1,
    status: "ready",
    links: {
      session: "https://scaffold.example/?q=ses-destination",
      web: "https://scaffold.example/sessions/ses-destination/web",
      tilt: "https://scaffold.example/sessions/ses-destination/tilt",
    },
    lastKnownAt: now,
  },
  source: {
    environmentId: "env-source",
    projectId: "project-source",
    threadId: "thread-replay",
    globalSessionId: "sf:env-source:thread-replay",
    ompSessionId: "omp-source",
  },
  destination: {
    environmentId: "env-destination",
    projectId: "project-destination",
    threadId: "thread-destination",
    globalSessionId: "sf:env-destination:thread-destination",
    ompSessionId: "omp-destination",
  },
});

const OrchestrationIntegrationLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "source-transfer-fence-integration-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(OrchestrationIntegrationLayer)("source transfer durable authority", (it) => {
  it.effect("atomically chooses either source capture or a concurrent turn commit", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const store = makeSqlSourceTransferFenceStore(sql);
      const projectId = ProjectId.make("project-transfer-race");
      const threadId = ThreadId.make("thread-transfer-race");
      const turnCommandId = CommandId.make("cmd-transfer-race-turn");

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-transfer-race-project-create"),
        projectId,
        title: "Transfer race",
        workspaceRoot: "/tmp/transfer-race",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("omp-primary"),
          model: "openai/gpt-5.4",
        },
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-transfer-race-thread-create"),
        threadId,
        projectId,
        title: "Transfer race",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp-primary"),
          model: "openai/gpt-5.4",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });

      const fenceRecord = {
        operationId: "operation-transfer-race",
        sourceThreadId: threadId,
        requestFingerprintSha256: "c".repeat(64),
        leaseOwner: "owner-transfer-race",
        now,
        leaseExpiresAt,
      } as const;
      const [acquireExit, dispatchExit] = yield* Effect.all(
        [
          Effect.exit(Effect.promise(() => store.acquire(fenceRecord))),
          Effect.exit(
            engine.dispatch({
              type: "thread.turn.start",
              commandId: turnCommandId,
              threadId,
              message: {
                messageId: MessageId.make("msg-transfer-race-turn"),
                role: "user",
                text: "Race the source capture",
                attachments: [],
              },
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "approval-required",
              createdAt: now,
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );

      assert.isTrue(Exit.isSuccess(acquireExit));
      if (!Exit.isSuccess(acquireExit)) return;
      const events = yield* sql<{ readonly eventType: string }>`
        SELECT event_type AS "eventType"
        FROM orchestration_events
        WHERE command_id = ${turnCommandId}
        ORDER BY sequence
      `;
      const acceptedReceipts = yield* sql`
        SELECT command_id
        FROM orchestration_command_receipts
        WHERE command_id = ${turnCommandId} AND status = 'accepted'
      `;
      const captureWon = acquireExit.value.kind === "acquired";
      const turnWon = Exit.isSuccess(dispatchExit);
      assert.notStrictEqual(captureWon, turnWon);
      if (captureWon) {
        assert.lengthOf(events, 0);
        assert.lengthOf(acceptedReceipts, 0);
      } else {
        assert.strictEqual(acquireExit.value.kind, "source-busy");
        assert.deepStrictEqual(
          events.map((event) => event.eventType),
          ["thread.message-sent", "thread.turn-start-requested"],
        );
        assert.lengthOf(acceptedReceipts, 1);
      }
    }),
  );

  it.effect("replays a completed SQL receipt after the store is recreated", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const record = {
        operationId: "operation-replay",
        sourceThreadId: "thread-replay",
        requestFingerprintSha256: "d".repeat(64),
        leaseOwner: "owner-replay",
        now,
        leaseExpiresAt,
      } as const;
      const firstStore = makeSqlSourceTransferFenceStore(sql);
      assert.deepStrictEqual(yield* Effect.promise(() => firstStore.acquire(record)), {
        kind: "acquired",
        capturedAt: now,
      });
      assert.isTrue(
        yield* Effect.promise(() =>
          firstStore.bindSourceIdentity({
            ...record,
            sourceIdentity: {
              sourceProjectId: receipt.source.projectId,
              sourceOmpSessionId: receipt.source.ompSessionId,
            },
          }),
        ),
      );
      assert.isTrue(
        yield* Effect.promise(() =>
          firstStore.bindAuthority({
            ...record,
            authority: {
              lifecycleEpoch: receipt.binding.lifecycleEpoch,
              grantId: "grant-replay",
              sandboxId: "sandbox-replay",
              sessionId: receipt.sessionId,
              payloadDigestSha256: receipt.payloadDigestSha256,
              archiveSha256: receipt.archiveSha256,
              transcriptSha256: receipt.transcriptSha256,
              ompBundleSha256: receipt.ompBundleSha256,
              t3MetadataSha256: receipt.t3MetadataSha256,
            },
          }),
        ),
      );
      assert.isTrue(yield* Effect.promise(() => firstStore.complete({ ...record, receipt })));

      const recreatedStore = makeSqlSourceTransferFenceStore(sql);
      const replay = yield* Effect.promise(() =>
        recreatedStore.acquire({ ...record, leaseOwner: "owner-recreated" }),
      );
      assert.strictEqual(replay.kind, "completed");
      if (replay.kind === "completed") assert.deepStrictEqual(replay.receipt, receipt);
    }),
  );

  it.effect("reuses the canonical capture epoch after a destination commit response is lost", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-lost-response");
      const threadId = ThreadId.make("thread-lost-response");
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-lost-response-project-create"),
        projectId,
        title: "Lost response",
        workspaceRoot: "/tmp/lost-response",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("omp-primary"),
          model: "openai/gpt-5.4",
        },
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-lost-response-thread-create"),
        threadId,
        projectId,
        title: "Lost response",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp-primary"),
          model: "openai/gpt-5.4",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });

      const operationId = sourceTransferOperationId({
        sourceEnvironmentId,
        sourceThreadId: threadId,
        deployment: "staging",
      });
      const input = decodeStartInput({
        operationId,
        deployment: "staging",
        sourceThreadId: threadId,
        create: { name: "Lost response transfer" },
      });
      const destinationReceipt = decodeReceipt({
        ...receipt,
        operationId,
        source: {
          ...receipt.source,
          projectId,
          threadId,
          globalSessionId: `sf:env-source:${threadId}`,
        },
      });
      const destinationReceipts = new Map<string, ScaffoldWorkspaceMigrationReceipt>();
      const captureEpochs: string[] = [];
      let destinationCommits = 0;
      let clockMs = DateTime.makeUnsafe(now).epochMilliseconds;
      const execute = (
        request: typeof input,
        durableCapture: { readonly capturedAt: string },
        journal: Parameters<
          Parameters<typeof makeIdempotentScaffoldSessionTransferSource>[0]["execute"]
        >[2],
      ) =>
        journal
          .bindSourceIdentity({
            sourceProjectId: destinationReceipt.source.projectId,
            sourceOmpSessionId: destinationReceipt.source.ompSessionId,
          })
          .pipe(
            Effect.andThen(
              journal.bind({
                lifecycleEpoch: destinationReceipt.binding.lifecycleEpoch,
                grantId: "grant-lost-response",
                sandboxId: "sandbox-lost-response",
                sessionId: destinationReceipt.sessionId,
                payloadDigestSha256: destinationReceipt.payloadDigestSha256,
                archiveSha256: destinationReceipt.archiveSha256,
                transcriptSha256: destinationReceipt.transcriptSha256,
                ompBundleSha256: destinationReceipt.ompBundleSha256,
                t3MetadataSha256: destinationReceipt.t3MetadataSha256,
              }),
            ),
            Effect.andThen(
              Effect.sync(() => {
                captureEpochs.push(durableCapture.capturedAt);
                const payloadIdentity = `${request.operationId}:${durableCapture.capturedAt}`;
                const existing = destinationReceipts.get(payloadIdentity);
                if (existing) return existing;
                destinationCommits += 1;
                destinationReceipts.set(payloadIdentity, destinationReceipt);
                return destinationReceipt;
              }),
            ),
          );

      const sqlStore = makeSqlSourceTransferFenceStore(sql);
      const crashAfterDestinationCommit: SourceTransferReceiptStore = {
        ...sqlStore,
        complete: async () => {
          throw new Error("simulated process crash after destination commit");
        },
      };
      const firstSource = makeIdempotentScaffoldSessionTransferSource({
        sourceEnvironmentId,
        store: crashAfterDestinationCommit,
        now: () => clockMs,
        leaseOwner: () => "owner-before-crash",
        execute,
      });
      yield* firstSource.start(input).pipe(Effect.flip);

      const persistedAfterCrash = yield* sql<{
        readonly capturedAt: string;
        readonly status: string;
        readonly sourceProjectId: string;
        readonly sourceOmpSessionId: string;
      }>`
        SELECT
          captured_at AS "capturedAt",
          status,
          source_project_id AS "sourceProjectId",
          source_omp_session_id AS "sourceOmpSessionId"
        FROM scaffold_session_transfer_fences
        WHERE operation_id = ${operationId}
      `;
      assert.deepStrictEqual(persistedAfterCrash, [
        {
          capturedAt: now,
          status: "active",
          sourceProjectId: destinationReceipt.source.projectId,
          sourceOmpSessionId: destinationReceipt.source.ompSessionId,
        },
      ]);

      const distinctOperation = yield* Effect.promise(() =>
        makeSqlSourceTransferFenceStore(sql).acquire({
          operationId: "operation-must-not-overtake-reconciliation",
          sourceThreadId: threadId,
          requestFingerprintSha256: "e".repeat(64),
          leaseOwner: "owner-distinct-operation",
          now,
          leaseExpiresAt,
        }),
      );
      assert.deepStrictEqual(distinctOperation, { kind: "thread-conflict" });

      clockMs += 5 * 60 * 1000;
      const recreatedSource = makeIdempotentScaffoldSessionTransferSource({
        sourceEnvironmentId,
        store: makeSqlSourceTransferFenceStore(sql),
        now: () => clockMs,
        leaseOwner: () => "owner-after-crash",
        execute,
        authority: {
          reconcile: async () => ({
            state: "completed",
            operationId,
            requestFingerprintSha256: sourceTransferRequestFingerprint(input),
            lifecycleEpoch: destinationReceipt.binding.lifecycleEpoch,
            grantId: "grant-lost-response",
            sandboxId: "sandbox-lost-response",
            sessionId: destinationReceipt.sessionId,
            payloadDigestSha256: destinationReceipt.payloadDigestSha256,
            archiveSha256: destinationReceipt.archiveSha256,
            transcriptSha256: destinationReceipt.transcriptSha256,
            ompBundleSha256: destinationReceipt.ompBundleSha256,
            t3MetadataSha256: destinationReceipt.t3MetadataSha256,
            receipt: destinationReceipt,
          }),
          abort: async () => ({
            state: "pending",
            operationId,
            requestFingerprintSha256: sourceTransferRequestFingerprint(input),
            lifecycleEpoch: destinationReceipt.binding.lifecycleEpoch,
            grantId: "grant-lost-response",
            sandboxId: "sandbox-lost-response",
            sessionId: destinationReceipt.sessionId,
            payloadDigestSha256: destinationReceipt.payloadDigestSha256,
            archiveSha256: destinationReceipt.archiveSha256,
            transcriptSha256: destinationReceipt.transcriptSha256,
            ompBundleSha256: destinationReceipt.ompBundleSha256,
            t3MetadataSha256: destinationReceipt.t3MetadataSha256,
          }),
        },
      });
      const reconciled = yield* recreatedSource.start(input);

      assert.deepStrictEqual(reconciled, destinationReceipt);
      assert.deepStrictEqual(captureEpochs, [now]);
      assert.strictEqual(destinationCommits, 1);
      assert.strictEqual(destinationReceipts.size, 1);
      const active = yield* sql`
        SELECT operation_id
        FROM scaffold_session_transfer_fences
        WHERE source_thread_id = ${threadId} AND status = 'active'
      `;
      assert.lengthOf(active, 0);
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-lost-response-source-resumed"),
        threadId,
        title: "Source resumed after reconciliation",
      });
    }),
  );

  it.effect("backfills exact terminal authority after a crash before source bind", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = makeSqlSourceTransferFenceStore(sql);
      const authority = {
        authorityLifecycleEpoch: receipt.binding.lifecycleEpoch,
        authorityGrantId: "grant-prebind-crash",
        authoritySandboxId: "sandbox-prebind-crash",
        authoritySessionId: receipt.sessionId,
        authorityPayloadDigestSha256: receipt.payloadDigestSha256,
        authorityArchiveSha256: receipt.archiveSha256,
        authorityTranscriptSha256: receipt.transcriptSha256,
        authorityOmpBundleSha256: receipt.ompBundleSha256,
        authorityT3MetadataSha256: receipt.t3MetadataSha256,
      } as const;
      const completedFence = {
        operationId: "operation-prebind-crash-completed",
        sourceThreadId: ThreadId.make("thread-prebind-crash-completed"),
        requestFingerprintSha256: "1".repeat(64),
        leaseOwner: "crashed-owner-completed",
        now,
        leaseExpiresAt,
      } as const;
      yield* Effect.promise(() => store.acquire(completedFence));
      assert.isTrue(
        yield* Effect.promise(() =>
          store.bindSourceIdentity({
            ...completedFence,
            sourceIdentity: {
              sourceProjectId: receipt.source.projectId,
              sourceOmpSessionId: receipt.source.ompSessionId,
            },
          }),
        ),
      );
      assert.isTrue(
        yield* Effect.promise(() =>
          store.reconcileCompleted({
            ...completedFence,
            now: "2026-07-26T00:01:00.000Z",
            receipt,
            ...authority,
            authorityProofJson: encodeUnknownJson({ state: "completed", binding: authority }),
          }),
        ),
      );

      const abortedFence = {
        operationId: "operation-prebind-crash-aborted",
        sourceThreadId: ThreadId.make("thread-prebind-crash-aborted"),
        requestFingerprintSha256: "2".repeat(64),
        leaseOwner: "crashed-owner-aborted",
        now,
        leaseExpiresAt,
      } as const;
      yield* Effect.promise(() => store.acquire(abortedFence));
      assert.isTrue(
        yield* Effect.promise(() =>
          store.abort({
            ...abortedFence,
            now: "2026-07-26T00:01:00.000Z",
            ...authority,
            authorityProofJson: encodeUnknownJson({
              state: "noncommittable",
              binding: authority,
            }),
          }),
        ),
      );

      const rows = yield* sql<{
        readonly status: string;
        readonly authorityGrantId: string;
      }>`
        SELECT status, authority_grant_id AS "authorityGrantId"
        FROM scaffold_session_transfer_fences
        WHERE operation_id IN (${completedFence.operationId}, ${abortedFence.operationId})
        ORDER BY operation_id
      `;
      assert.deepStrictEqual(rows, [
        { status: "aborted", authorityGrantId: authority.authorityGrantId },
        { status: "completed", authorityGrantId: authority.authorityGrantId },
      ]);
    }),
  );

  it.effect("unblocks source authority only after noncommittable settlement", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const store = makeSqlSourceTransferFenceStore(sql);
      const projectId = ProjectId.make("project-transfer-abort");
      const threadId = ThreadId.make("thread-transfer-abort");
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-transfer-abort-project-create"),
        projectId,
        title: "Transfer abort",
        workspaceRoot: "/tmp/transfer-abort",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("omp-primary"),
          model: "openai/gpt-5.4",
        },
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-transfer-abort-thread-create"),
        threadId,
        projectId,
        title: "Transfer abort",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp-primary"),
          model: "openai/gpt-5.4",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });

      const fence = {
        operationId: "operation-transfer-abort",
        sourceThreadId: threadId,
        requestFingerprintSha256: "f".repeat(64),
        leaseOwner: "stale-owner-transfer-abort",
        now,
        leaseExpiresAt,
      } as const;
      assert.deepStrictEqual(yield* Effect.promise(() => store.acquire(fence)), {
        kind: "acquired",
        capturedAt: now,
      });
      assert.isTrue(
        yield* Effect.promise(() =>
          store.bindAuthority({
            operationId: fence.operationId,
            sourceThreadId: fence.sourceThreadId,
            requestFingerprintSha256: fence.requestFingerprintSha256,
            leaseOwner: fence.leaseOwner,
            now,
            authority: {
              lifecycleEpoch: 9,
              grantId: "grant-transfer-abort",
              sandboxId: "sandbox-transfer-abort",
              sessionId: receipt.sessionId,
              payloadDigestSha256: receipt.payloadDigestSha256,
              archiveSha256: receipt.archiveSha256,
              transcriptSha256: receipt.transcriptSha256,
              ompBundleSha256: receipt.ompBundleSha256,
              t3MetadataSha256: receipt.t3MetadataSha256,
            },
          }),
        ),
      );

      yield* engine.dispatch(
        {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-transfer-provider-metadata-update"),
          threadId,
          title: "Provider metadata remains projectable",
        },
        {
          metadata: {
            providerEventId: EventId.make("omp:session-transfer:222"),
            providerEnvironmentId: sourceEnvironmentId,
            providerThreadId: threadId,
            providerSourceSequence: 222,
            providerResumeCursor: {
              kind: "omp",
              schemaVersion: 3,
              sessionId: RuntimeSessionId.make("session-transfer"),
              eventSequence: 222,
              acpSequence: 92,
            },
            providerInstanceId: ProviderInstanceId.make("omp-primary"),
            providerRuntimeSessionId: RuntimeSessionId.make("session-transfer"),
          },
        },
      );

      const blocked = yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-transfer-abort-blocked"),
          threadId,
          title: "Must remain blocked",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(blocked));

      assert.isTrue(
        yield* Effect.promise(() =>
          store.abort({
            operationId: fence.operationId,
            sourceThreadId: fence.sourceThreadId,
            requestFingerprintSha256: fence.requestFingerprintSha256,
            now: "2026-07-26T00:01:00.000Z",
            authorityLifecycleEpoch: 9,
            authorityGrantId: "grant-transfer-abort",
            authoritySandboxId: "sandbox-transfer-abort",
            authoritySessionId: receipt.sessionId,
            authorityPayloadDigestSha256: receipt.payloadDigestSha256,
            authorityArchiveSha256: receipt.archiveSha256,
            authorityTranscriptSha256: receipt.transcriptSha256,
            authorityOmpBundleSha256: receipt.ompBundleSha256,
            authorityT3MetadataSha256: receipt.t3MetadataSha256,
            authorityProofJson: encodeUnknownJson({ state: "noncommittable", revision: 2 }),
          }),
        ),
      );
      assert.isFalse(
        yield* Effect.promise(() =>
          store.complete({
            ...fence,
            now: "2026-07-26T00:01:01.000Z",
            receipt,
          }),
        ),
      );

      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-transfer-abort-resumed"),
        threadId,
        title: "Source resumed after safe abort",
      });
      const readable = yield* sql<{ readonly title: string }>`
        SELECT title
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(readable, [{ title: "Source resumed after safe abort" }]);
    }),
  );
});
