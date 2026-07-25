import {
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

/** UI integration command: pass directly to `useAtomCommand`. */
export const connectScaffoldEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-scaffold",
  scheduler,
  concurrency: { mode: "singleFlight", key: (input) => JSON.stringify(input) },
  execute: (input: {
    readonly deployment: ScaffoldDeployment;
    readonly create: ScaffoldCreateParameters;
    readonly operationId: string;
    readonly sessionId: string;
    readonly label?: string;
  }) =>
    Effect.gen(function* () {
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
      const target = scaffoldTargetFromBinding(
        prepared.binding,
        input.label?.trim() || "Scaffold sandbox",
      );
      yield* registry.register(new ScaffoldConnectionRegistration({ target }));
      return { target, binding: prepared.binding };
    }),
});
