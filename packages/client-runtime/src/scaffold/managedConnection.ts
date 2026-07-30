import { type ScaffoldLifecycleError, type ScaffoldPreparedConnection } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
  type ConnectionTarget,
  type PreparedConnection,
  ScaffoldConnectionTarget,
} from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { shouldRenewScaffoldTransportGrant } from "./reconcile.ts";

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
    links: binding.links,
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

function isStaleScaffoldAttachGrant(
  error: ConnectionAttemptError,
  prepared: ScaffoldPreparedConnection,
): boolean {
  if (error._tag !== "ConnectionTransientError" || error.reason !== "remote-unavailable") {
    return false;
  }
  const descriptorUrl = environmentEndpointUrl(prepared.httpBaseUrl, "/.well-known/t3/environment");
  return (
    error.detail === `Remote environment endpoint ${descriptorUrl} returned undeclared status 409.`
  );
}

function persistentScaffoldAttachFailure(): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "remote-unavailable",
    detail:
      "Scaffold could not attach this saved session after refreshing its connection. Try reconnecting later or start a new session.",
  });
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
  let preparedResult = yield* input.prepare.pipe(Effect.mapError(mapScaffoldLifecycleError));
  const nowMs = yield* Clock.currentTimeMillis;
  if (shouldRenewScaffoldTransportGrant({ expiresAt: preparedResult.expiresAt, nowMs })) {
    preparedResult = yield* input.prepare.pipe(Effect.mapError(mapScaffoldLifecycleError));
  }
  const authorize = (prepared: ScaffoldPreparedConnection) =>
    remote.authorizeDpop({
      expectedEnvironmentId: prepared.binding.environmentId,
      persistAccessToken: false,
      obtainBootstrap: Effect.succeed({
        environmentId: prepared.binding.environmentId,
        endpoint: {
          httpBaseUrl: prepared.httpBaseUrl,
          wsBaseUrl: prepared.wsBaseUrl,
          providerKind: "manual" as const,
        },
        credential: prepared.bootstrapCredential,
        attachCredential: prepared.attachCredential,
      }),
    });
  const authorized = yield* authorize(preparedResult).pipe(
    Effect.catch((error) => {
      if (!isStaleScaffoldAttachGrant(error, preparedResult)) {
        return Effect.fail(error);
      }
      return Effect.gen(function* () {
        preparedResult = yield* input.prepare.pipe(Effect.mapError(mapScaffoldLifecycleError));
        return yield* authorize(preparedResult).pipe(
          Effect.mapError((retryError) =>
            isStaleScaffoldAttachGrant(retryError, preparedResult)
              ? persistentScaffoldAttachFailure()
              : retryError,
          ),
        );
      });
    }),
  );
  const target = input.targetForBinding(preparedResult.binding);
  return {
    binding: preparedResult.binding,
    connection: {
      ...authorized,
      target,
    } satisfies PreparedConnection,
  };
});
