import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
  SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
  ScaffoldSessionTransferStartInput,
  ScaffoldWorkspaceMigrationReceipt,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import {
  captureThenMigrateWithSourceRestore,
  decodeSourceTransferAuthorityResolution,
  makeIdempotentScaffoldSessionTransferSource,
  makeSourceSessionRestorePlan,
  sourceTransferAttemptOperationId,
  sourceTransferOperationId,
  sourceTransferRequestFingerprint,
  type SourceTransferReceiptStore,
} from "./ScaffoldSessionTransferSource.ts";
import { WorkspaceMigrationImportError } from "./WorkspaceMigrationImportService.ts";
import { canonicalTranscriptSha256 } from "./CanonicalTranscript.ts";

const decodeStartInput = Schema.decodeUnknownSync(ScaffoldSessionTransferStartInput);
const encodeStartInput = Schema.encodeSync(ScaffoldSessionTransferStartInput);
const decodeReceipt = Schema.decodeUnknownSync(ScaffoldWorkspaceMigrationReceipt);
const sourceEnvironmentId = EnvironmentId.make("env-source");
const sourceThreadId = ThreadId.make("thread-source");
const startInput = decodeStartInput({
  operationId: sourceTransferOperationId({
    sourceEnvironmentId,
    sourceThreadId,
    deployment: "staging",
  }),
  deployment: "staging",
  sourceThreadId,
  create: { name: "Transferred session" },
});
const receipt = decodeReceipt({
  ok: true,
  version: "scaffold.workspace_migration.receipt.v1",
  sessionId: "ses-destination",
  operationId: startInput.operationId,
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
    lastKnownAt: "2026-07-26T00:00:00.000Z",
  },
  source: {
    environmentId: "env-source",
    projectId: "project-source",
    threadId: "thread-source",
    globalSessionId: "sf:env-source:thread-source",
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
const encodeReceipt = Schema.encodeSync(ScaffoldWorkspaceMigrationReceipt);
const encodedReceipt = encodeReceipt(receipt);
const receiptForOperation = (operationId: string) =>
  decodeReceipt({
    ...encodedReceipt,
    operationId,
  });
const receiptIdentityMutations = [
  {
    name: "source project",
    receipt: () =>
      decodeReceipt({
        ...encodedReceipt,
        source: { ...encodedReceipt.source, projectId: "project-substituted" },
      }),
  },
  {
    name: "source OMP session",
    receipt: () =>
      decodeReceipt({
        ...encodedReceipt,
        source: { ...encodedReceipt.source, ompSessionId: "omp-substituted" },
      }),
  },
  {
    name: "fresh destination project",
    receipt: () =>
      decodeReceipt({
        ...encodedReceipt,
        destination: {
          ...encodedReceipt.destination,
          projectId: encodedReceipt.source.projectId,
        },
      }),
  },
  {
    name: "reused destination OMP session",
    receipt: () =>
      decodeReceipt({
        ...encodedReceipt,
        destination: {
          ...encodedReceipt.destination,
          ompSessionId: encodedReceipt.source.ompSessionId,
        },
      }),
  },
] as const;
const authorityBinding = {
  lifecycleEpoch: receipt.binding.lifecycleEpoch,
  grantId: "grant-7",
  sandboxId: "sandbox-7",
  sessionId: receipt.sessionId,
  payloadDigestSha256: receipt.payloadDigestSha256,
  archiveSha256: receipt.archiveSha256,
  transcriptSha256: receipt.transcriptSha256,
  ompBundleSha256: receipt.ompBundleSha256,
  t3MetadataSha256: receipt.t3MetadataSha256,
} as const;

describe("source transfer authority status decoding", () => {
  const fingerprint = sourceTransferRequestFingerprint(startInput);
  const binding = {
    operationId: startInput.operationId,
    requestFingerprintSha256: fingerprint,
    sessionId: receipt.sessionId,
    sandboxId: "sandbox-7",
    lifecycleEpoch: 1,
    grantId: "grant-7",
    payloadDigestSha256: receipt.payloadDigestSha256,
    archiveSha256: receipt.archiveSha256,
    transcriptSha256: receipt.transcriptSha256,
    ompBundleSha256: receipt.ompBundleSha256,
    t3MetadataSha256: receipt.t3MetadataSha256,
  };
  const base = {
    ok: true,
    version: "scaffold.workspace_migration.operation_status.v1",
  } as const;

  it("maps the real nested admitted response to a bound pending fence", () => {
    assert.deepStrictEqual(
      decodeSourceTransferAuthorityResolution(
        { ...base, state: "admitted", binding },
        { operationId: startInput.operationId, requestFingerprintSha256: fingerprint },
      ),
      { ...binding, state: "pending" },
    );
  });

  it("decodes completed and bound noncommittable responses", () => {
    const completed = decodeSourceTransferAuthorityResolution(
      { ...base, state: "completed", binding, receipt },
      { operationId: startInput.operationId, requestFingerprintSha256: fingerprint },
    );
    assert.strictEqual(completed.state, "completed");
    if (completed.state === "completed") assert.deepStrictEqual(completed.receipt, receipt);

    const proof = {
      version: "scaffold.workspace_migration.noncommittable.v1",
      scope: "bound",
      operationId: startInput.operationId,
      requestFingerprintSha256: fingerprint,
      sessionId: receipt.sessionId,
      sandboxId: binding.sandboxId,
      lifecycleEpoch: binding.lifecycleEpoch,
      grantId: binding.grantId,
      revokedAt: "2026-07-26T00:01:00.000Z",
      reason: "operator_abort",
    } as const;
    assert.deepStrictEqual(
      decodeSourceTransferAuthorityResolution(
        { ...base, state: "noncommittable", binding, proof },
        { operationId: startInput.operationId, requestFingerprintSha256: fingerprint },
      ),
      { ...binding, state: "noncommittable", proof },
    );
  });

  it("keeps unknown operations pending without fabricating a binding", () => {
    assert.deepStrictEqual(
      decodeSourceTransferAuthorityResolution(
        { error: "workspace_migration_operation_unknown" },
        { operationId: startInput.operationId, requestFingerprintSha256: fingerprint },
      ),
      {
        state: "pending",
        operationId: startInput.operationId,
        requestFingerprintSha256: fingerprint,
      },
    );
  });
});

function memoryStore() {
  type Record = {
    seriesOperationId: string | undefined;
    attemptGeneration: number | undefined;
    sourceThreadId: string;
    requestFingerprintSha256: string;
    capturedAt: string;
    status: "active" | "completed" | "aborted";
    leaseOwner?: string;
    leaseExpiresAt?: string;
    receipt?: ScaffoldWorkspaceMigrationReceipt;
    sourceIdentity?: {
      sourceProjectId: string;
      sourceOmpSessionId: string;
    };
    authority?: {
      lifecycleEpoch: number;
      grantId: string;
      sandboxId: string;
      sessionId: string;
      payloadDigestSha256: string;
      archiveSha256: string;
      transcriptSha256: string;
      ompBundleSha256: string;
      t3MetadataSha256: string;
    };
  };
  const records = new Map<string, Record>();
  return {
    records,
    store: {
      resolveAttempt: async (input) => {
        const latest = [...records.entries()]
          .filter(
            ([operationId, record]) =>
              (record.seriesOperationId ?? operationId) === input.seriesOperationId,
          )
          .sort(
            ([, left], [, right]) => (right.attemptGeneration ?? 1) - (left.attemptGeneration ?? 1),
          )[0];
        if (!latest) return { operationId: input.seriesOperationId, generation: 1 };
        const [operationId, record] = latest;
        const generation = record.attemptGeneration ?? 1;
        if (record.status === "aborted" && input.allocateAfterAbort) {
          return {
            operationId: sourceTransferAttemptOperationId(input.seriesOperationId, generation + 1),
            generation: generation + 1,
          };
        }
        return { operationId, generation };
      },
      acquire: async (record) => {
        const existing = records.get(record.operationId);
        if (existing) {
          if (
            existing.sourceThreadId !== record.sourceThreadId ||
            existing.requestFingerprintSha256 !== record.requestFingerprintSha256
          ) {
            return { kind: "operation-conflict" as const };
          }
          if (existing.status === "completed" && existing.receipt) {
            return { kind: "completed" as const, receipt: existing.receipt };
          }
          if (existing.status === "aborted") return { kind: "aborted" as const };
          if (existing.leaseExpiresAt !== undefined && existing.leaseExpiresAt <= record.now) {
            return { kind: "reconcile-required" as const };
          }
          return { kind: "in-progress" as const };
        }
        if (
          [...records.values()].some(
            (candidate) =>
              candidate.status === "active" && candidate.sourceThreadId === record.sourceThreadId,
          )
        ) {
          return { kind: "thread-conflict" as const };
        }
        records.set(record.operationId, {
          seriesOperationId: record.seriesOperationId,
          attemptGeneration: record.attemptGeneration,
          sourceThreadId: record.sourceThreadId,
          requestFingerprintSha256: record.requestFingerprintSha256,
          capturedAt: record.now,
          status: "active",
          leaseOwner: record.leaseOwner,
          leaseExpiresAt: record.leaseExpiresAt,
        });
        return { kind: "acquired" as const, capturedAt: record.now };
      },
      renew: async (record) => {
        const existing = records.get(record.operationId);
        if (
          existing?.status !== "active" ||
          existing.leaseOwner !== record.leaseOwner ||
          existing.leaseExpiresAt === undefined ||
          existing.leaseExpiresAt <= record.now
        ) {
          return false;
        }
        existing.leaseExpiresAt = record.leaseExpiresAt;
        return true;
      },
      bindSourceIdentity: async (record) => {
        const existing = records.get(record.operationId);
        if (
          existing?.status !== "active" ||
          existing.leaseOwner !== record.leaseOwner ||
          existing.leaseExpiresAt === undefined ||
          existing.leaseExpiresAt <= record.now ||
          (existing.sourceIdentity !== undefined &&
            (existing.sourceIdentity.sourceProjectId !== record.sourceIdentity.sourceProjectId ||
              existing.sourceIdentity.sourceOmpSessionId !==
                record.sourceIdentity.sourceOmpSessionId))
        ) {
          return false;
        }
        existing.sourceIdentity = record.sourceIdentity;
        return true;
      },
      getSourceIdentity: async (record) => {
        const existing = records.get(record.operationId);
        return existing?.sourceThreadId === record.sourceThreadId &&
          existing.requestFingerprintSha256 === record.requestFingerprintSha256
          ? existing.sourceIdentity
          : undefined;
      },
      bindAuthority: async (record) => {
        const existing = records.get(record.operationId);
        if (
          existing?.status !== "active" ||
          existing.leaseOwner !== record.leaseOwner ||
          existing.leaseExpiresAt === undefined ||
          existing.leaseExpiresAt <= record.now
        ) {
          return false;
        }
        const authority = existing.authority;
        if (
          authority &&
          (authority.lifecycleEpoch !== record.authority.lifecycleEpoch ||
            authority.grantId !== record.authority.grantId ||
            authority.sandboxId !== record.authority.sandboxId ||
            authority.sessionId !== record.authority.sessionId ||
            authority.payloadDigestSha256 !== record.authority.payloadDigestSha256 ||
            authority.archiveSha256 !== record.authority.archiveSha256 ||
            authority.transcriptSha256 !== record.authority.transcriptSha256 ||
            authority.ompBundleSha256 !== record.authority.ompBundleSha256 ||
            authority.t3MetadataSha256 !== record.authority.t3MetadataSha256)
        ) {
          return false;
        }
        existing.authority = record.authority;
        return true;
      },
      complete: async (record) => {
        const existing = records.get(record.operationId);
        if (
          existing?.status !== "active" ||
          existing.leaseOwner !== record.leaseOwner ||
          existing.sourceIdentity?.sourceProjectId !== record.receipt.source.projectId ||
          existing.sourceIdentity.sourceOmpSessionId !== record.receipt.source.ompSessionId ||
          existing.authority === undefined ||
          (existing.authority !== undefined &&
            (existing.authority.lifecycleEpoch !== record.receipt.binding.lifecycleEpoch ||
              existing.authority.sessionId !== record.receipt.sessionId ||
              existing.authority.payloadDigestSha256 !== record.receipt.payloadDigestSha256 ||
              existing.authority.archiveSha256 !== record.receipt.archiveSha256 ||
              existing.authority.transcriptSha256 !== record.receipt.transcriptSha256 ||
              existing.authority.ompBundleSha256 !== record.receipt.ompBundleSha256 ||
              existing.authority.t3MetadataSha256 !== record.receipt.t3MetadataSha256))
        ) {
          return false;
        }
        records.set(record.operationId, {
          sourceThreadId: record.sourceThreadId,
          requestFingerprintSha256: record.requestFingerprintSha256,
          capturedAt: existing.capturedAt,
          seriesOperationId: existing.seriesOperationId,
          attemptGeneration: existing.attemptGeneration,
          status: "completed",
          receipt: record.receipt,
          sourceIdentity: existing.sourceIdentity,
          authority: existing.authority,
        });
        return true;
      },
      reconcileCompleted: async (record) => {
        const existing = records.get(record.operationId);
        if (
          existing?.status === "completed" &&
          existing.sourceThreadId === record.sourceThreadId &&
          existing.requestFingerprintSha256 === record.requestFingerprintSha256 &&
          existing.receipt === record.receipt
        ) {
          return true;
        }
        if (
          existing?.status !== "active" ||
          existing.sourceThreadId !== record.sourceThreadId ||
          existing.requestFingerprintSha256 !== record.requestFingerprintSha256 ||
          existing.sourceIdentity?.sourceProjectId !== record.receipt.source.projectId ||
          existing.sourceIdentity.sourceOmpSessionId !== record.receipt.source.ompSessionId
        ) {
          return false;
        }
        if (
          existing.authority &&
          (existing.authority.lifecycleEpoch !== record.authorityLifecycleEpoch ||
            existing.authority.grantId !== record.authorityGrantId ||
            existing.authority.sandboxId !== record.authoritySandboxId ||
            existing.authority.sessionId !== record.authoritySessionId ||
            existing.authority.payloadDigestSha256 !== record.authorityPayloadDigestSha256 ||
            existing.authority.archiveSha256 !== record.authorityArchiveSha256 ||
            existing.authority.transcriptSha256 !== record.authorityTranscriptSha256 ||
            existing.authority.ompBundleSha256 !== record.authorityOmpBundleSha256 ||
            existing.authority.t3MetadataSha256 !== record.authorityT3MetadataSha256)
        ) {
          return false;
        }
        records.set(record.operationId, {
          sourceThreadId: record.sourceThreadId,
          requestFingerprintSha256: record.requestFingerprintSha256,
          capturedAt: existing.capturedAt,
          seriesOperationId: existing.seriesOperationId,
          attemptGeneration: existing.attemptGeneration,
          status: "completed",
          receipt: record.receipt,
          sourceIdentity: existing.sourceIdentity,
          authority: {
            lifecycleEpoch: record.authorityLifecycleEpoch,
            grantId: record.authorityGrantId,
            sandboxId: record.authoritySandboxId,
            sessionId: record.authoritySessionId,
            payloadDigestSha256: record.authorityPayloadDigestSha256,
            archiveSha256: record.authorityArchiveSha256,
            transcriptSha256: record.authorityTranscriptSha256,
            ompBundleSha256: record.authorityOmpBundleSha256,
            t3MetadataSha256: record.authorityT3MetadataSha256,
          },
        });
        return true;
      },
      abort: async (record) => {
        const existing = records.get(record.operationId);
        if (
          existing?.status === "aborted" &&
          existing.sourceThreadId === record.sourceThreadId &&
          existing.requestFingerprintSha256 === record.requestFingerprintSha256
        ) {
          return true;
        }
        if (
          existing?.status !== "active" ||
          existing.sourceThreadId !== record.sourceThreadId ||
          existing.requestFingerprintSha256 !== record.requestFingerprintSha256
        ) {
          return false;
        }
        if (
          existing.authority &&
          (existing.authority.lifecycleEpoch !== record.authorityLifecycleEpoch ||
            existing.authority.grantId !== record.authorityGrantId ||
            existing.authority.sandboxId !== record.authoritySandboxId ||
            existing.authority.sessionId !== record.authoritySessionId ||
            existing.authority.payloadDigestSha256 !== record.authorityPayloadDigestSha256 ||
            existing.authority.archiveSha256 !== record.authorityArchiveSha256 ||
            existing.authority.transcriptSha256 !== record.authorityTranscriptSha256 ||
            existing.authority.ompBundleSha256 !== record.authorityOmpBundleSha256 ||
            existing.authority.t3MetadataSha256 !== record.authorityT3MetadataSha256)
        ) {
          return false;
        }
        records.set(record.operationId, {
          sourceThreadId: record.sourceThreadId,
          requestFingerprintSha256: record.requestFingerprintSha256,
          capturedAt: existing.capturedAt,
          seriesOperationId: existing.seriesOperationId,
          attemptGeneration: existing.attemptGeneration,
          status: "aborted",
          ...(existing.sourceIdentity ? { sourceIdentity: existing.sourceIdentity } : {}),
          authority: {
            lifecycleEpoch: record.authorityLifecycleEpoch,
            grantId: record.authorityGrantId,
            sandboxId: record.authoritySandboxId,
            sessionId: record.authoritySessionId,
            payloadDigestSha256: record.authorityPayloadDigestSha256,
            archiveSha256: record.authorityArchiveSha256,
            transcriptSha256: record.authorityTranscriptSha256,
            ompBundleSha256: record.authorityOmpBundleSha256,
            t3MetadataSha256: record.authorityT3MetadataSha256,
          },
        });
        return true;
      },
      abortUnbound: async (record) => {
        const existing = records.get(record.operationId);
        if (
          existing?.status === "aborted" &&
          existing.sourceThreadId === record.sourceThreadId &&
          existing.requestFingerprintSha256 === record.requestFingerprintSha256 &&
          existing.authority === undefined
        ) {
          return true;
        }
        if (
          existing?.status !== "active" ||
          existing.sourceThreadId !== record.sourceThreadId ||
          existing.requestFingerprintSha256 !== record.requestFingerprintSha256 ||
          existing.authority !== undefined
        ) {
          return false;
        }
        records.set(record.operationId, {
          sourceThreadId: record.sourceThreadId,
          requestFingerprintSha256: record.requestFingerprintSha256,
          capturedAt: existing.capturedAt,
          seriesOperationId: existing.seriesOperationId,
          attemptGeneration: existing.attemptGeneration,
          status: "aborted",
          ...(existing.sourceIdentity ? { sourceIdentity: existing.sourceIdentity } : {}),
        });
        return true;
      },
      abandon: async (record) => {
        const existing = records.get(record.operationId);
        if (existing?.status === "active" && existing.leaseOwner === record.leaseOwner) {
          existing.leaseExpiresAt = record.now;
        }
      },
    } satisfies SourceTransferReceiptStore,
  };
}

function makeTestSource(
  options: Omit<
    Parameters<typeof makeIdempotentScaffoldSessionTransferSource>[0],
    "sourceEnvironmentId"
  >,
) {
  const execute = options.execute;
  return makeIdempotentScaffoldSessionTransferSource({
    sourceEnvironmentId,
    ...options,
    execute: (input, capture, journal) =>
      journal
        .bindSourceIdentity({
          sourceProjectId: receipt.source.projectId,
          sourceOmpSessionId: receipt.source.ompSessionId,
        })
        .pipe(Effect.andThen(execute(input, capture, journal))),
  });
}

describe("captureThenMigrateWithSourceRestore", () => {
  it("derives the bounded server operation id from the canonical source identity", () => {
    assert.strictEqual(
      startInput.operationId,
      "scaffold.session-transfer.operation.v1:f5189848c9391b0097ba95b0549a5784c3e7be5bb9b6c6f7828eacef320d98d2",
    );
    assert.match(startInput.operationId, /^[A-Za-z0-9._:-]+$/);
    assert.ok(startInput.operationId.length <= 160);
  });

  it("restarts the exact source thread with its unchanged OMP continuation", () => {
    const resumeCursor = {
      kind: "omp" as const,
      schemaVersion: 3 as const,
      sessionId: "omp-source",
      eventSequence: 41,
      acpSequence: 17,
    };
    const restore = makeSourceSessionRestorePlan({
      threadId: ThreadId.make(startInput.sourceThreadId),
      rootPath: "/workspace/source",
      modelSelection: {
        instanceId: ProviderInstanceId.make("omp-primary"),
        model: "openai/gpt-5.4",
      },
      resumeCursor,
      runtimeMode: "approval-required",
    });

    assert.strictEqual(restore.threadId, startInput.sourceThreadId);
    assert.strictEqual(restore.startInput.threadId, startInput.sourceThreadId);
    assert.strictEqual(restore.startInput.resumeCursor, resumeCursor);
    assert.strictEqual(restore.startInput.provider, "omp");
    assert.strictEqual(restore.startInput.providerInstanceId, "omp-primary");
  });

  it.effect("keeps the source stopped through migration and then restores it", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const result = yield* captureThenMigrateWithSourceRestore({
        stop: Effect.sync(() => calls.push("stop")).pipe(Effect.asVoid),
        capture: Effect.sync(() => {
          calls.push("capture");
          return "bundle";
        }),
        restart: Effect.sync(() => calls.push("restart")).pipe(Effect.asVoid),
        migrate: (bundle) =>
          Effect.sync(() => {
            calls.push(`migrate:${bundle}`);
            return "receipt";
          }),
      });

      assert.strictEqual(result, "receipt");
      assert.deepStrictEqual(calls, ["stop", "capture", "migrate:bundle", "restart"]);
    }),
  );

  it.effect("restarts the source when the Scaffold migration fails", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const error = yield* captureThenMigrateWithSourceRestore({
        stop: Effect.sync(() => calls.push("stop")).pipe(Effect.asVoid),
        capture: Effect.sync(() => {
          calls.push("capture");
          return "bundle";
        }),
        restart: Effect.sync(() => calls.push("restart")).pipe(Effect.asVoid),
        migrate: (bundle) =>
          Effect.sync(() => calls.push(`migrate:${bundle}`)).pipe(
            Effect.andThen(Effect.fail("migration failed")),
          ),
      }).pipe(Effect.flip);
      assert.strictEqual(error, "migration failed");
      assert.deepStrictEqual(calls, ["stop", "capture", "migrate:bundle", "restart"]);
    }),
  );

  it.effect("restarts the source when the cold export fails", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const error = yield* captureThenMigrateWithSourceRestore({
        stop: Effect.sync(() => calls.push("stop")).pipe(Effect.asVoid),
        capture: Effect.fail("capture failed"),
        restart: Effect.sync(() => calls.push("restart")).pipe(Effect.asVoid),
        migrate: () => Effect.succeed("unreachable"),
      }).pipe(Effect.flip);
      assert.strictEqual(error, "capture failed");
      assert.deepStrictEqual(calls, ["stop", "restart"]);
    }),
  );

  it.effect("binds transcript activity flushed by stop before capture", () =>
    Effect.gen(function* () {
      const activities: Array<never> = [];
      const expectedActivity = {
        id: "event-final" as never,
        tone: "tool" as const,
        kind: "tool.completed",
        summary: "Final tool output",
        payload: { rawOutput: "flushed" },
        turnId: null,
        sequence: 9,
        createdAt: "2026-07-26T00:00:01.000Z",
      };
      const captured = yield* captureThenMigrateWithSourceRestore({
        stop: Effect.sync(() => activities.push(expectedActivity as never)).pipe(Effect.asVoid),
        capture: Effect.sync(() => canonicalTranscriptSha256({ messages: [], activities })),
        restart: Effect.void,
        migrate: Effect.succeed,
      });
      assert.strictEqual(
        captured,
        canonicalTranscriptSha256({ messages: [], activities: [expectedActivity] }),
      );
    }),
  );

  it.effect("coalesces concurrent and completed duplicate operations", () =>
    Effect.gen(function* () {
      let executions = 0;
      const { store } = memoryStore();
      const source = makeTestSource({
        store,
        execute: (_input, _capture, journal) =>
          journal.bind(authorityBinding).pipe(
            Effect.andThen(
              Effect.sync(() => {
                executions += 1;
                return receipt;
              }),
            ),
          ),
      });

      const [first, concurrent] = yield* Effect.all(
        [source.start(startInput), source.start(startInput)],
        { concurrency: "unbounded" },
      );
      const completed = yield* source.start(startInput);

      assert.deepStrictEqual(concurrent, first);
      assert.deepStrictEqual(completed, first);
      assert.strictEqual(executions, 1);
    }),
  );

  it.effect("keeps an in-process transfer pending without revoking pre-bind authority", () =>
    Effect.gen(function* () {
      const { store } = memoryStore();
      const release = yield* Deferred.make<void>();
      let reconciliations = 0;
      const source = makeTestSource({
        store,
        execute: (_input, _capture, journal) =>
          Deferred.await(release).pipe(
            Effect.andThen(journal.bind(authorityBinding)),
            Effect.as(receipt),
          ),
        authority: {
          reconcile: async () => {
            reconciliations += 1;
            throw new Error("destination authority must not be consulted while source is running");
          },
          abort: async () => {
            throw new Error("not used");
          },
        },
      });

      const running = yield* source
        .start(startInput)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      const pending = yield* source.reconcile(startInput).pipe(Effect.flip);
      assert.strictEqual(pending.code, "workspace_migration_source_reconciliation_pending");
      assert.strictEqual(reconciliations, 0);

      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(yield* Fiber.join(running), receipt);
      assert.deepStrictEqual(yield* source.reconcile(startInput), receipt);
      assert.strictEqual(reconciliations, 0);
    }),
  );

  for (const mutation of receiptIdentityMutations) {
    it.effect(`rejects a direct receipt that mutates the ${mutation.name} identity`, () =>
      Effect.gen(function* () {
        const { records, store } = memoryStore();
        const source = makeTestSource({
          store,
          execute: (_input, _capture, journal) =>
            journal.bind(authorityBinding).pipe(Effect.as(mutation.receipt())),
        });

        const error = yield* source.start(startInput).pipe(Effect.flip);
        assert.strictEqual(error.code, "workspace_migration_source_authority_mismatch");
        assert.strictEqual(records.get(startInput.operationId)?.status, "active");
      }),
    );
  }

  it.effect("rejects a client-supplied operation id mismatch before acquiring or executing", () =>
    Effect.gen(function* () {
      const { records, store } = memoryStore();
      let executions = 0;
      const source = makeTestSource({
        store,
        execute: (_input, _capture, journal) => {
          executions += 1;
          return journal.bind(authorityBinding).pipe(Effect.as(receipt));
        },
      });
      const conflict = decodeStartInput({
        ...encodeStartInput(startInput),
        operationId: "client-chosen-operation",
      });
      const error = yield* source.start(conflict).pipe(Effect.flip);
      assert.strictEqual(error.code, "workspace_migration_source_operation_id_mismatch");
      assert.strictEqual(executions, 0);
      assert.strictEqual(records.size, 0);
    }),
  );

  it.effect("does not re-execute an ambiguous failed operation", () =>
    Effect.gen(function* () {
      let executions = 0;
      const { store } = memoryStore();
      const source = makeTestSource({
        store,
        execute: () => {
          executions += 1;
          return Effect.fail(
            new WorkspaceMigrationImportError({
              code: "first_attempt_failed",
              detail: "First attempt failed.",
            }),
          );
        },
      });

      yield* source.start(startInput).pipe(Effect.flip);
      yield* Effect.yieldNow;
      const retryError = yield* source.start(startInput).pipe(Effect.flip);
      assert.strictEqual(retryError.code, "workspace_migration_source_reconciliation_unavailable");
      assert.strictEqual(executions, 1);
    }),
  );

  it.effect(
    "settles an authenticated pre-bind revocation after a crash before grant creation",
    () =>
      Effect.gen(function* () {
        const { records, store } = memoryStore();
        const fingerprint = sourceTransferRequestFingerprint(startInput);
        const source = makeTestSource({
          store,
          execute: () =>
            Effect.fail(
              new WorkspaceMigrationImportError({
                code: "simulated_prebind_crash",
                detail: "The process stopped before a destination grant was created.",
              }),
            ),
          authority: {
            reconcile: async () => ({
              state: "noncommittable",
              operationId: startInput.operationId,
              requestFingerprintSha256: fingerprint,
              proof: {
                version: "scaffold.workspace_migration.noncommittable.v1",
                scope: "prebind",
                operationId: startInput.operationId,
                requestFingerprintSha256: fingerprint,
                revokedAt: "2026-07-26T00:00:01.000Z",
                reason: "operation_absent_and_revoked",
              },
            }),
            abort: async () => ({
              state: "noncommittable",
              operationId: startInput.operationId,
              requestFingerprintSha256: fingerprint,
              proof: {
                version: "scaffold.workspace_migration.noncommittable.v1",
                scope: "prebind",
                operationId: startInput.operationId,
                requestFingerprintSha256: fingerprint,
                revokedAt: "2026-07-26T00:00:01.000Z",
                reason: "operation_absent_and_revoked",
              },
            }),
          },
        });

        yield* source.start(startInput).pipe(Effect.flip);
        yield* source.abort(startInput);
        assert.strictEqual(records.get(startInput.operationId)?.status, "aborted");
      }),
  );

  it.effect("reuses a durable receipt after service recreation", () =>
    Effect.gen(function* () {
      let executions = 0;
      const { store } = memoryStore();
      const first = makeTestSource({
        store,
        execute: (_input, _capture, journal) => {
          executions += 1;
          return journal.bind(authorityBinding).pipe(Effect.as(receipt));
        },
      });
      yield* first.start(startInput);

      const recreated = makeTestSource({
        store,
        execute: () => {
          executions += 1;
          return Effect.succeed(receipt);
        },
      });
      const recovered = yield* recreated.start(startInput);
      assert.deepStrictEqual(recovered, receipt);
      assert.strictEqual(executions, 1);
    }),
  );

  it.effect("rejects a distinct operation while the thread lease is active", () =>
    Effect.gen(function* () {
      const { store } = memoryStore();
      const release = yield* Deferred.make<void>();
      const acquired = yield* Deferred.make<void>();
      const first = makeTestSource({
        store,
        leaseOwner: () => "owner-1",
        execute: (_input, _capture, journal) =>
          journal
            .bind(authorityBinding)
            .pipe(
              Effect.andThen(Deferred.succeed(acquired, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as(receipt),
            ),
      });
      const firstFiber = yield* first.start(startInput).pipe(Effect.forkScoped);
      yield* Deferred.await(acquired);

      const secondInput = decodeStartInput({
        ...encodeStartInput(startInput),
        deployment: "production",
        operationId: sourceTransferOperationId({
          sourceEnvironmentId,
          sourceThreadId: startInput.sourceThreadId,
          deployment: "production",
        }),
      });
      const recreated = makeTestSource({
        store,
        leaseOwner: () => "owner-2",
        execute: () => Effect.succeed(receipt),
      });
      const error = yield* recreated.start(secondInput).pipe(Effect.flip);
      assert.strictEqual(error.code, "workspace_migration_source_transfer_in_progress");

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(firstFiber);
    }),
  );

  it.effect("reconciles a completion after crashing before the source authority bind", () =>
    Effect.gen(function* () {
      let now = DateTime.makeUnsafe("2026-07-26T00:00:00.000Z").epochMilliseconds;
      let executions = 0;
      const { store } = memoryStore();
      const fingerprint = sourceTransferRequestFingerprint(startInput);
      yield* Effect.promise(() =>
        store.acquire({
          operationId: startInput.operationId,
          sourceThreadId: startInput.sourceThreadId,
          requestFingerprintSha256: sourceTransferRequestFingerprint(startInput),
          leaseOwner: "stale-owner",
          now: DateTime.formatIso(DateTime.makeUnsafe(now)),
          leaseExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 2 * 60 * 1000)),
        }),
      );
      yield* Effect.promise(() =>
        store.bindSourceIdentity({
          operationId: startInput.operationId,
          sourceThreadId: startInput.sourceThreadId,
          requestFingerprintSha256: fingerprint,
          leaseOwner: "stale-owner",
          now: DateTime.formatIso(DateTime.makeUnsafe(now)),
          sourceIdentity: {
            sourceProjectId: receipt.source.projectId,
            sourceOmpSessionId: receipt.source.ompSessionId,
          },
        }),
      );
      now += 3 * 60 * 1000;
      const recovered = makeTestSource({
        store,
        now: () => now,
        leaseOwner: () => "recovered-owner",
        execute: () => {
          executions += 1;
          return Effect.succeed(receipt);
        },
        authority: {
          reconcile: async () => ({
            state: "completed",
            operationId: startInput.operationId,
            requestFingerprintSha256: fingerprint,
            ...authorityBinding,
            lifecycleEpoch: receipt.binding.lifecycleEpoch,
            grantId: "grant-7",
            sandboxId: "sandbox-7",
            sessionId: receipt.sessionId,
            payloadDigestSha256: receipt.payloadDigestSha256,
            receipt,
          }),
          abort: async () => ({
            state: "pending",
            operationId: startInput.operationId,
            requestFingerprintSha256: fingerprint,
            ...authorityBinding,
            lifecycleEpoch: receipt.binding.lifecycleEpoch,
            grantId: "grant-7",
            sandboxId: "sandbox-7",
            sessionId: receipt.sessionId,
            payloadDigestSha256: receipt.payloadDigestSha256,
          }),
        },
      });
      assert.deepStrictEqual(yield* recovered.start(startInput), receipt);
      assert.strictEqual(executions, 0);
    }),
  );

  it.effect("automatically revokes an expired pre-bind failure and starts the next attempt", () =>
    Effect.gen(function* () {
      let now = DateTime.makeUnsafe("2026-07-26T00:00:00.000Z").epochMilliseconds;
      const { records, store } = memoryStore();
      let executions = 0;
      const source = makeTestSource({
        store,
        now: () => now,
        execute: (input, _capture, journal) => {
          executions += 1;
          if (executions === 1) {
            return Effect.fail(
              new WorkspaceMigrationImportError({
                code: "simulated_prebind_failure",
                detail: "The process failed before the proposal was durably bound.",
              }),
            );
          }
          return journal
            .bind(authorityBinding)
            .pipe(Effect.as(receiptForOperation(input.operationId)));
        },
        authority: {
          reconcile: async () => ({
            state: "pending",
            operationId: startInput.operationId,
            requestFingerprintSha256: sourceTransferRequestFingerprint(startInput),
          }),
          abort: async (input) => ({
            state: "noncommittable",
            operationId: input.operationId,
            requestFingerprintSha256: input.requestFingerprintSha256,
            proof: {
              version: "scaffold.workspace_migration.noncommittable.v1",
              scope: "prebind",
              operationId: input.operationId,
              requestFingerprintSha256: input.requestFingerprintSha256,
              revokedAt: "2026-07-26T00:03:00.000Z",
              reason: "expired_prebind_attempt",
            },
          }),
        },
      });

      yield* source.start(startInput).pipe(Effect.flip);
      now += 3 * 60 * 1000;
      const recovered = yield* source.start(startInput);
      const attempt2 = `${startInput.operationId}:attempt:2`;
      assert.strictEqual(recovered.operationId, attempt2);
      assert.strictEqual(executions, 2);
      assert.strictEqual(records.get(startInput.operationId)?.status, "aborted");
      assert.strictEqual(records.get(attempt2)?.status, "completed");
    }),
  );

  it.effect("applies bound revocation proof after crashing before the source authority bind", () =>
    Effect.gen(function* () {
      const { records, store } = memoryStore();
      const fingerprint = sourceTransferRequestFingerprint(startInput);
      yield* Effect.promise(() =>
        store.acquire({
          operationId: startInput.operationId,
          sourceThreadId: startInput.sourceThreadId,
          requestFingerprintSha256: fingerprint,
          leaseOwner: "crashed-owner",
          now: "2026-07-26T00:00:00.000Z",
          leaseExpiresAt: "2026-07-26T00:02:00.000Z",
        }),
      );
      const source = makeTestSource({
        store,
        execute: () => Effect.succeed(receipt),
        authority: {
          reconcile: async () => ({
            state: "pending",
            operationId: startInput.operationId,
            requestFingerprintSha256: fingerprint,
            ...authorityBinding,
          }),
          abort: async () => ({
            state: "noncommittable",
            operationId: startInput.operationId,
            requestFingerprintSha256: fingerprint,
            ...authorityBinding,
            proof: {
              version: "scaffold.workspace_migration.noncommittable.v1",
              scope: "bound",
              operationId: startInput.operationId,
              requestFingerprintSha256: fingerprint,
              sessionId: authorityBinding.sessionId,
              sandboxId: authorityBinding.sandboxId,
              lifecycleEpoch: authorityBinding.lifecycleEpoch,
              grantId: authorityBinding.grantId,
              revokedAt: "2026-07-26T00:01:00.000Z",
              reason: "operator_abort",
            },
          }),
        },
      });

      yield* source.abort(startInput);
      assert.strictEqual(records.get(startInput.operationId)?.status, "aborted");
      assert.deepStrictEqual(records.get(startInput.operationId)?.authority, authorityBinding);
    }),
  );

  it.effect("keeps an ambiguous operation fenced while destination authority is pending", () =>
    Effect.gen(function* () {
      const { records, store } = memoryStore();
      const fingerprint = sourceTransferRequestFingerprint(startInput);
      const source = makeTestSource({
        store,
        execute: (_input, _capture, journal) =>
          journal.bind(authorityBinding).pipe(
            Effect.andThen(
              Effect.fail(
                new WorkspaceMigrationImportError({
                  code: "simulated_lost_response",
                  detail: "Destination outcome is ambiguous.",
                }),
              ),
            ),
          ),
        authority: {
          reconcile: async () => ({
            state: "pending",
            operationId: startInput.operationId,
            requestFingerprintSha256: fingerprint,
            ...authorityBinding,
            lifecycleEpoch: receipt.binding.lifecycleEpoch,
            grantId: "grant-7",
            sandboxId: "sandbox-7",
            sessionId: receipt.sessionId,
            payloadDigestSha256: receipt.payloadDigestSha256,
          }),
          abort: async () => ({
            state: "pending",
            operationId: startInput.operationId,
            requestFingerprintSha256: fingerprint,
            ...authorityBinding,
            lifecycleEpoch: receipt.binding.lifecycleEpoch,
            grantId: "grant-7",
            sandboxId: "sandbox-7",
            sessionId: receipt.sessionId,
            payloadDigestSha256: receipt.payloadDigestSha256,
          }),
        },
      });

      yield* source.start(startInput).pipe(Effect.flip);
      const error = yield* source.reconcile(startInput).pipe(Effect.flip);
      assert.strictEqual(error.code, "workspace_migration_source_reconciliation_pending");
      assert.strictEqual(records.get(startInput.operationId)?.status, "active");
    }),
  );

  it.effect("settles an authoritative completion without reusing destination identities", () =>
    Effect.gen(function* () {
      const { records, store } = memoryStore();
      const fingerprint = sourceTransferRequestFingerprint(startInput);
      const source = makeTestSource({
        store,
        execute: (_input, _capture, journal) =>
          journal.bind(authorityBinding).pipe(
            Effect.andThen(
              Effect.fail(
                new WorkspaceMigrationImportError({
                  code: "simulated_lost_response",
                  detail: "Destination outcome is ambiguous.",
                }),
              ),
            ),
          ),
        authority: {
          reconcile: async () => ({
            state: "completed",
            operationId: startInput.operationId,
            requestFingerprintSha256: fingerprint,
            ...authorityBinding,
            lifecycleEpoch: receipt.binding.lifecycleEpoch,
            grantId: "grant-7",
            sandboxId: "sandbox-7",
            sessionId: receipt.sessionId,
            payloadDigestSha256: receipt.payloadDigestSha256,
            receipt,
          }),
          abort: async () => ({
            state: "pending",
            operationId: startInput.operationId,
            requestFingerprintSha256: fingerprint,
            ...authorityBinding,
            lifecycleEpoch: receipt.binding.lifecycleEpoch,
            grantId: "grant-7",
            sandboxId: "sandbox-7",
            sessionId: receipt.sessionId,
            payloadDigestSha256: receipt.payloadDigestSha256,
          }),
        },
      });

      yield* source.start(startInput).pipe(Effect.flip);
      assert.deepStrictEqual(yield* source.reconcile(startInput), receipt);
      assert.strictEqual(records.get(startInput.operationId)?.status, "completed");
      assert.notStrictEqual(receipt.destination.threadId, startInput.sourceThreadId);
    }),
  );

  for (const mutation of receiptIdentityMutations) {
    it.effect(`rejects a reconciled receipt that mutates the ${mutation.name} identity`, () =>
      Effect.gen(function* () {
        const { records, store } = memoryStore();
        const fingerprint = sourceTransferRequestFingerprint(startInput);
        const mutatedReceipt = mutation.receipt();
        const source = makeTestSource({
          store,
          execute: (_input, _capture, journal) =>
            journal.bind(authorityBinding).pipe(
              Effect.andThen(
                Effect.fail(
                  new WorkspaceMigrationImportError({
                    code: "simulated_lost_response",
                    detail: "Destination outcome is ambiguous.",
                  }),
                ),
              ),
            ),
          authority: {
            reconcile: async () => ({
              state: "completed",
              operationId: startInput.operationId,
              requestFingerprintSha256: fingerprint,
              ...authorityBinding,
              receipt: mutatedReceipt,
            }),
            abort: async () => ({
              state: "pending",
              operationId: startInput.operationId,
              requestFingerprintSha256: fingerprint,
              ...authorityBinding,
            }),
          },
        });

        yield* source.start(startInput).pipe(Effect.flip);
        const error = yield* source.reconcile(startInput).pipe(Effect.flip);
        assert.strictEqual(error.code, "workspace_migration_source_authority_mismatch");
        assert.strictEqual(records.get(startInput.operationId)?.status, "active");
      }),
    );
  }

  it.effect("rejects a completion proof with mismatched destination digests", () =>
    Effect.gen(function* () {
      const { records, store } = memoryStore();
      const fingerprint = sourceTransferRequestFingerprint(startInput);
      const source = makeTestSource({
        store,
        execute: (_input, _capture, journal) =>
          journal.bind(authorityBinding).pipe(
            Effect.andThen(
              Effect.fail(
                new WorkspaceMigrationImportError({
                  code: "simulated_lost_response",
                  detail: "Destination outcome is ambiguous.",
                }),
              ),
            ),
          ),
        authority: {
          reconcile: async () => ({
            state: "completed",
            operationId: startInput.operationId,
            requestFingerprintSha256: fingerprint,
            ...authorityBinding,
            archiveSha256: "f".repeat(64),
            receipt,
          }),
          abort: async () => ({
            state: "pending",
            operationId: startInput.operationId,
            requestFingerprintSha256: fingerprint,
            ...authorityBinding,
          }),
        },
      });

      yield* source.start(startInput).pipe(Effect.flip);
      const error = yield* source.reconcile(startInput).pipe(Effect.flip);
      assert.strictEqual(error.code, "workspace_migration_source_authority_mismatch");
      assert.strictEqual(records.get(startInput.operationId)?.status, "active");
    }),
  );

  it.effect("aborts only from noncommittable proof and rejects a stale worker completion", () =>
    Effect.gen(function* () {
      const { records, store } = memoryStore();
      const fingerprint = sourceTransferRequestFingerprint(startInput);
      const staleFence = {
        operationId: startInput.operationId,
        sourceThreadId: startInput.sourceThreadId,
        requestFingerprintSha256: fingerprint,
        leaseOwner: "stale-owner",
      } as const;
      yield* Effect.promise(() =>
        store.acquire({
          ...staleFence,
          now: "2026-07-26T00:00:00.000Z",
          leaseExpiresAt: "2099-07-26T00:00:00.000Z",
        }),
      );
      yield* Effect.promise(() =>
        store.bindAuthority({
          ...staleFence,
          now: "2026-07-26T00:00:00.000Z",
          authority: authorityBinding,
        }),
      );
      let retriedOperationId: string | undefined;
      const source = makeTestSource({
        store,
        execute: (input, _capture, journal) => {
          retriedOperationId = input.operationId;
          return journal.bind(authorityBinding).pipe(
            Effect.as(
              decodeReceipt({
                ...encodedReceipt,
                operationId: input.operationId,
              }),
            ),
          );
        },
        authority: {
          reconcile: async () => ({
            state: "pending",
            operationId: startInput.operationId,
            requestFingerprintSha256: fingerprint,
            ...authorityBinding,
            lifecycleEpoch: receipt.binding.lifecycleEpoch,
            grantId: "grant-7",
            sandboxId: "sandbox-7",
            sessionId: receipt.sessionId,
            payloadDigestSha256: receipt.payloadDigestSha256,
          }),
          abort: async () => ({
            state: "noncommittable",
            operationId: startInput.operationId,
            requestFingerprintSha256: fingerprint,
            ...authorityBinding,
            lifecycleEpoch: receipt.binding.lifecycleEpoch,
            grantId: "grant-7",
            sandboxId: "sandbox-7",
            sessionId: receipt.sessionId,
            payloadDigestSha256: receipt.payloadDigestSha256,
            proof: {
              version: "scaffold.workspace_migration.noncommittable.v1",
              scope: "bound",
              operationId: startInput.operationId,
              requestFingerprintSha256: fingerprint,
              sessionId: authorityBinding.sessionId,
              sandboxId: authorityBinding.sandboxId,
              lifecycleEpoch: authorityBinding.lifecycleEpoch,
              grantId: authorityBinding.grantId,
              revokedAt: "2026-07-26T00:00:01.000Z",
              reason: "user_aborted",
            },
          }),
        },
      });

      yield* source.abort(startInput);
      assert.strictEqual(records.get(startInput.operationId)?.status, "aborted");
      assert.isFalse(
        yield* Effect.promise(() =>
          store.complete({
            ...staleFence,
            now: "2026-07-26T00:00:01.000Z",
            receipt,
          }),
        ),
      );
      const retried = yield* source.start(startInput);
      assert.strictEqual(retriedOperationId, `${startInput.operationId}:attempt:2`);
      assert.strictEqual(retried.operationId, retriedOperationId);
      assert.strictEqual(records.get(retriedOperationId ?? "")?.status, "completed");
    }),
  );

  it.effect("concurrent clicks after abort converge on one server-owned next attempt", () =>
    Effect.gen(function* () {
      const { records, store } = memoryStore();
      const fingerprint = sourceTransferRequestFingerprint(startInput);
      yield* Effect.promise(() =>
        store.acquire({
          operationId: startInput.operationId,
          seriesOperationId: startInput.operationId,
          attemptGeneration: 1,
          sourceThreadId: startInput.sourceThreadId,
          requestFingerprintSha256: fingerprint,
          leaseOwner: "owner-attempt-1",
          now: "2026-07-26T00:00:00.000Z",
          leaseExpiresAt: "2026-07-26T00:02:00.000Z",
        }),
      );
      yield* Effect.promise(() =>
        store.abortUnbound({
          operationId: startInput.operationId,
          sourceThreadId: startInput.sourceThreadId,
          requestFingerprintSha256: fingerprint,
          now: "2026-07-26T00:00:01.000Z",
          authorityProofJson: "attempt-1-revoked",
        }),
      );
      let executions = 0;
      const source = makeTestSource({
        store,
        execute: (input, _capture, journal) => {
          executions += 1;
          return journal
            .bind(authorityBinding)
            .pipe(Effect.as(receiptForOperation(input.operationId)));
        },
      });

      const [left, right] = yield* Effect.all(
        [source.start(startInput), source.start(startInput)],
        { concurrency: "unbounded" },
      );
      const attempt2 = `${startInput.operationId}:attempt:2`;
      assert.strictEqual(left.operationId, attempt2);
      assert.strictEqual(right.operationId, attempt2);
      assert.strictEqual(executions, 1);
      assert.strictEqual(records.get(attempt2)?.attemptGeneration, 2);
      assert.strictEqual(records.get(attempt2)?.status, "completed");
    }),
  );

  it.effect("rejects a stale prior-attempt proof against the next active generation", () =>
    Effect.gen(function* () {
      const { records, store } = memoryStore();
      const fingerprint = sourceTransferRequestFingerprint(startInput);
      yield* Effect.promise(() =>
        store.acquire({
          operationId: startInput.operationId,
          seriesOperationId: startInput.operationId,
          attemptGeneration: 1,
          sourceThreadId: startInput.sourceThreadId,
          requestFingerprintSha256: fingerprint,
          leaseOwner: "owner-attempt-1",
          now: "2026-07-26T00:00:00.000Z",
          leaseExpiresAt: "2026-07-26T00:02:00.000Z",
        }),
      );
      yield* Effect.promise(() =>
        store.abortUnbound({
          operationId: startInput.operationId,
          sourceThreadId: startInput.sourceThreadId,
          requestFingerprintSha256: fingerprint,
          now: "2026-07-26T00:00:01.000Z",
          authorityProofJson: "attempt-1-revoked",
        }),
      );
      const attempt2 = `${startInput.operationId}:attempt:2`;
      const source = makeTestSource({
        store,
        execute: (_input, _capture, journal) =>
          journal.bind(authorityBinding).pipe(
            Effect.andThen(
              Effect.fail(
                new WorkspaceMigrationImportError({
                  code: "simulated_lost_response",
                  detail: "Attempt 2 remains ambiguous.",
                }),
              ),
            ),
          ),
        authority: {
          reconcile: async () => ({
            state: "pending",
            operationId: startInput.operationId,
            requestFingerprintSha256: fingerprint,
          }),
          abort: async () => ({
            state: "noncommittable",
            operationId: startInput.operationId,
            requestFingerprintSha256: fingerprint,
            proof: {
              version: "scaffold.workspace_migration.noncommittable.v1",
              scope: "prebind",
              operationId: startInput.operationId,
              requestFingerprintSha256: fingerprint,
              revokedAt: "2026-07-26T00:00:01.000Z",
              reason: "attempt-1-only",
            },
          }),
        },
      });

      yield* source.start(startInput).pipe(Effect.flip);
      const error = yield* source.abort(startInput).pipe(Effect.flip);
      assert.strictEqual(error.code, "workspace_migration_source_authority_mismatch");
      assert.strictEqual(records.get(attempt2)?.status, "active");
    }),
  );
});
