import {
  EnvironmentId,
  ScaffoldEnvironmentBinding,
  ScaffoldLifecycleError,
  ScaffoldPreparedConnection,
  ScaffoldSessionLinks,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { mapRemoteEnvironmentError } from "../connection/errors.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  RelayConnectionTarget,
  ScaffoldConnectionTarget,
} from "../connection/model.ts";
import { RemoteEnvironmentAuthUndeclaredStatusError } from "../rpc/http.ts";
import {
  prepareManagedScaffoldConnection,
  scaffoldTargetFromBinding,
} from "./managedConnection.ts";

const ENVIRONMENT_ID = EnvironmentId.make("env_scaffold_1");
const binding = new ScaffoldEnvironmentBinding({
  deployment: "staging",
  environmentId: ENVIRONMENT_ID,
  sessionId: "ses_1",
  lifecycleEpoch: 2,
  status: "ready",
  links: new ScaffoldSessionLinks({
    session: "https://scaffold.example.com/?q=ses_1",
    web: "https://scaffold.example.com/sessions/ses_1/web",
    tilt: "https://scaffold.example.com/sessions/ses_1/tilt",
  }),
  lastKnownAt: "2026-07-24T20:00:00.000Z",
});

describe("prepareManagedScaffoldConnection", () => {
  it("preserves safe Scaffold links without persisting transport authority", () => {
    const target = scaffoldTargetFromBinding(binding, "Scaffold staging");

    expect(target).toBeInstanceOf(ScaffoldConnectionTarget);
    expect(target.links).toEqual(binding.links);
    expect(JSON.stringify(target)).not.toContain("bootstrap");
    expect(JSON.stringify(target)).not.toContain("attachCredential");
  });

  it.effect("re-prepares once when the direct descriptor rejects a stale attach grant", () =>
    Effect.gen(function* () {
      let authorizeCount = 0;
      let prepareCount = 0;
      const remote = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
        authorizeBearer: () => Effect.die("not used"),
        authorizeDpop: (input) =>
          Effect.gen(function* () {
            authorizeCount += 1;
            const bootstrap = yield* input.obtainBootstrap;
            if (authorizeCount === 1) {
              const rpcError = new RemoteEnvironmentAuthUndeclaredStatusError(
                "https://sandbox.example.com/.well-known/t3/environment",
                409,
              );
              return yield* mapRemoteEnvironmentError(rpcError);
            }
            return {
              environmentId: ENVIRONMENT_ID,
              label: "Scaffold sandbox",
              httpBaseUrl: bootstrap.endpoint.httpBaseUrl,
              socketUrl: "wss://sandbox.example.com/ws?wsTicket=fresh",
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: "ephemeral-access",
              },
              ...(bootstrap.attachCredential
                ? { scaffoldAttachCredential: bootstrap.attachCredential }
                : {}),
            };
          }),
      });
      const result = yield* prepareManagedScaffoldConnection({
        targetForBinding: (preparedBinding) =>
          new RelayConnectionTarget({
            environmentId: preparedBinding.environmentId,
            label: `Scaffold epoch ${preparedBinding.lifecycleEpoch}`,
          }),
        prepare: Effect.sync(() => {
          prepareCount += 1;
          return new ScaffoldPreparedConnection({
            binding: new ScaffoldEnvironmentBinding({
              ...binding,
              lifecycleEpoch: prepareCount + 1,
            }),
            httpBaseUrl: "https://sandbox.example.com/",
            wsBaseUrl: "wss://sandbox.example.com/",
            bootstrapCredential: `secret-${prepareCount}`,
            attachCredential: `attach-${prepareCount}`,
            expiresAt: "9999-12-31T23:59:59.999Z",
          });
        }),
      }).pipe(
        Effect.provide(
          Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, remote),
        ),
      );

      expect(prepareCount).toBe(2);
      expect(authorizeCount).toBe(2);
      expect(result.binding.lifecycleEpoch).toBe(3);
      expect(result.connection.scaffoldAttachCredential).toBe("attach-2");
      expect(result.connection.target.label).toBe("Scaffold epoch 3");
    }),
  );

  it("preserves structured HTTP failure metadata across the connection error boundary", () => {
    const requestUrl = "https://sandbox.example.com/.well-known/t3/environment";
    const error = mapRemoteEnvironmentError(
      new RemoteEnvironmentAuthUndeclaredStatusError(requestUrl, 409),
    );

    expect(error).toMatchObject({
      _tag: "ConnectionTransientError",
      reason: "remote-unavailable",
      httpStatus: 409,
      requestUrl,
    });
  });

  it.effect("does not re-prepare for a non-descriptor authorization failure", () =>
    Effect.gen(function* () {
      let prepareCount = 0;
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail:
          "Remote environment endpoint https://sandbox.example.com/oauth/token returned undeclared status 409.",
        httpStatus: 409,
        requestUrl: "https://sandbox.example.com/oauth/token",
      });
      const result = yield* Effect.result(
        prepareManagedScaffoldConnection({
          targetForBinding: (preparedBinding) =>
            new RelayConnectionTarget({
              environmentId: preparedBinding.environmentId,
              label: "Scaffold sandbox",
            }),
          prepare: Effect.sync(() => {
            prepareCount += 1;
            return new ScaffoldPreparedConnection({
              binding,
              httpBaseUrl: "https://sandbox.example.com/",
              wsBaseUrl: "wss://sandbox.example.com/",
              bootstrapCredential: "secret",
              attachCredential: "attach",
              expiresAt: "9999-12-31T23:59:59.999Z",
            });
          }),
        }).pipe(
          Effect.provide(
            Layer.succeed(
              RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
              RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
                authorizeBearer: () => Effect.die("not used"),
                authorizeDpop: () => Effect.fail(failure),
              }),
            ),
          ),
        ),
      );

      expect(prepareCount).toBe(1);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: failure._tag,
          reason: failure.reason,
          detail: failure.detail,
        });
      }
    }),
  );

  it.effect("stops automatic retries when a refreshed attach grant receives the same 409", () =>
    Effect.gen(function* () {
      let authorizeCount = 0;
      let prepareCount = 0;
      const descriptorFailure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail:
          "Remote environment endpoint https://sandbox.example.com/.well-known/t3/environment returned undeclared status 409.",
        httpStatus: 409,
        requestUrl: "https://sandbox.example.com/.well-known/t3/environment",
      });
      const result = yield* Effect.result(
        prepareManagedScaffoldConnection({
          targetForBinding: (preparedBinding) =>
            new RelayConnectionTarget({
              environmentId: preparedBinding.environmentId,
              label: "Scaffold sandbox",
            }),
          prepare: Effect.sync(() => {
            prepareCount += 1;
            return new ScaffoldPreparedConnection({
              binding: new ScaffoldEnvironmentBinding({
                ...binding,
                lifecycleEpoch: prepareCount + 1,
              }),
              httpBaseUrl: "https://sandbox.example.com/",
              wsBaseUrl: "wss://sandbox.example.com/",
              bootstrapCredential: `secret-${prepareCount}`,
              attachCredential: `attach-${prepareCount}`,
              expiresAt: "9999-12-31T23:59:59.999Z",
            });
          }),
        }).pipe(
          Effect.provide(
            Layer.succeed(
              RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
              RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
                authorizeBearer: () => Effect.die("not used"),
                authorizeDpop: () => {
                  authorizeCount += 1;
                  return Effect.fail(descriptorFailure);
                },
              }),
            ),
          ),
        ),
      );

      expect(prepareCount).toBe(2);
      expect(authorizeCount).toBe(2);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(ConnectionBlockedError);
        expect(result.failure).toMatchObject({
          reason: "remote-unavailable",
          detail:
            "Scaffold could not attach this saved session after refreshing its connection. Try reconnecting later or start a new session.",
        });
      }
    }),
  );

  it.effect("renews an expired transport grant before direct authorization", () =>
    Effect.gen(function* () {
      const receivedCredentials: string[] = [];
      let prepareCount = 0;
      const remote = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
        authorizeBearer: () => Effect.die("not used"),
        authorizeDpop: (input) =>
          input.obtainBootstrap.pipe(
            Effect.map((bootstrap) => {
              receivedCredentials.push(bootstrap.credential);
              return {
                environmentId: ENVIRONMENT_ID,
                label: "Scaffold sandbox",
                httpBaseUrl: bootstrap.endpoint.httpBaseUrl,
                socketUrl: "wss://sandbox.example.com/ws?wsTicket=fresh",
                httpAuthorization: {
                  _tag: "Dpop" as const,
                  accessToken: "ephemeral-access",
                },
                ...(bootstrap.attachCredential
                  ? { scaffoldAttachCredential: bootstrap.attachCredential }
                  : {}),
              };
            }),
          ),
      });
      const result = yield* prepareManagedScaffoldConnection({
        targetForBinding: (preparedBinding) =>
          new RelayConnectionTarget({
            environmentId: preparedBinding.environmentId,
            label: "Scaffold sandbox",
          }),
        prepare: Effect.sync(() => {
          prepareCount += 1;
          return new ScaffoldPreparedConnection({
            binding,
            httpBaseUrl: "https://sandbox.example.com/",
            wsBaseUrl: "wss://sandbox.example.com/",
            bootstrapCredential: prepareCount === 1 ? "expired-secret" : "fresh-secret",
            attachCredential: prepareCount === 1 ? "expired-attach" : "fresh-attach",
            expiresAt: prepareCount === 1 ? "1970-01-01T00:00:00.000Z" : "9999-12-31T23:59:59.999Z",
          });
        }),
      }).pipe(
        Effect.provide(
          Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, remote),
        ),
      );

      expect(prepareCount).toBe(2);
      expect(receivedCredentials).toEqual(["fresh-secret"]);
      expect(result.connection.scaffoldAttachCredential).toBe("fresh-attach");
    }),
  );

  it.effect("exchanges bootstrap authority in memory and returns only the safe binding", () =>
    Effect.gen(function* () {
      let receivedCredential: string | undefined;
      let receivedAttachCredential: string | undefined;
      let persistAccessToken: boolean | undefined;
      const remote = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
        authorizeBearer: () => Effect.die("not used"),
        authorizeDpop: (input) =>
          input.obtainBootstrap.pipe(
            Effect.map((bootstrap) => {
              receivedCredential = bootstrap.credential;
              receivedAttachCredential = bootstrap.attachCredential;
              persistAccessToken = input.persistAccessToken;
              return {
                environmentId: ENVIRONMENT_ID,
                label: "Scaffold sandbox",
                httpBaseUrl: bootstrap.endpoint.httpBaseUrl,
                socketUrl: "wss://sandbox.example.com/ws?wsTicket=ephemeral",
                httpAuthorization: {
                  _tag: "Dpop" as const,
                  accessToken: "ephemeral-access",
                },
                ...(bootstrap.attachCredential
                  ? { scaffoldAttachCredential: bootstrap.attachCredential }
                  : {}),
              };
            }),
          ),
      });
      const result = yield* prepareManagedScaffoldConnection({
        targetForBinding: (preparedBinding) =>
          new RelayConnectionTarget({
            environmentId: preparedBinding.environmentId,
            label: "Scaffold sandbox",
          }),
        prepare: Effect.succeed(
          new ScaffoldPreparedConnection({
            binding,
            httpBaseUrl: "https://sandbox.example.com/",
            wsBaseUrl: "wss://sandbox.example.com/",
            bootstrapCredential: "one-time-secret",
            attachCredential: "attach-secret",
            expiresAt: "2026-07-24T21:00:00.000Z",
          }),
        ),
      }).pipe(
        Effect.provide(
          Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, remote),
        ),
      );

      expect(receivedCredential).toBe("one-time-secret");
      expect(receivedAttachCredential).toBe("attach-secret");
      expect(persistAccessToken).toBe(false);
      expect(result.binding).toMatchObject({
        environmentId: ENVIRONMENT_ID,
        sessionId: "ses_1",
        lifecycleEpoch: 2,
      });
      expect(result.connection).toMatchObject({
        environmentId: ENVIRONMENT_ID,
        target: { environmentId: ENVIRONMENT_ID },
      });
      expect("bootstrapCredential" in result.binding).toBe(false);
      expect(result.connection.socketUrl).toContain("wsTicket=ephemeral");
      expect(result.connection.scaffoldAttachCredential).toBe("attach-secret");
    }),
  );

  it.effect("maps server-side lifecycle failures to connection failures", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        prepareManagedScaffoldConnection({
          targetForBinding: (preparedBinding) =>
            new RelayConnectionTarget({
              environmentId: preparedBinding.environmentId,
              label: "Scaffold sandbox",
            }),
          prepare: Effect.fail(
            new ScaffoldLifecycleError({
              reason: "authentication",
              message: "raw remote detail",
              status: 401,
              code: "auth_required",
            }),
          ),
        }).pipe(
          Effect.provide(
            Layer.succeed(
              RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
              RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
                authorizeBearer: () => Effect.die("not used"),
                authorizeDpop: (input) => input.obtainBootstrap.pipe(Effect.as({} as never)),
              }),
            ),
          ),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "ConnectionBlockedError",
          reason: "authentication",
        });
      }
    }),
  );
});
