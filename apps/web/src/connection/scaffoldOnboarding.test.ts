import { EnvironmentRegistry, ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import { ScaffoldLifecycleGateway } from "@t3tools/client-runtime/scaffold";
import {
  EnvironmentId,
  ScaffoldEnvironmentBinding,
  ScaffoldLifecycleError,
  ScaffoldPreparedConnection,
  ScaffoldSessionObservation,
  ScaffoldSessionLinks,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

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
  it.effect("does not report the binding until the registered environment is connected", () =>
    Effect.gen(function* () {
      const connectionReady = yield* Deferred.make<void>();
      const registrationObserved = yield* Deferred.make<void>();
      const gateway = ScaffoldLifecycleGateway.of({
        create: () => Effect.succeed(preparedConnection()),
        prepare: () => Effect.die("not used"),
      });
      const registry = EnvironmentRegistry.of({
        register: () => Deferred.succeed(registrationObserved, undefined),
        state: () =>
          Effect.succeed({
            desired: true,
            network: "online",
            phase: "connecting",
            stage: "synchronizing",
            attempt: 0,
            generation: 1,
            lastFailure: null,
            retryAt: null,
          }),
        stateChanges: () =>
          Stream.fromEffect(
            Deferred.await(connectionReady).pipe(
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

      const onboarding = yield* registerScaffoldEnvironment(input).pipe(
        Effect.provideService(ScaffoldLifecycleGateway, gateway),
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.forkChild,
      );
      yield* Deferred.await(registrationObserved);
      expect(onboarding.pollUnsafe()).toBeUndefined();

      yield* Deferred.succeed(connectionReady, undefined);
      const result = yield* Fiber.join(onboarding);
      expect(result.binding.environmentId).toBe("remote-environment");
    }),
  );

  it.effect("surfaces a terminal registry failure instead of projecting the session ready", () =>
    Effect.gen(function* () {
      const connectionFailure = new ConnectionBlockedError({
        reason: "authentication",
        detail: "Scaffold attach authorization expired.",
      });
      const gateway = ScaffoldLifecycleGateway.of({
        create: () => Effect.succeed(preparedConnection()),
        prepare: () => Effect.die("not used"),
      });
      const registry = EnvironmentRegistry.of({
        register: () => Effect.void,
        state: () =>
          Effect.succeed({
            desired: true,
            network: "online",
            phase: "blocked",
            stage: null,
            attempt: 1,
            generation: 1,
            lastFailure: connectionFailure,
            retryAt: null,
          }),
      } as unknown as EnvironmentRegistry["Service"]);

      const failure = yield* Effect.flip(
        registerScaffoldEnvironment(input).pipe(
          Effect.provideService(ScaffoldLifecycleGateway, gateway),
          Effect.provideService(EnvironmentRegistry, registry),
        ),
      );
      expect(failure).toBe(connectionFailure);
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
