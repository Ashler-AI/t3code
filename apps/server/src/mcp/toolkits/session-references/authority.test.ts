import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "../../../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../../../provider/Services/ProviderInstanceRegistry.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SESSION_MESSAGE_MAX_CHARS, SessionReferenceAuthority, layer } from "./authority.ts";

const environmentId = EnvironmentId.make("environment-local");
const sourceThreadId = ThreadId.make("thread-source");
const targetThreadId = ThreadId.make("thread-target");
const projectId = ProjectId.make("project-1");
const ompInstanceId = ProviderInstanceId.make("omp-primary");
const now = "2026-07-24T12:00:00.000Z";
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId: sourceThreadId,
  providerSessionId: "provider-session-source",
  providerInstanceId: ompInstanceId,
  capabilities: new Set(["session_reference_read", "session_message_send"]),
  issuedAt: 1,
};

const makeReadModel = (overrides?: {
  readonly worktreePath?: string | null;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
  readonly projectDeletedAt?: string | null;
  readonly instanceId?: ProviderInstanceId;
}): OrchestrationReadModel => ({
  snapshotSequence: 1,
  updatedAt: now,
  projects: [
    {
      id: projectId,
      title: "Project",
      workspaceRoot: "/authoritative/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: overrides?.projectDeletedAt ?? null,
    },
  ],
  threads: [
    {
      id: targetThreadId,
      projectId,
      title: "Target agent",
      modelSelection: {
        instanceId: overrides?.instanceId ?? ompInstanceId,
        model: "openai/gpt-5.6-terra",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "omp/target",
      worktreePath:
        overrides?.worktreePath === undefined ? "/authoritative/worktree" : overrides.worktreePath,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: overrides?.archivedAt ?? null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: overrides?.deletedAt ?? null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
});

const makeAuthority = (input?: {
  readonly readModel?: OrchestrationReadModel;
  readonly driverKind?: string;
  readonly commands?: Array<OrchestrationCommand>;
}) => {
  const readModel = input?.readModel ?? makeReadModel();
  const commands = input?.commands ?? [];
  const projection = ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
    getCommandReadModel: () => Effect.succeed(readModel),
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
    getThreadDetailSnapshot: () => Effect.die("unused"),
  });
  const providers = ProviderInstanceRegistry.ProviderInstanceRegistry.of({
    getInstance: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(input?.driverKind ?? "omp"),
      } as ProviderInstance),
    listInstances: Effect.succeed([]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.die("unused"),
  });
  const orchestration = OrchestrationEngine.OrchestrationEngineService.of({
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: 42 };
      }),
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(42),
  });

  return Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.fresh(layer).pipe(
        Layer.provide(Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projection)),
        Layer.provide(Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, providers)),
        Layer.provide(Layer.succeed(OrchestrationEngine.OrchestrationEngineService, orchestration)),
        Layer.provide(NodeServices.layer),
      ),
    );
    return yield* Effect.service(SessionReferenceAuthority).pipe(Effect.provide(context));
  });
};

describe("SessionReferenceAuthority", () => {
  it.effect("resolves the authoritative worktree path and falls back to the project root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const authority = yield* makeAuthority();
        expect(yield* authority.resolve(scope, targetThreadId)).toMatchObject({
          environmentId,
          threadId: targetThreadId,
          rootPath: "/authoritative/worktree",
        });

        const projectAuthority = yield* makeAuthority({
          readModel: makeReadModel({ worktreePath: null }),
        });
        expect((yield* projectAuthority.resolve(scope, targetThreadId)).rootPath).toBe(
          "/authoritative/project",
        );
      }),
    ),
  );

  it.effect("rejects self, missing, deleted, archived, and non-OMP targets", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const authority = yield* makeAuthority();
        expect((yield* authority.resolve(scope, sourceThreadId).pipe(Effect.flip)).reason).toBe(
          "self_reference",
        );
        expect(
          (yield* authority.resolve(scope, ThreadId.make("missing")).pipe(Effect.flip)).reason,
        ).toBe("target_missing");

        for (const [readModel, expected] of [
          [makeReadModel({ deletedAt: now }), "target_deleted"],
          [makeReadModel({ archivedAt: now }), "target_archived"],
          [makeReadModel({ projectDeletedAt: now }), "target_project_deleted"],
        ] as const) {
          const rejected = yield* makeAuthority({ readModel });
          expect((yield* rejected.resolve(scope, targetThreadId).pipe(Effect.flip)).reason).toBe(
            expected,
          );
        }

        const codexTarget = yield* makeAuthority({ driverKind: "codex" });
        expect((yield* codexTarget.resolve(scope, targetThreadId).pipe(Effect.flip)).reason).toBe(
          "target_not_omp",
        );
      }),
    ),
  );

  it.effect("dispatches an existing turn start with explicit source-session provenance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands: Array<OrchestrationCommand> = [];
        const authority = yield* makeAuthority({ commands });
        const result = yield* authority.send(scope, targetThreadId, "Please review the diff.");

        expect(result).toMatchObject({
          environmentId,
          sourceThreadId,
          targetThreadId,
          sequence: 42,
        });
        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({
          type: "thread.turn.start",
          threadId: targetThreadId,
          runtimeMode: "full-access",
          interactionMode: "default",
          message: {
            role: "user",
            text: `[Message from agent session ${sourceThreadId}]\n\nPlease review the diff.`,
            attachments: [],
          },
        });
      }),
    ),
  );

  it.effect("caps agent-to-agent messages before dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands: Array<OrchestrationCommand> = [];
        const authority = yield* makeAuthority({ commands });
        const error = yield* authority
          .send(scope, targetThreadId, "x".repeat(SESSION_MESSAGE_MAX_CHARS + 1))
          .pipe(Effect.flip);
        expect(error.reason).toBe("message_too_long");
        expect(commands).toEqual([]);
      }),
    ),
  );
});
