import {
  ConnectionBlockedError,
  EnvironmentRegistry,
  ScaffoldConnectionRegistration,
} from "@t3tools/client-runtime/connection";
import {
  ScaffoldLifecycleGateway,
  scaffoldTargetFromBinding,
} from "@t3tools/client-runtime/scaffold";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  ScaffoldCreateAndPrepareInput,
  type ScaffoldCreateParameters,
  type ScaffoldDeployment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";

const scheduler = createAtomCommandScheduler();

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
    const prepared = yield* gateway.create(
      new ScaffoldCreateAndPrepareInput({
        deployment: input.deployment,
        operationId: input.operationId,
        sessionId: input.sessionId,
        create: input.create,
      }),
    );
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
    // Registration is the durable completion boundary for creation. The
    // environment supervisor owns transport preparation, retry, and blocking
    // after this point; waiting here would give the create outbox a second,
    // competing retry loop for an already-created sandbox.
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
