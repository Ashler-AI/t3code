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
import { RelayConnectionTarget } from "../connection/model.ts";
import { prepareManagedScaffoldConnection } from "./managedConnection.ts";

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
