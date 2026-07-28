import {
  ConnectionBlockedError,
  ConnectionTransientError,
  EnvironmentRegistry,
  ScaffoldConnectionRegistration,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  ScaffoldLifecycleGateway,
  mapScaffoldLifecycleError,
  scaffoldTargetFromBinding,
} from "@t3tools/client-runtime/scaffold";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  ScaffoldCreateAndPrepareInput,
  type EnvironmentId,
  type ScaffoldCreateParameters,
  type ScaffoldDeployment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "./runtime";

const scheduler = createAtomCommandScheduler();
const SCAFFOLD_CONNECTION_READY_TIMEOUT = "90 seconds";

export const awaitScaffoldEnvironmentConnected = Effect.fn(
  "web.scaffold.awaitEnvironmentConnected",
)(function* (registry: EnvironmentRegistry["Service"], environmentId: EnvironmentId) {
  const isTerminal = (state: SupervisorConnectionState) =>
    state.phase === "connected" ||
    ((state.phase === "blocked" || state.phase === "backoff" || state.phase === "offline") &&
      state.lastFailure !== null);
  const current = yield* registry.state(environmentId);
  const terminal = isTerminal(current)
    ? current
    : yield* registry.stateChanges(environmentId).pipe(
        Stream.filter(isTerminal),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.timeoutOrElse({
          duration: SCAFFOLD_CONNECTION_READY_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new ConnectionTransientError({
                reason: "timeout",
                detail: "Scaffold connected, but the agent environment did not become ready.",
              }),
            ),
        }),
      );
  if (terminal.phase === "connected") return;
  return yield* (
    terminal.lastFailure ??
      new ConnectionTransientError({
        reason: "transport",
        detail: "Scaffold connected, but the agent environment is unavailable.",
      })
  );
});

export const registerScaffoldEnvironment = Effect.fn("web.scaffold.registerEnvironment")(
  function* (input: {
    readonly deployment: ScaffoldDeployment;
    readonly create: ScaffoldCreateParameters;
    readonly operationId: string;
    readonly sessionId: string;
    readonly label?: string;
  }) {
    const gateway = yield* ScaffoldLifecycleGateway;
    const registry = yield* EnvironmentRegistry;
    const prepared = yield* gateway
      .create(
        new ScaffoldCreateAndPrepareInput({
          deployment: input.deployment,
          operationId: input.operationId,
          sessionId: input.sessionId,
          create: input.create,
        }),
      )
      .pipe(Effect.mapError(mapScaffoldLifecycleError));
    if (prepared.binding.deployment !== input.deployment) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "Scaffold returned a different deployment than requested.",
      });
    }
    const target = scaffoldTargetFromBinding(
      prepared.binding,
      input.label?.trim() || "Scaffold sandbox",
    );
    yield* registry.register(new ScaffoldConnectionRegistration({ target }));
    yield* awaitScaffoldEnvironmentConnected(registry, target.environmentId);
    return { target, binding: prepared.binding };
  },
);

/** UI integration command: pass directly to `useAtomCommand`. */
export const connectScaffoldEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-scaffold",
  scheduler,
  concurrency: { mode: "singleFlight", key: (input) => JSON.stringify(input) },
  execute: registerScaffoldEnvironment,
});
