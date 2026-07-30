import { ConnectionBlockedError, EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  makeScaffoldLifecycleAction,
  ScaffoldLifecycleGateway,
} from "@t3tools/client-runtime/scaffold";
import {
  EnvironmentId,
  ProjectId,
  ScaffoldEnvironmentBinding,
  ScaffoldLifecycleError,
  ScaffoldPreparedConnection,
  ScaffoldSessionObservation,
  ScaffoldSessionLinks,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  createMemoryScaffoldLifecycleActionStore,
  drainScaffoldLifecycleActions,
} from "./scaffoldLifecycleOutbox";
import { registerScaffoldEnvironment } from "./scaffoldOnboarding";

const input = {
  deployment: "staging" as const,
  operationId: "operation-1",
  sessionId: "session-1",
  create: {},
};

function preparedConnection(deployment: "staging" | "production" = "staging") {
  return new ScaffoldPreparedConnection({
    binding: new ScaffoldEnvironmentBinding({
      deployment,
      environmentId: EnvironmentId.make("remote-environment"),
      sessionId: "session-1",
      lifecycleEpoch: 1,
      status: "ready",
      links: new ScaffoldSessionLinks({
        session: "https://scaffold.example/?q=session-1",
        web: "https://scaffold.example/sessions/session-1/web",
        tilt: "https://scaffold.example/sessions/session-1/tilt",
      }),
      lastKnownAt: "2026-07-27T00:00:00.000Z",
    }),
    httpBaseUrl: "https://sandbox.example/http",
    wsBaseUrl: "wss://sandbox.example/ws",
    bootstrapCredential: "bootstrap",
    attachCredential: "attach",
    expiresAt: "2026-07-27T00:05:00.000Z",
  });
}

function runWithLifecycleFailure(error: ScaffoldLifecycleError) {
  let registered = false;
  const gateway = ScaffoldLifecycleGateway.of({
    create: () => Effect.fail(error),
    prepare: () => Effect.die("not used"),
  });
  const registry = EnvironmentRegistry.of({
    register: () => {
      registered = true;
      return Effect.void;
    },
  } as unknown as EnvironmentRegistry["Service"]);

  return {
    registered: () => registered,
    failure: Effect.flip(
      registerScaffoldEnvironment(input).pipe(
        Effect.provideService(ScaffoldLifecycleGateway, gateway),
        Effect.provideService(EnvironmentRegistry, registry),
      ),
    ),
  };
}

describe("Scaffold onboarding", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.effect("returns the binding as soon as its target is durably registered", () =>
    Effect.gen(function* () {
      let registerCalls = 0;
      const gateway = ScaffoldLifecycleGateway.of({
        create: () => Effect.succeed(preparedConnection()),
        prepare: () => Effect.die("not used"),
      });
      const registry = EnvironmentRegistry.of({
        register: () =>
          Effect.sync(() => {
            registerCalls += 1;
          }),
        state: () => Effect.die("onboarding must not wait for supervisor state"),
        stateChanges: () => Effect.die("onboarding must not follow supervisor state"),
      } as unknown as EnvironmentRegistry["Service"]);

      const result = yield* registerScaffoldEnvironment(input).pipe(
        Effect.provideService(ScaffoldLifecycleGateway, gateway),
        Effect.provideService(EnvironmentRegistry, registry),
      );
      expect(result.binding.environmentId).toBe("remote-environment");
      expect(registerCalls).toBe(1);
    }),
  );

  it.effect("leaves transport backoff and retry exclusively to the registered supervisor", () =>
    Effect.gen(function* () {
      let createCalls = 0;
      let registerCalls = 0;
      const gateway = ScaffoldLifecycleGateway.of({
        create: () =>
          Effect.sync(() => {
            createCalls += 1;
            return preparedConnection();
          }),
        prepare: () => Effect.die("not used"),
      });
      const registry = EnvironmentRegistry.of({
        register: () =>
          Effect.sync(() => {
            registerCalls += 1;
          }),
        state: () => Effect.die("onboarding must not inspect supervisor backoff"),
        stateChanges: () => Effect.die("onboarding must not own supervisor retry"),
      } as unknown as EnvironmentRegistry["Service"]);

      const result = yield* registerScaffoldEnvironment(input).pipe(
        Effect.provideService(ScaffoldLifecycleGateway, gateway),
        Effect.provideService(EnvironmentRegistry, registry),
      );

      expect(result.target.environmentId).toBe("remote-environment");
      expect(createCalls).toBe(1);
      expect(registerCalls).toBe(1);
    }),
  );

  it("completes one durable create at registration even when readiness exceeds the old timeout", async () => {
    vi.useFakeTimers();
    let createCalls = 0;
    let registerCalls = 0;
    const action = makeScaffoldLifecycleAction({
      actionId: input.operationId,
      kind: "create",
      deployment: input.deployment,
      draftId: "draft-1",
      sourceEnvironmentId: EnvironmentId.make("source-environment"),
      sourceProjectId: ProjectId.make("source-project"),
      environmentId: EnvironmentId.make("scaffold-pending:draft-1"),
      connectionId: "connection-1",
      sessionId: input.sessionId,
      expectedLifecycleEpoch: 0,
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    const store = createMemoryScaffoldLifecycleActionStore([action]);
    const gateway = ScaffoldLifecycleGateway.of({
      create: () =>
        Effect.sync(() => {
          createCalls += 1;
          return preparedConnection();
        }),
      prepare: () => Effect.die("not used"),
    });
    const registry = EnvironmentRegistry.of({
      register: () =>
        Effect.sync(() => {
          registerCalls += 1;
        }),
      state: () =>
        Effect.succeed({
          desired: true,
          network: "online",
          phase: "backoff",
          stage: null,
          attempt: 1,
          generation: 1,
          lastFailure: null,
          retryAt: Date.now() + 91_000,
        }),
      stateChanges: () =>
        Stream.fromEffect(
          Effect.sleep("91 seconds").pipe(
            Effect.as({
              desired: true,
              network: "online" as const,
              phase: "connected" as const,
              stage: null,
              attempt: 0,
              generation: 1,
              lastFailure: null,
              retryAt: null,
            }),
          ),
        ),
    } as unknown as EnvironmentRegistry["Service"]);
    const execute = () =>
      // This boundary deliberately adapts the Effect onboarding operation to
      // the Promise-based lifecycle outbox contract exercised by this test.
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests
      Effect.runPromise(
        registerScaffoldEnvironment(input).pipe(
          Effect.provideService(ScaffoldLifecycleGateway, gateway),
          Effect.provideService(EnvironmentRegistry, registry),
          Effect.match({
            onFailure: () =>
              ({ _tag: "wait", retryAfterMs: 1_000, errorCode: "transport" }) as const,
            onSuccess: () => ({ _tag: "acknowledged" }) as const,
          }),
        ),
      );

    const firstDrain = drainScaffoldLifecycleActions({ store, execute });
    await vi.advanceTimersByTimeAsync(91_000);
    await firstDrain;
    await drainScaffoldLifecycleActions({ store, execute });

    expect(createCalls).toBe(1);
    expect(registerCalls).toBe(1);
    await expect(store.list()).resolves.toEqual([]);
  });

  it.effect("does not turn a supervisor block into a second create failure", () =>
    Effect.gen(function* () {
      const gateway = ScaffoldLifecycleGateway.of({
        create: () => Effect.succeed(preparedConnection()),
        prepare: () => Effect.die("not used"),
      });
      const registry = EnvironmentRegistry.of({
        register: () => Effect.void,
        state: () => Effect.die("blocked transport is projected by the supervisor"),
      } as unknown as EnvironmentRegistry["Service"]);

      const result = yield* registerScaffoldEnvironment(input).pipe(
        Effect.provideService(ScaffoldLifecycleGateway, gateway),
        Effect.provideService(EnvironmentRegistry, registry),
      );
      expect(result.binding.sessionId).toBe("session-1");
    }),
  );

  it.effect("preserves authentication lifecycle failures for the create coordinator", () =>
    Effect.gen(function* () {
      const lifecycleError = new ScaffoldLifecycleError({
        reason: "authentication",
        message: "remote detail",
        status: 401,
        code: "auth_required",
      });
      const result = runWithLifecycleFailure(lifecycleError);

      const failure = yield* result.failure;
      expect(failure).toBe(lifecycleError);
      expect(result.registered()).toBe(false);
    }),
  );

  it.effect("preserves retryable lifecycle failures for the create coordinator", () =>
    Effect.gen(function* () {
      const lifecycleError = new ScaffoldLifecycleError({
        reason: "network",
        message: "request timed out",
        status: 0,
        code: "scaffold_local_network_error",
      });
      const result = runWithLifecycleFailure(lifecycleError);

      const failure = yield* result.failure;
      expect(failure).toBe(lifecycleError);
      expect(result.registered()).toBe(false);
    }),
  );

  it.effect("preserves preparation-pending retry metadata for the create coordinator", () =>
    Effect.gen(function* () {
      const lifecycleError = new ScaffoldLifecycleError({
        reason: "unavailable",
        message: "Scaffold session is still preparing.",
        status: 202,
        code: "scaffold_preparation_pending",
        retryAfterMs: 2_500,
        observation: new ScaffoldSessionObservation({
          sessionId: "server-minted-session",
          status: "creating",
          lifecycleEpoch: 3,
        }),
      });
      const result = runWithLifecycleFailure(lifecycleError);

      const failure = yield* result.failure;
      expect(failure).toBe(lifecycleError);
      expect(failure).toMatchObject({
        code: "scaffold_preparation_pending",
        retryAfterMs: 2_500,
        observation: {
          sessionId: "server-minted-session",
          lifecycleEpoch: 3,
        },
      });
      expect(result.registered()).toBe(false);
    }),
  );

  it.effect("rejects a mismatched deployment before registering the environment", () =>
    Effect.gen(function* () {
      let registered = false;
      const gateway = ScaffoldLifecycleGateway.of({
        create: () => Effect.succeed(preparedConnection("production")),
        prepare: () => Effect.die("not used"),
      });
      const registry = EnvironmentRegistry.of({
        register: () => {
          registered = true;
          return Effect.void;
        },
      } as unknown as EnvironmentRegistry["Service"]);

      const failure = yield* Effect.flip(
        registerScaffoldEnvironment(input).pipe(
          Effect.provideService(ScaffoldLifecycleGateway, gateway),
          Effect.provideService(EnvironmentRegistry, registry),
        ),
      );

      expect(failure).toBeInstanceOf(ConnectionBlockedError);
      expect(failure).toMatchObject({ reason: "configuration" });
      expect(registered).toBe(false);
    }),
  );
});
