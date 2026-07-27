// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  type EnvironmentId,
  ScaffoldRetentionCaptureInput,
  ScaffoldRetentionCaptureReceipt,
  ScaffoldRetentionT3Metadata,
  type OrchestrationProject,
  type OrchestrationThread,
  type OmpSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { parseOmpResume } from "../provider/Layers/OmpAdapter.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { canonicalTranscript, canonicalTranscriptSha256 } from "./CanonicalTranscript.ts";
import {
  makeOmpSessionTransferRuntime,
  type OmpSessionExport,
} from "./OmpSessionTransferRuntime.ts";

export const SCAFFOLD_RETENTION_ROOT = "/workspace/.scaffold/retention";

export class ScaffoldRetentionCaptureError extends Data.TaggedError(
  "ScaffoldRetentionCaptureError",
)<{
  readonly code: string;
  readonly detail: string;
}> {}

export interface ScaffoldRetentionCapturePort {
  readonly capture: (
    input: ScaffoldRetentionCaptureInput,
  ) => Promise<ScaffoldRetentionCaptureReceipt>;
}

export interface ScaffoldRetentionCaptureFilePort {
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly writeFileAtomically: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly exists: (path: string) => Promise<boolean>;
}

type CaptureSnapshot = {
  readonly projects: ReadonlyArray<OrchestrationProject>;
  readonly threads: ReadonlyArray<OrchestrationThread>;
};

const encodeMetadata = Schema.encodeSync(Schema.fromJsonString(ScaffoldRetentionT3Metadata));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(ScaffoldRetentionCaptureReceipt));
const decodeReceipt = Schema.decodeSync(Schema.fromJsonString(ScaffoldRetentionCaptureReceipt));
const encodeCaptureInput = Schema.encodeSync(Schema.fromJsonString(ScaffoldRetentionCaptureInput));

function digest(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function selectedEffort(thread: OrchestrationThread): string | undefined {
  const value = thread.modelSelection.options?.find((option) =>
    ["reasoningEffort", "effort", "thinking"].includes(option.id),
  )?.value;
  return typeof value === "string" ? value : undefined;
}

export function selectRetentionCaptureSource(input: {
  readonly snapshot: CaptureSnapshot;
  readonly bindings: ReadonlyMap<string, ProviderRuntimeBinding | undefined>;
}) {
  const candidates = input.snapshot.threads.flatMap((thread) => {
    if (thread.archivedAt !== null) return [];
    const project = input.snapshot.projects.find((candidate) => candidate.id === thread.projectId);
    const binding = input.bindings.get(thread.id);
    const resume = binding ? parseOmpResume(binding.resumeCursor) : undefined;
    return project &&
      binding?.provider === ProviderDriverKind.make("omp") &&
      resume &&
      resume.activeTurnId === undefined &&
      thread.latestTurn?.state !== "running"
      ? [{ project, thread, resume }]
      : [];
  });
  if (candidates.length !== 1) {
    throw new ScaffoldRetentionCaptureError({
      code: "scaffold_retention_source_ambiguous",
      detail: `Retention capture requires exactly one non-archived idle OMP thread; found ${candidates.length}.`,
    });
  }
  return candidates[0]!;
}

export function makeScaffoldRetentionCaptureService(options: {
  readonly sessionId: string;
  readonly lifecycleEpoch: number;
  readonly environmentId: EnvironmentId;
  readonly retentionRoot?: string;
  readonly now: () => string;
  readonly loadSnapshot: () => Promise<CaptureSnapshot>;
  readonly loadBindings: (
    threads: ReadonlyArray<OrchestrationThread>,
  ) => Promise<ReadonlyMap<string, ProviderRuntimeBinding | undefined>>;
  readonly exportOmpSession: (input: {
    readonly sessionId: string;
    readonly archivePath: string;
    readonly cwd: string;
  }) => Promise<OmpSessionExport>;
  readonly files: ScaffoldRetentionCaptureFilePort;
}): ScaffoldRetentionCapturePort {
  const inFlight = new Map<
    string,
    { readonly fingerprint: string; readonly promise: Promise<ScaffoldRetentionCaptureReceipt> }
  >();
  const retentionRoot = options.retentionRoot ?? SCAFFOLD_RETENTION_ROOT;

  const capture = async (input: ScaffoldRetentionCaptureInput) => {
    if (
      input.sessionId !== options.sessionId ||
      input.sourcePauseLifecycleEpoch !== options.lifecycleEpoch
    ) {
      throw new ScaffoldRetentionCaptureError({
        code: "scaffold_retention_source_authority_mismatch",
        detail: "Retention capture does not match this T3 runtime session and lifecycle epoch.",
      });
    }
    const key = `${input.archiveId}:${input.operationId}`;
    const fingerprint = digest(new TextEncoder().encode(encodeCaptureInput(input)));
    const existing = inFlight.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ScaffoldRetentionCaptureError({
          code: "scaffold_retention_operation_conflict",
          detail: "The capture operation is already bound to another immutable request.",
        });
      }
      return existing.promise;
    }

    const running = Promise.resolve().then(async () => {
      const archiveDirectory = NodePath.join(retentionRoot, input.archiveId);
      const ompBundlePath = NodePath.join(archiveDirectory, "omp-session.zip");
      const t3MetadataPath = NodePath.join(archiveDirectory, "t3-metadata.json");
      const receiptPath = NodePath.join(archiveDirectory, "t3-capture-receipt.json");
      if (await options.files.exists(receiptPath)) {
        const receipt = decodeReceipt(
          new TextDecoder().decode(await options.files.readFile(receiptPath)),
        );
        if (
          receipt.operationId !== input.operationId ||
          receipt.archiveId !== input.archiveId ||
          receipt.source.sessionId !== input.sessionId ||
          receipt.source.sandboxId !== input.sourceSandboxId ||
          receipt.source.pauseLifecycleEpoch !== input.sourcePauseLifecycleEpoch
        ) {
          throw new ScaffoldRetentionCaptureError({
            code: "scaffold_retention_archive_conflict",
            detail: "The archive id is already bound to another capture operation.",
          });
        }
        return receipt;
      }

      await options.files.makeDirectory(archiveDirectory);
      const snapshot = await options.loadSnapshot();
      const selected = selectRetentionCaptureSource({
        snapshot,
        bindings: await options.loadBindings(snapshot.threads),
      });
      const rootPath = selected.thread.worktreePath ?? selected.project.workspaceRoot;
      const visibleTranscript = canonicalTranscript(selected.thread);
      const transcriptSha256 = canonicalTranscriptSha256(selected.thread);
      const exported = await options.exportOmpSession({
        sessionId: selected.resume.sessionId,
        archivePath: ompBundlePath,
        cwd: rootPath,
      });
      const ompBytes = await options.files.readFile(ompBundlePath);
      const ompBundleSha256 = digest(ompBytes);
      if (
        exported.sessionId !== selected.resume.sessionId ||
        exported.archivePath !== ompBundlePath ||
        exported.sourceChecksum !== ompBundleSha256
      ) {
        throw new ScaffoldRetentionCaptureError({
          code: "scaffold_retention_omp_export_mismatch",
          detail: "OMP export did not match the authoritative source session or staged bytes.",
        });
      }
      const effort = selectedEffort(selected.thread);
      const source = {
        sessionId: options.sessionId,
        sandboxId: input.sourceSandboxId,
        pauseLifecycleEpoch: options.lifecycleEpoch,
        environmentId: options.environmentId,
        globalSessionId: `sf:${options.environmentId}:${selected.thread.id}`,
        projectId: selected.project.id,
        threadId: selected.thread.id,
        ompSessionId: selected.resume.sessionId,
        rootPath,
        title: selected.thread.title,
        model: selected.thread.modelSelection.model,
        modelSelection: selected.thread.modelSelection,
        ...(effort === undefined ? {} : { effort }),
        runtimeMode: selected.thread.runtimeMode,
        interactionMode: selected.thread.interactionMode,
        capturedAt: options.now(),
        transcriptSha256,
      };
      const metadata = new ScaffoldRetentionT3Metadata({
        version: "scaffold.retention.t3_metadata.v1",
        archiveId: input.archiveId,
        operationId: input.operationId,
        source,
        visibleTranscript,
        ompExport: {
          version: exported.version,
          sessionId: exported.sessionId,
          sourceChecksum: exported.sourceChecksum,
          files: exported.files,
        },
      });
      const metadataBytes = new TextEncoder().encode(encodeMetadata(metadata));
      await options.files.writeFileAtomically(t3MetadataPath, metadataBytes);
      const receipt = new ScaffoldRetentionCaptureReceipt({
        ok: true,
        version: "scaffold.retention.capture.receipt.v1",
        archiveId: input.archiveId,
        operationId: input.operationId,
        source,
        ompBundle: {
          path: ompBundlePath,
          bytes: ompBytes.byteLength,
          sha256: ompBundleSha256,
        },
        t3Metadata: {
          path: t3MetadataPath,
          bytes: metadataBytes.byteLength,
          sha256: digest(metadataBytes),
        },
      });
      await options.files.writeFileAtomically(
        receiptPath,
        new TextEncoder().encode(encodeReceipt(receipt)),
      );
      return receipt;
    });
    inFlight.set(key, { fingerprint, promise: running });
    void running.catch(() => {
      if (inFlight.get(key)?.promise === running) inFlight.delete(key);
    });
    return running;
  };

  return { capture };
}

export const makeLiveScaffoldRetentionCapture = Effect.fn("makeLiveScaffoldRetentionCapture")(
  function* (options: {
    readonly sessionId: string;
    readonly lifecycleEpoch: number;
    readonly ompSettings: Pick<OmpSettings, "binaryPath"> | null | undefined;
  }) {
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const directory = yield* ProviderSessionDirectory;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const environmentId = yield* environment.getEnvironmentId;
    return makeScaffoldRetentionCaptureService({
      sessionId: options.sessionId,
      lifecycleEpoch: options.lifecycleEpoch,
      environmentId,
      now: () => DateTime.formatIso(DateTime.nowUnsafe()),
      loadSnapshot: () => snapshots.getSnapshot().pipe(Effect.runPromise),
      loadBindings: async (threads) => {
        const entries = await Effect.forEach(threads, (thread) =>
          directory
            .getBinding(thread.id)
            .pipe(Effect.map((binding) => [thread.id, Option.getOrUndefined(binding)] as const)),
        ).pipe(Effect.runPromise);
        return new Map(entries);
      },
      exportOmpSession: ({ sessionId, archivePath, cwd }) =>
        Effect.scoped(
          makeOmpSessionTransferRuntime({ cwd, ompSettings: options.ompSettings }).pipe(
            Effect.flatMap((runtime) => runtime.exportSession({ sessionId, archivePath })),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          ),
        ).pipe(Effect.runPromise),
      files: {
        makeDirectory: (path) =>
          fileSystem.makeDirectory(path, { recursive: true }).pipe(Effect.runPromise),
        readFile: (path) => fileSystem.readFile(path).pipe(Effect.runPromise),
        writeFileAtomically: async (path, bytes) => {
          await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
          const temp = `${path}.${NodeCrypto.randomUUID()}.tmp`;
          await NodeFSP.writeFile(temp, bytes, { flag: "wx" });
          await NodeFSP.rename(temp, path);
        },
        exists: (path) => fileSystem.exists(path).pipe(Effect.runPromise),
      },
    });
  },
);
