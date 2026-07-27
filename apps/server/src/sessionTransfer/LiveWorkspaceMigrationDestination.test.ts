// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
  SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
  type ProviderRuntimeEventEnvelope,
  ProviderInstanceId,
  RuntimeSessionId,
  ScaffoldWorkspaceMigrationImportInput,
  SessionTransferSource,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { makeOmpEventId, parseOmpResume } from "../provider/Layers/OmpAdapter.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  awaitWorkspaceMigrationProjection,
  buildWorkspaceMigrationDestinationPlan,
  isWorkspaceMigrationDestinationCommitted,
  makeLiveWorkspaceMigrationDestination,
  type WorkspaceMigrationCommitProof,
} from "./LiveWorkspaceMigrationDestination.ts";
import { canonicalTranscriptSha256 } from "./CanonicalTranscript.ts";

const decodeSessionTransferSource = Schema.decodeUnknownSync(SessionTransferSource);
const decodeImportInput = Schema.decodeUnknownSync(ScaffoldWorkspaceMigrationImportInput);
const encodeImportInput = Schema.encodeSync(ScaffoldWorkspaceMigrationImportInput);
const emptyTranscriptSha256 = canonicalTranscriptSha256({ messages: [], activities: [] });
const destinationOmpSessionId = "9f391692-d981-7270-a139-ae38d99f65a6";

function transferFixture(sourceEventSequence = 91) {
  const source = decodeSessionTransferSource({
    environmentId: "source-env",
    projectId: "source-project",
    threadId: "source-thread",
    rootPath: "/workspace",
    title: "Transfer me",
    modelSelection: {
      instanceId: "omp",
      model: "openai/gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    continuation: {
      provider: "omp",
      sessionId: "omp-private-session",
      eventSequence: sourceEventSequence,
      acpSequence: 37,
    },
    capturedAt: "2026-07-26T00:00:00.000Z",
    transcriptSha256: emptyTranscriptSha256,
  });
  const request = decodeImportInput({
    version: "scaffold.t3_workspace_migration.import.v1",
    operationId: "operation-1",
    requestFingerprintSha256: "e".repeat(64),
    payloadDigestSha256: "a".repeat(64),
    authority: {
      version: "scaffold.workspace_migration.import_authority.v1",
      authorityId: `wma_${"a".repeat(32)}`,
      grantId: "wmg_test",
      secret: "test-secret",
      sandboxId: "sandbox-test",
      sessionId: "session-test",
      lifecycleEpoch: 1,
      operationId: "operation-1",
      payloadDigestSha256: "a".repeat(64),
      archiveSha256: "d".repeat(64),
      transcriptSha256: emptyTranscriptSha256,
      ompBundleSha256: "b".repeat(64),
      t3MetadataSha256: "c".repeat(64),
      requestFingerprintSha256: "e".repeat(64),
      processingDeadlineAt: "2026-07-26T00:10:00.000Z",
    },
    payload: {
      version: "scaffold.workspace_migration.payload.v1",
      operationId: "operation-1",
      source: {
        environmentId: source.environmentId,
        projectId: source.projectId,
        threadId: source.threadId,
        globalSessionId: "sf:source-env:source-thread",
        ompSessionId: "omp-private-session",
        model: source.modelSelection.model,
        effort: "high",
        capturedAt: source.capturedAt,
        transcriptSha256: source.transcriptSha256,
      },
      ompBundle: {
        path: ".__scaffold_workspace_migration__/omp-session.zip",
        bytes: 10,
        sha256: "b".repeat(64),
      },
      ompExport: {
        version: 1,
        sessionId: destinationOmpSessionId,
        sourceChecksum: "e".repeat(64),
        files: [],
      },
      t3Metadata: {
        path: ".__scaffold_workspace_migration__/t3-metadata.json",
        bytes: 10,
        sha256: "c".repeat(64),
      },
      credentialExclusions: [...SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1],
      unsupportedFilesystemCases: [...SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1],
      digestSha256: "a".repeat(64),
    },
    source: {
      environmentId: source.environmentId,
      projectId: source.projectId,
      threadId: source.threadId,
      globalSessionId: "sf:source-env:source-thread",
      ompSessionId: "omp-private-session",
      title: source.title,
      model: source.modelSelection.model,
      effort: "high",
      capturedAt: source.capturedAt,
      transcriptSha256: source.transcriptSha256,
    },
    ompBundlePath: "/runtime/workspace-migrations/op/omp-session.zip",
    ompBundleSha256: "b".repeat(64),
    ompBundleBytes: 10,
    t3MetadataPath: "/runtime/workspace-migrations/op/t3-metadata.json",
    t3MetadataSha256: "c".repeat(64),
    t3MetadataBytes: 10,
    workspace: {
      rootDir: "/workspace",
      archiveSha256: "d".repeat(64),
      files: [],
      tombstones: [],
      symlinks: [],
    },
  });
  return { request, source };
}

function committedProof(
  overrides: {
    readonly status?: string;
    readonly acpSequence?: number;
    readonly snapshotSequence?: number;
    readonly receipt?: boolean;
    readonly eventSequence?: number;
    readonly transcriptMismatch?: boolean;
    readonly interactionMode?: "default" | "plan";
  } = {},
): WorkspaceMigrationCommitProof {
  const eventSequence = overrides.eventSequence ?? 9;
  return {
    snapshot: {
      snapshotSequence: overrides.snapshotSequence ?? 12,
      thread: {
        projectId: "destination-project",
        modelSelection: {
          instanceId: "omp" as never,
          model: "openai/gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        runtimeMode: "full-access",
        interactionMode: overrides.interactionMode ?? "default",
        session: { status: overrides.status ?? "ready", runtimeMode: "full-access" },
        messages: overrides.transcriptMismatch
          ? [
              {
                id: "message-mismatch" as never,
                role: "assistant",
                text: "different",
                attachments: [],
                turnId: null,
                streaming: false,
                createdAt: "2026-07-26T00:00:00.000Z",
                updatedAt: "2026-07-26T00:00:00.000Z",
              },
            ]
          : [],
        activities: [],
      },
    },
    binding: {
      threadId: "destination-thread" as never,
      provider: "omp" as never,
      providerInstanceId: "omp" as never,
      status: "running",
      runtimeMode: "full-access",
      resumeCursor: {
        schemaVersion: 3,
        sessionId: destinationOmpSessionId,
        eventSequence,
        acpSequence: overrides.acpSequence ?? 8,
      },
      runtimePayload: {
        canonicalSourceSequence: eventSequence,
        canonicalEventId: makeOmpEventId(destinationOmpSessionId, eventSequence),
      },
    },
    receipt:
      overrides.receipt === false
        ? undefined
        : {
            commandId: `provider:destination-env:destination-thread:${encodeURIComponent(
              makeOmpEventId(destinationOmpSessionId, eventSequence),
            )}:thread-session-set:0`,
            status: "accepted",
            aggregateKind: "thread",
            aggregateId: "destination-thread",
            resultSequence: 10,
          },
  };
}

const expectedCommit = {
  projectId: "destination-project",
  threadId: "destination-thread",
  environmentId: "destination-env",
  ompSessionId: destinationOmpSessionId,
  importedAcpSequence: 8,
  transcriptSha256: emptyTranscriptSha256,
  modelSelection: {
    instanceId: "omp" as never,
    model: "openai/gpt-5.6-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
};

describe("buildWorkspaceMigrationDestinationPlan", () => {
  it("creates deterministic fresh destination identities and loads copied OMP content from zero cursors", () => {
    const { request, source } = transferFixture();

    const plan = buildWorkspaceMigrationDestinationPlan({
      request,
      source,
      destinationEnvironmentId: EnvironmentId.make("destination-env"),
      importedOmpSessionId: destinationOmpSessionId,
    });

    expect(plan.threadCommand.modelSelection).toEqual(source.modelSelection);
    expect(plan.binding.resumeCursor).toEqual({
      schemaVersion: 3,
      sessionId: destinationOmpSessionId,
      eventSequence: 0,
      acpSequence: 0,
    });
    expect(plan.startInput.resumeCursor).toEqual(plan.binding.resumeCursor);
    expect(plan.result).toEqual(
      expect.objectContaining({
        environmentId: "destination-env",
        ompSessionId: destinationOmpSessionId,
        globalSessionId: `sf:destination-env:${plan.threadCommand.threadId}`,
      }),
    );
    expect(plan.threadCommand.threadId).not.toBe(source.threadId);
    expect(plan.projectCommand.projectId).not.toBe(source.projectId);
    expect(plan.result.ompSessionId).not.toBe(source.continuation.sessionId);
    expect(plan.result.ompSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(plan.result.provenance).toEqual({
      sourceEnvironmentId: source.environmentId,
      sourceProjectId: source.projectId,
      sourceThreadId: source.threadId,
      sourceGlobalSessionId: request.source.globalSessionId,
      sourceOmpSessionId: source.continuation.sessionId,
    });

    const replayPlan = buildWorkspaceMigrationDestinationPlan({
      request,
      source,
      destinationEnvironmentId: EnvironmentId.make("destination-env"),
      importedOmpSessionId: destinationOmpSessionId,
    });
    expect(replayPlan.projectCommand).toEqual(plan.projectCommand);
    expect(replayPlan.threadCommand).toEqual(plan.threadCommand);
    expect(replayPlan.projectCommand.projectId).toBe(plan.projectCommand.projectId);
    expect(replayPlan.threadCommand.threadId).toBe(plan.threadCommand.threadId);
    expect(replayPlan.binding.resumeCursor).toEqual(plan.binding.resumeCursor);
  });

  it.each([
    ["reused source", "omp-private-session"],
    ["mismatched destination", "omp-unrelated"],
  ])("fails closed for a %s OMP import identity", (_label, importedOmpSessionId) => {
    const { request, source } = transferFixture();
    expect(() =>
      buildWorkspaceMigrationDestinationPlan({
        request,
        source,
        destinationEnvironmentId: EnvironmentId.make("destination-env"),
        importedOmpSessionId,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "workspace_migration_omp_identity_mismatch",
      }),
    );
  });

  it("waits until the imported provider session is committed to projection", async () => {
    let reads = 0;
    await awaitWorkspaceMigrationProjection({
      attempts: 3,
      sleep: async () => undefined,
      expected: expectedCommit,
      read: async () => {
        reads += 1;
        return committedProof({ receipt: reads !== 1 });
      },
    });
    expect(reads).toBe(2);
  });

  it("rejects error projection state even when the binding cursor is current", async () => {
    await expect(
      awaitWorkspaceMigrationProjection({
        attempts: 1,
        expected: expectedCommit,
        read: async () => committedProof({ status: "error" }),
      }),
    ).rejects.toMatchObject({ code: "workspace_migration_projection_timeout" });
  });

  it("requires the destination-local durable lifecycle receipt", () => {
    expect(
      isWorkspaceMigrationDestinationCommitted({
        proof: committedProof({ receipt: false, eventSequence: 99 }),
        ...expectedCommit,
      }),
    ).toBe(false);
    expect(
      isWorkspaceMigrationDestinationCommitted({
        proof: committedProof({ snapshotSequence: 9 }),
        ...expectedCommit,
      }),
    ).toBe(false);
    expect(
      isWorkspaceMigrationDestinationCommitted({
        proof: committedProof({ eventSequence: 1 }),
        ...expectedCommit,
      }),
    ).toBe(true);
  });

  it("rejects extra ACP history at the initial imported boundary", () => {
    expect(
      isWorkspaceMigrationDestinationCommitted({
        proof: committedProof({ eventSequence: 1, acpSequence: 9 }),
        ...expectedCommit,
      }),
    ).toBe(false);
  });

  it("rejects a normalized destination transcript mismatch", () => {
    expect(
      isWorkspaceMigrationDestinationCommitted({
        proof: committedProof({ transcriptMismatch: true }),
        ...expectedCommit,
      }),
    ).toBe(false);
  });

  it("rejects a destination interaction mode mismatch", () => {
    expect(
      isWorkspaceMigrationDestinationCommitted({
        proof: committedProof({ interactionMode: "plan" }),
        ...expectedCommit,
      }),
    ).toBe(false);
  });

  it.effect(
    "completes and replays a live import from a destination-local cursor below the source watermark",
    () =>
      Effect.gen(function* () {
        const { request, source } = transferFixture(500);
        const ompBundle = new Uint8Array([1, 2, 3]);
        const expectedSourceChecksum = NodeCrypto.createHash("sha256")
          .update(ompBundle)
          .digest("hex");
        const plan = buildWorkspaceMigrationDestinationPlan({
          request,
          source,
          destinationEnvironmentId: EnvironmentId.make("destination-env"),
          importedOmpSessionId: destinationOmpSessionId,
        });
        const localEventSequence = 1;
        let binding: ProviderRuntimeBinding | undefined;
        let providerStarted = false;
        let importCount = 0;
        let providerStartCount = 0;
        const persistedCursors: Array<unknown> = [];

        const engine = OrchestrationEngineService.of({
          dispatch: () => Effect.succeed({ sequence: 1 }),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(1),
        });
        const directory = ProviderSessionDirectory.of({
          upsert: (nextBinding) =>
            Effect.sync(() => {
              binding = nextBinding;
              persistedCursors.push(nextBinding.resumeCursor);
            }),
          getProvider: () => Effect.succeed("omp" as never),
          getBinding: () => Effect.succeed(Option.fromNullishOr(binding)),
          listThreadIds: () => Effect.succeed([]),
          listBindings: () => Effect.succeed([]),
        });
        const provider = ProviderService.of({
          startSession: (_threadId, input) =>
            Effect.sync(() => {
              providerStartCount += 1;
              expect(input.resumeCursor).toEqual({
                schemaVersion: 3,
                sessionId: destinationOmpSessionId,
                eventSequence: 0,
                acpSequence: 0,
              });
              binding = {
                ...binding,
                threadId: plan.threadCommand.threadId,
                provider: "omp" as never,
                providerInstanceId: source.modelSelection.instanceId,
                status: "running",
                runtimeMode: source.runtimeMode,
                resumeCursor: {
                  schemaVersion: 3,
                  sessionId: destinationOmpSessionId,
                  eventSequence: localEventSequence,
                  acpSequence: source.continuation.acpSequence,
                },
                runtimePayload: {
                  canonicalSourceSequence: localEventSequence,
                  canonicalEventId: makeOmpEventId(destinationOmpSessionId, localEventSequence),
                },
              };
              providerStarted = true;
              return {} as never;
            }),
          sendTurn: () => Effect.die("unused"),
          interruptTurn: () => Effect.die("unused"),
          respondToRequest: () => Effect.die("unused"),
          respondToUserInput: () => Effect.die("unused"),
          stopSession: () => Effect.die("unused"),
          listSessions: () => Effect.die("unused"),
          getCapabilities: () => Effect.die("unused"),
          getInstanceInfo: () => Effect.die("unused"),
          rollbackConversation: () => Effect.die("unused"),
          streamEvents: Stream.empty,
        });
        const projection = ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.die("unused"),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () => Effect.die("unused"),
          getThreadDetailById: () => Effect.die("unused"),
          getThreadDetailSnapshot: () =>
            Effect.succeed(
              providerStarted
                ? Option.some({
                    snapshotSequence: 3,
                    thread: {
                      projectId: plan.projectCommand.projectId,
                      modelSelection: source.modelSelection,
                      runtimeMode: source.runtimeMode,
                      interactionMode: source.interactionMode,
                      session: { status: "ready", runtimeMode: source.runtimeMode },
                      messages: [],
                      activities: [],
                    },
                  } as never)
                : Option.none(),
            ),
        });
        const receipts = OrchestrationCommandReceiptRepository.of({
          upsert: () => Effect.die("unused"),
          getByCommandId: ({ commandId }) =>
            Effect.succeed(
              providerStarted
                ? Option.some({
                    commandId,
                    status: "accepted",
                    aggregateKind: "thread",
                    aggregateId: plan.threadCommand.threadId,
                    acceptedAt: source.capturedAt,
                    resultSequence: 2,
                    error: null,
                  })
                : Option.none(),
            ),
        });
        const environment = ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("destination-env")),
          getDescriptor: Effect.die("unused"),
        });
        const transferRuntime = {
          importSession: (input: {
            readonly sourceChecksum?: string;
            readonly destinationSessionId?: string;
          }) =>
            Effect.sync(() => {
              importCount += 1;
              expect(input.sourceChecksum).toBe(expectedSourceChecksum);
              expect(input.destinationSessionId).toBe(destinationOmpSessionId);
              return {
                version: 1 as const,
                sessionId: input.destinationSessionId!,
                sessionFile: "/omp/session.json",
                sourceChecksum: input.sourceChecksum!,
                installedChecksums: {},
                idempotent: importCount > 1,
              };
            }),
        };

        yield* Effect.gen(function* () {
          const destination = yield* makeLiveWorkspaceMigrationDestination({
            cwd: "/workspace",
            ompSettings: null,
            transferRuntime,
          });

          yield* Effect.promise(() =>
            expect(
              destination.import({
                request,
                source,
                ompBundle,
                acquireCommitAuthority: () => Promise.reject(new Error("revoked")),
              }),
            ).rejects.toMatchObject({
              code: "workspace_migration_import_authority_stale",
            }),
          );
          expect(importCount).toBe(1);
          expect(providerStartCount).toBe(0);
          const sql = yield* SqlClient.SqlClient;
          const revokedRows = yield* sql<{ readonly operationId: string }>`
            SELECT operation_id AS "operationId"
            FROM scaffold_workspace_migration_operations
            WHERE operation_id = ${request.operationId}
          `;
          expect(revokedRows).toHaveLength(0);
          importCount = 0;

          const first = yield* Effect.promise(() =>
            destination.import({
              request,
              source,
              ompBundle,
              acquireCommitAuthority: () => Promise.resolve(),
            }),
          );
          const replay = yield* Effect.promise(() =>
            destination.import({
              request,
              source,
              ompBundle,
              acquireCommitAuthority: () => Promise.resolve(),
            }),
          );

          expect(first).toEqual(replay);
          expect(importCount).toBe(2);
          expect(providerStartCount).toBe(1);
          expect(persistedCursors).toEqual([
            {
              schemaVersion: 3,
              sessionId: destinationOmpSessionId,
              eventSequence: 0,
              acpSequence: 0,
            },
          ]);
          expect(localEventSequence).toBeLessThan(source.continuation.eventSequence);
          expect(first.ompSessionId).toBe(destinationOmpSessionId);
          expect(first.provenance.sourceOmpSessionId).toBe(source.continuation.sessionId);
        }).pipe(
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(ProviderSessionDirectory, directory),
          Effect.provideService(ProviderService, provider),
          Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projection),
          Effect.provideService(OrchestrationCommandReceiptRepository, receipts),
          Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die("unused")),
          ),
          Effect.provideService(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size),
              digest: () => Effect.die("unused"),
            }),
          ),
          Effect.provide(SqlitePersistenceMemory),
        );
      }),
  );

  it.effect("persists a canonical destination commit across SQLite runtime recreation", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-live-migration-"));
      const dbPath = NodePath.join(tempDir, "destination.sqlite");
      const { request, source } = transferFixture(500);
      const ompBundle = new Uint8Array([4, 5, 6]);
      const expectedSourceChecksum = NodeCrypto.createHash("sha256")
        .update(ompBundle)
        .digest("hex");
      let importCount = 0;
      let providerStartCount = 0;

      const transferRuntime = {
        importSession: (input: {
          readonly sourceChecksum?: string;
          readonly destinationSessionId?: string;
        }) =>
          Effect.sync(() => {
            importCount += 1;
            expect(input.sourceChecksum).toBe(expectedSourceChecksum);
            expect(input.destinationSessionId).toBe(destinationOmpSessionId);
            return {
              version: 1 as const,
              sessionId: input.destinationSessionId!,
              sessionFile: "/omp/session.json",
              sourceChecksum: input.sourceChecksum!,
              installedChecksums: {},
              idempotent: importCount > 1,
            };
          }),
      };

      const createRuntime = Effect.fn("createLiveWorkspaceMigrationTestRuntime")(function* () {
        let ingestion: ProviderRuntimeIngestionService["Service"] | undefined;
        let directory: ProviderSessionDirectory["Service"] | undefined;
        const provider = ProviderService.of({
          startSession: (threadId, input) =>
            Effect.gen(function* () {
              providerStartCount += 1;
              expect(input.resumeCursor).toEqual({
                schemaVersion: 3,
                sessionId: destinationOmpSessionId,
                eventSequence: 0,
                acpSequence: 0,
              });
              if (!ingestion || !directory) return yield* Effect.die("runtime not initialized");
              const eventSequence = 1;
              const resumeCursor = {
                schemaVersion: 3 as const,
                sessionId: destinationOmpSessionId,
                eventSequence,
                acpSequence: source.continuation.acpSequence,
              };
              const eventId = makeOmpEventId(destinationOmpSessionId, eventSequence);
              const ingestCanonical = ingestion.ingestCanonical as
                | ((envelope: ProviderRuntimeEventEnvelope) => Effect.Effect<void, Error>)
                | undefined;
              if (!ingestCanonical) return yield* Effect.die("canonical ingestion unavailable");
              yield* ingestCanonical({
                protocolVersion: 1,
                eventId,
                environmentId: EnvironmentId.make("destination-env"),
                threadId,
                sourceSequence: eventSequence,
                resumeCursor: {
                  kind: "omp",
                  schemaVersion: 3,
                  sessionId: RuntimeSessionId.make(destinationOmpSessionId),
                  eventSequence,
                  acpSequence: source.continuation.acpSequence,
                },
                providerInstanceId: ProviderInstanceId.make("omp"),
                runtimeSessionId: RuntimeSessionId.make(destinationOmpSessionId),
                event: {
                  type: "session.started",
                  eventId,
                  provider: "omp" as never,
                  providerInstanceId: ProviderInstanceId.make("omp"),
                  createdAt: "2026-07-26T00:00:01.000Z",
                  threadId,
                  resumeCursor,
                  payload: {},
                },
              }).pipe(Effect.orDie);
              yield* directory
                .upsert({
                  threadId,
                  provider: "omp" as never,
                  providerInstanceId: ProviderInstanceId.make("omp"),
                  status: "running",
                  runtimeMode: source.runtimeMode,
                  resumeCursor,
                  runtimePayload: {
                    canonicalSourceSequence: eventSequence,
                    canonicalEventId: eventId,
                  },
                })
                .pipe(Effect.orDie);
              return {
                provider: "omp" as never,
                providerInstanceId: ProviderInstanceId.make("omp"),
                threadId,
                status: "ready" as const,
                runtimeMode: source.runtimeMode,
                resumeCursor,
                cwd: request.workspace.rootDir,
                createdAt: "2026-07-26T00:00:01.000Z",
                updatedAt: "2026-07-26T00:00:01.000Z",
              };
            }),
          sendTurn: () => Effect.die("unused"),
          interruptTurn: () => Effect.die("unused"),
          respondToRequest: () => Effect.die("unused"),
          respondToUserInput: () => Effect.die("unused"),
          stopSession: () => Effect.die("unused"),
          listSessions: () => Effect.succeed([]),
          getCapabilities: () => Effect.die("unused"),
          getInstanceInfo: () => Effect.die("unused"),
          rollbackConversation: () => Effect.die("unused"),
          streamEvents: Stream.empty,
        });
        const persistence = makeSqlitePersistenceLive(dbPath);
        const receiptLayer = OrchestrationCommandReceiptRepositoryLive.pipe(
          Layer.provide(persistence),
        );
        const snapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
          Layer.provide(RepositoryIdentityResolver.layer),
          Layer.provide(persistence),
        );
        const orchestrationLayer = OrchestrationEngineLive.pipe(
          Layer.provide(snapshotLayer),
          Layer.provide(OrchestrationProjectionPipelineLive),
          Layer.provide(OrchestrationEventStoreLive),
          Layer.provide(receiptLayer),
          Layer.provide(RepositoryIdentityResolver.layer),
          Layer.provide(persistence),
        );
        const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
          Layer.provide(persistence),
        );
        const directoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const providerLayer = Layer.succeed(ProviderService, provider);
        const serverConfigLayer = ServerConfig.layerTest(process.cwd(), tempDir);
        const infrastructure = Layer.mergeAll(
          orchestrationLayer,
          snapshotLayer,
          receiptLayer,
          directoryLayer,
          providerLayer,
          persistence,
          ServerSettingsService.layerTest(),
        );
        const ingestionLayer = ProviderRuntimeIngestionLive.pipe(Layer.provide(infrastructure));
        const environmentLayer = Layer.succeed(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("destination-env")),
            getDescriptor: Effect.die("unused"),
          }),
        );
        const scope = yield* Scope.make();
        const context = yield* Layer.build(
          Layer.mergeAll(infrastructure, ingestionLayer, environmentLayer).pipe(
            Layer.provide(serverConfigLayer),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));
        ingestion = yield* Effect.service(ProviderRuntimeIngestionService).pipe(
          Effect.provide(context),
        );
        directory = yield* Effect.service(ProviderSessionDirectory).pipe(Effect.provide(context));
        const destination = yield* makeLiveWorkspaceMigrationDestination({
          cwd: request.workspace.rootDir,
          ompSettings: null,
          transferRuntime,
        }).pipe(Effect.provide(context));
        return {
          context,
          destination,
          directory,
          dispose: Scope.close(scope, Exit.void),
        };
      });

      let firstRuntime: Effect.Success<ReturnType<typeof createRuntime>> | undefined;
      let replayRuntime: Effect.Success<ReturnType<typeof createRuntime>> | undefined;
      return yield* Effect.gen(function* () {
        firstRuntime = yield* createRuntime();
        const first = yield* Effect.promise(() =>
          firstRuntime!.destination.import({
            request,
            source,
            ompBundle,
            acquireCommitAuthority: () => Promise.resolve(),
          }),
        );
        const firstBinding = Option.getOrThrow(
          yield* firstRuntime.directory
            .getBinding(first.threadId)
            .pipe(Effect.provide(firstRuntime.context)),
        );
        expect(parseOmpResume(firstBinding.resumeCursor)).toEqual({
          sessionId: destinationOmpSessionId,
          eventSequence: 1,
          acpSequence: source.continuation.acpSequence,
        });
        yield* firstRuntime.dispose;
        firstRuntime = undefined;

        replayRuntime = yield* createRuntime();
        const replay = yield* Effect.promise(() =>
          replayRuntime!.destination.import({
            request,
            source,
            ompBundle,
            acquireCommitAuthority: () => Promise.resolve(),
          }),
        );
        expect(replay).toEqual(first);
        expect(providerStartCount).toBe(1);
        expect(importCount).toBe(2);

        const replayBinding = Option.getOrThrow(
          yield* replayRuntime.directory
            .getBinding(replay.threadId)
            .pipe(Effect.provide(replayRuntime.context)),
        );
        expect(replayBinding).toEqual(firstBinding);
        const receiptId = `provider:destination-env:${replay.threadId}:${encodeURIComponent(
          makeOmpEventId(destinationOmpSessionId, 1),
        )}:thread-session-set:0`;
        const receipt = Option.getOrThrow(
          yield* Effect.flatMap(OrchestrationCommandReceiptRepository, (repository) =>
            repository.getByCommandId({ commandId: receiptId as never }),
          ).pipe(Effect.provide(replayRuntime.context), Effect.orDie),
        );
        expect(receipt).toMatchObject({
          commandId: receiptId,
          status: "accepted",
          aggregateKind: "thread",
          aggregateId: replay.threadId,
        });
        const operationRows = yield* Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`
          SELECT operation_id
          FROM scaffold_workspace_migration_operations
          WHERE operation_id = ${request.operationId}
        `,
        ).pipe(Effect.provide(replayRuntime.context), Effect.orDie);
        expect(operationRows).toHaveLength(1);

        const conflictingRequest = decodeImportInput({
          ...encodeImportInput(request),
          payloadDigestSha256: "9".repeat(64),
        });
        yield* Effect.promise(() =>
          expect(
            replayRuntime!.destination.import({
              request: conflictingRequest,
              source,
              ompBundle,
              acquireCommitAuthority: () => Promise.resolve(),
            }),
          ).rejects.toMatchObject({
            cause: {
              code: "workspace_migration_destination_operation_conflict",
            },
          }),
        );
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (firstRuntime) yield* firstRuntime.dispose;
            if (replayRuntime) yield* replayRuntime.dispose;
            NodeFS.rmSync(tempDir, { recursive: true, force: true });
          }),
        ),
      );
    }),
  );
});
