import { type ScaffoldLifecycleError, type ScaffoldPreparedConnection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
  type ConnectionTarget,
  type PreparedConnection,
  ScaffoldConnectionTarget,
} from "../connection/model.ts";

export class ScaffoldLifecycleGateway extends Context.Service<
  ScaffoldLifecycleGateway,
  {
    readonly create: (
      input: Extract<
        import("@t3tools/contracts").ScaffoldPrepareConnectionInput,
        { readonly _tag: "ScaffoldCreateAndPrepareInput" }
      >,
    ) => Effect.Effect<ScaffoldPreparedConnection, ScaffoldLifecycleError>;
    readonly prepare: (
      target: ScaffoldConnectionTarget,
    ) => Effect.Effect<ScaffoldPreparedConnection, ScaffoldLifecycleError>;
  }
>()("@t3tools/client-runtime/scaffold/managedConnection/ScaffoldLifecycleGateway") {}

export function scaffoldTargetFromBinding(
  binding: ScaffoldPreparedConnection["binding"],
  label: string,
): ScaffoldConnectionTarget {
  return new ScaffoldConnectionTarget({
    environmentId: binding.environmentId,
    label,
    deployment: binding.deployment,
    sessionId: binding.sessionId,
    lifecycleEpoch: binding.lifecycleEpoch,
  });
}

export function mapScaffoldLifecycleError(error: ScaffoldLifecycleError): ConnectionAttemptError {
  switch (error.reason) {
    case "authentication":
      return new ConnectionBlockedError({
        reason: "authentication",
        detail: "Scaffold authentication is required.",
      });
    case "configuration":
      return new ConnectionBlockedError({
        reason: "configuration",
        detail: error.message,
      });
    case "terminal":
    case "not_found":
      return new ConnectionBlockedError({
        reason: "unsupported",
        detail: error.message,
      });
    case "conflict":
    case "network":
    case "invalid_response":
    case "unavailable":
      return new ConnectionTransientError({
        reason: error.reason === "network" ? "network" : "remote-unavailable",
        detail: error.message,
      });
  }
}

/**
 * Bridges the local-server lifecycle RPC to T3's ordinary direct remote auth.
 * Only the credential-free binding is returned for persistence. Bootstrap and
 * access authority exist solely inside this connection attempt.
 */
export const prepareManagedScaffoldConnection = Effect.fn(
  "clientRuntime.scaffold.prepareManagedConnection",
)(function* (input: {
  readonly prepare: Effect.Effect<ScaffoldPreparedConnection, ScaffoldLifecycleError>;
  readonly targetForBinding: (binding: ScaffoldPreparedConnection["binding"]) => ConnectionTarget;
}) {
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
  const preparedResult = yield* input.prepare.pipe(Effect.mapError(mapScaffoldLifecycleError));
  const target = input.targetForBinding(preparedResult.binding);
  const authorized = yield* remote.authorizeDpop({
    expectedEnvironmentId: preparedResult.binding.environmentId,
    persistAccessToken: false,
    obtainBootstrap: Effect.succeed({
      environmentId: preparedResult.binding.environmentId,
      endpoint: {
        httpBaseUrl: preparedResult.httpBaseUrl,
        wsBaseUrl: preparedResult.wsBaseUrl,
        providerKind: "manual" as const,
      },
      credential: preparedResult.bootstrapCredential,
    }),
  });
  return {
    binding: preparedResult.binding,
    connection: {
      ...authorized,
      target,
    } satisfies PreparedConnection,
  };
});
