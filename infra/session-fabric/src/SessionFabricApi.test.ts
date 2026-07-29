import { authorizeSessionFabricCapability } from "@t3tools/shared/sessionFabricCapability";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  normalizeSessionFabricAuthorizationRequestUrl,
  resolveSessionFabricCorsOrigin,
} from "./SessionFabricApi.ts";

const disabledVerifierConfig = { mode: "disabled" as const };

describe("session fabric API authorization URL portability", () => {
  it.effect("accepts a relative local workerd request when authorization is disabled", () =>
    Effect.gen(function* () {
      const result = yield* authorizeSessionFabricCapability({
        config: disabledVerifierConfig,
        authorization: undefined,
        requestUrl: normalizeSessionFabricAuthorizationRequestUrl("/v1/session-fabric/sessions"),
        nowEpochSeconds: 0,
      });

      expect(result).toBeNull();
    }),
  );

  it.effect("keeps an absolute public request fail-closed when authorization is disabled", () =>
    Effect.gen(function* () {
      const result = yield* authorizeSessionFabricCapability({
        config: disabledVerifierConfig,
        authorization: undefined,
        requestUrl: normalizeSessionFabricAuthorizationRequestUrl(
          "https://fabric.example/v1/session-fabric/sessions",
        ),
        nowEpochSeconds: 0,
      }).pipe(Effect.result);

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "unavailable" },
      });
    }),
  );

  it("allows a localhost origin for a relative local workerd request", () => {
    expect(
      resolveSessionFabricCorsOrigin({
        requestUrl: "/v1/session-fabric/sessions",
        origin: "http://localhost:5173/",
        authDisabled: true,
        allowedOrigins: new Set(),
      }),
    ).toBe("http://localhost:5173");
  });

  it("rejects a localhost origin for an absolute public request", () => {
    expect(
      resolveSessionFabricCorsOrigin({
        requestUrl: "https://fabric.example/v1/session-fabric/sessions",
        origin: "http://localhost:5173",
        authDisabled: true,
        allowedOrigins: new Set(),
      }),
    ).toBeNull();
  });
});
