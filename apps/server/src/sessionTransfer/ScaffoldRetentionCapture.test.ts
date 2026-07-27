import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationProject,
  type OrchestrationThread,
  ProviderDriverKind,
  ScaffoldRetentionCaptureInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";
import {
  makeScaffoldRetentionCaptureService,
  selectRetentionCaptureSource,
} from "./ScaffoldRetentionCapture.ts";

const decodeInput = Schema.decodeUnknownSync(ScaffoldRetentionCaptureInput);
const archiveBytes = new TextEncoder().encode("private omp history");
const archiveSha256 = NodeCrypto.createHash("sha256").update(archiveBytes).digest("hex");

function project(id = "project-source"): OrchestrationProject {
  return {
    id: ProjectId.make(id),
    title: "Source project",
    workspaceRoot: "/workspace",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    deletedAt: null,
  } as unknown as OrchestrationProject;
}

function thread(id = "thread-source"): OrchestrationThread {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-source"),
    title: "Retain me",
    modelSelection: {
      instanceId: "omp",
      model: "openai/gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  } as unknown as OrchestrationThread;
}

function binding(threadId = "thread-source"): ProviderRuntimeBinding {
  return {
    threadId: ThreadId.make(threadId),
    provider: ProviderDriverKind.make("omp"),
    providerInstanceId: "omp" as never,
    status: "running",
    resumeCursor: {
      schemaVersion: 3,
      sessionId: "omp-source",
      eventSequence: 19,
      acpSequence: 11,
    },
    runtimeMode: "full-access",
    runtimePayload: null,
  };
}

function request() {
  return decodeInput({
    version: "scaffold.retention.capture.v1",
    archiveId: "archive-1",
    operationId: "capture-1",
    sessionId: "scaffold-session-1",
    sourceSandboxId: "sandbox-1",
    sourcePauseLifecycleEpoch: 7,
  });
}

function harness() {
  const files = new Map<string, Uint8Array>();
  const exported: Array<string> = [];
  const sourceThread = thread();
  const service = makeScaffoldRetentionCaptureService({
    sessionId: "scaffold-session-1",
    lifecycleEpoch: 7,
    environmentId: EnvironmentId.make("environment-source"),
    retentionRoot: "/workspace/.scaffold/retention",
    now: () => "2026-07-27T01:00:00.000Z",
    loadSnapshot: async () => ({ projects: [project()], threads: [sourceThread] }),
    loadBindings: async () => new Map([[sourceThread.id, binding()]]),
    exportOmpSession: async ({ sessionId, archivePath }) => {
      exported.push(sessionId);
      files.set(archivePath, archiveBytes);
      return {
        version: 1,
        sessionId,
        archivePath,
        sourceChecksum: archiveSha256,
        files: [{ path: "session.json", size: 1, sha256: "a".repeat(64) }],
      };
    },
    files: {
      makeDirectory: async () => undefined,
      readFile: async (path) => {
        const value = files.get(path);
        if (!value) throw new Error(`missing ${path}`);
        return value;
      },
      writeFileAtomically: async (path, bytes) => {
        files.set(path, bytes);
      },
      exists: async (path) => files.has(path),
    },
  });
  return { service, files, exported, sourceThread };
}

describe("Scaffold retention capture", () => {
  it("derives authoritative identities and stages metadata without exposing bytes", async () => {
    const { service, files, exported } = harness();
    const receipt = await service.capture(request());

    expect(receipt.source).toMatchObject({
      sessionId: "scaffold-session-1",
      environmentId: "environment-source",
      globalSessionId: "sf:environment-source:thread-source",
      projectId: "project-source",
      threadId: "thread-source",
      ompSessionId: "omp-source",
      model: "openai/gpt-5.6-sol",
      effort: "high",
    });
    expect(receipt.ompBundle.path).toBe("/workspace/.scaffold/retention/archive-1/omp-session.zip");
    expect(receipt.t3Metadata.path).toBe(
      "/workspace/.scaffold/retention/archive-1/t3-metadata.json",
    );
    expect(receipt).not.toHaveProperty("bytes");
    expect(exported).toEqual(["omp-source"]);
    const metadata = new TextDecoder().decode(files.get(receipt.t3Metadata.path));
    expect(metadata).toContain('"visibleTranscript"');
    expect(metadata).not.toContain('"eventSequence"');
    expect(metadata).not.toContain('"resumeCursor"');
  });

  it("is idempotent for the same operation and rejects foreign local authority", async () => {
    const { service, exported } = harness();
    const first = await service.capture(request());
    const second = await service.capture(request());
    expect(second).toEqual(first);
    expect(exported).toEqual(["omp-source"]);

    await expect(
      service.capture(decodeInput({ ...request(), sessionId: "browser-substituted-session" })),
    ).rejects.toMatchObject({ code: "scaffold_retention_source_authority_mismatch" });
  });

  it("fails closed instead of choosing among multiple OMP threads", () => {
    const first = thread("thread-source");
    const second = thread("thread-other");
    expect(() =>
      selectRetentionCaptureSource({
        snapshot: { projects: [project()], threads: [first, second] },
        bindings: new Map([
          [first.id, binding(first.id)],
          [second.id, binding(second.id)],
        ]),
      }),
    ).toThrow();
  });
});
