import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const liveOmpProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("omp"),
  driver: ProviderDriverKind.make("omp"),
  displayName: "OMP",
  enabled: true,
  installed: true,
  version: "17.1.2",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    {
      slug: "openai-codex/gpt-5.6-terra",
      name: "Terra",
      isCustom: false,
      capabilities: null,
    },
    {
      slug: "openai-codex/gpt-5.6-sol",
      name: "Sol",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};

const providerRegistryService: ProviderRegistry.ProviderRegistry["Service"] = {
  getProviders: Effect.succeed([liveOmpProvider]),
  refresh: () => Effect.succeed([liveOmpProvider]),
  refreshInstance: () => Effect.succeed([liveOmpProvider]),
  getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
  setProviderMaintenanceActionState: () => Effect.succeed([liveOmpProvider]),
  streamChanges: Stream.empty,
};

it("uses a live allowed OMP model for auto-bootstrapped model selection", () => {
  assert.deepStrictEqual(
    ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection([liveOmpProvider]),
    {
      instanceId: ProviderInstanceId.make("omp"),
      model: "openai-codex/gpt-5.6-sol",
    },
  );
  assert.isNull(ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection([]));
  assert.isNull(
    ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection([
      {
        ...liveOmpProvider,
        models: [
          {
            slug: "openai-codex/gpt-5.5",
            name: "Unsupported",
            isCustom: false,
            capabilities: null,
          },
        ],
      },
    ]),
  );
});

it("honors OMP's live default for Scaffold bootstrap selection", () => {
  assert.deepStrictEqual(
    ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection([
      {
        ...liveOmpProvider,
        models: [
          {
            slug: "ashler/moonshotai/Kimi-K2.6",
            name: "Kimi K2.6",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "openai/gpt-5.6-sol",
            name: "Sol",
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
        ],
      },
    ]),
    {
      instanceId: ProviderInstanceId.make("omp"),
      model: "openai/gpt-5.6-sol",
    },
  );

  assert.deepStrictEqual(
    ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection([
      {
        ...liveOmpProvider,
        models: [
          {
            slug: "openai/gpt-5.6-sol",
            name: "Sol",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "openai/gpt-5.6-terra",
            name: "Terra",
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
        ],
      },
    ]),
    {
      instanceId: ProviderInstanceId.make("omp"),
      model: "openai/gpt-5.6-terra",
    },
  );
});

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("launchStartupHeartbeat does not block the caller while counts are loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseCounts = yield* Deferred.make<void, never>();

      yield* ServerRuntimeStartup.launchStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () =>
            Deferred.await(releaseCounts).pipe(
              Effect.as({
                projectCount: 2,
                threadCount: 3,
              }),
            ),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
        Effect.provideService(AnalyticsService.AnalyticsService, {
          record: () => Effect.void,
          flush: Effect.void,
        }),
      );
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets returns existing project and thread ids", () => {
  const bootstrapProjectId = ProjectId.make("project-startup-bootstrap");
  const bootstrapThreadId = ThreadId.make("thread-startup-bootstrap");

  return Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            Option.some({
              id: bootstrapProjectId,
              title: "Startup Project",
              workspaceRoot: "/tmp/startup-project",
              defaultModelSelection: ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection([
                liveOmpProvider,
              ]),
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.some(bootstrapThreadId)),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(ProviderRegistry.ProviderRegistry, providerRegistryService),
      Effect.provide(NodeServices.layer),
    );

    assert.deepStrictEqual(targets, {
      bootstrapProjectId,
      bootstrapThreadId,
    });
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  });
});

it.effect("resolveAutoBootstrapWelcomeTargets creates a project and thread when missing", () =>
  Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(ProviderRegistry.ProviderRegistry, providerRegistryService),
      Effect.provide(NodeServices.layer),
    );

    assert.equal(typeof targets.bootstrapProjectId, "string");
    assert.equal(typeof targets.bootstrapThreadId, "string");
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), ["project.create", "thread.create"]);
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets preserves typed UUID generation failures", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const uuidError = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "randomUUIDv4",
      description: "UUID generation unavailable",
    });
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);

    const error = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(ProviderRegistry.ProviderRegistry, providerRegistryService),
      Effect.provideService(Crypto.Crypto, {
        ...crypto,
        randomUUIDv4: Effect.fail(uuidError),
      }),
      Effect.flip,
    );

    assert.strictEqual(error, uuidError);
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
