import { type SessionFabricCapabilityGrant, SessionFabricSessionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeDisabledSessionFabricAuthorization,
  makeRuntimeSessionFabricAuthorization,
  makeSessionFabricCapabilityAuthorization,
  sessionFabricAuthorizationHeaders,
  sessionFabricWebSocketProtocols,
} from "./sessionFabricAuthorization.ts";

const expiresAt = "2026-07-27T20:10:00.000Z";

function grant(role: "viewer" | "controller", token: string): SessionFabricCapabilityGrant {
  return {
    capability: token,
    tokenType: "Bearer" as const,
    role,
    scopes:
      role === "viewer" ? ["directory:read", "session:read"] : ["session:read", "session:command"],
    expiresAt,
    issuer: "scaffold",
    audience: "session-fabric",
    keyId: "key-1",
    bindings:
      role === "viewer"
        ? {}
        : {
            fabricSessionId: SessionFabricSessionId.make("fabric-1"),
            scaffoldSessionId: "ses-1",
            scaffoldLifecycleEpoch: 2,
          },
  };
}

describe("SessionFabricAuthorization", () => {
  it("selects disabled authorization only for combined loopback local development", () => {
    const base = {
      endpoint: "http://localhost:5733/api/session-fabric/capabilities",
      authMode: "disabled",
      appUrl: "http://localhost:5733/session-fabric:fabric-1/thread-1",
      relayBaseUrl: "http://127.0.0.1:8787",
      localDevAutoAuthEnabled: true,
    } as const;

    expect(makeRuntimeSessionFabricAuthorization(base).mode).toBe("disabled");
    expect(
      makeRuntimeSessionFabricAuthorization({ ...base, appUrl: "http://127.42.0.1:5733" }).mode,
    ).toBe("disabled");
    expect(
      makeRuntimeSessionFabricAuthorization({ ...base, relayBaseUrl: "https://relay.example" })
        .mode,
    ).toBe("capability");
    expect(
      makeRuntimeSessionFabricAuthorization({ ...base, appUrl: "https://t3.example" }).mode,
    ).toBe("capability");
    expect(
      makeRuntimeSessionFabricAuthorization({ ...base, localDevAutoAuthEnabled: false }).mode,
    ).toBe("capability");
    expect(makeRuntimeSessionFabricAuthorization({ ...base, authMode: "required" }).mode).toBe(
      "capability",
    );
  });

  it.effect("single-flights a global viewer capability and refreshes before expiry", () =>
    Effect.gen(function* () {
      let calls = 0;
      let now = Date.parse("2026-07-27T20:00:00.000Z");
      const bodies: unknown[] = [];
      const authorization = makeSessionFabricCapabilityAuthorization({
        endpoint: "https://t3.example/sessions/ses-1/agent/api/session-fabric/capabilities",
        now: () => now,
        fetch: (async (_input, init) => {
          calls += 1;
          bodies.push(JSON.parse(String(init?.body)));
          await Promise.resolve();
          return Response.json(grant("viewer", `viewer-${calls}`));
        }) as typeof fetch,
      });

      const [first, second] = yield* Effect.all([authorization.viewer(), authorization.viewer()], {
        concurrency: "unbounded",
      });
      expect(first?.capability).toBe("viewer-1");
      expect(second?.capability).toBe("viewer-1");
      expect(calls).toBe(1);
      expect(bodies).toEqual([{ role: "viewer" }]);

      now = Date.parse("2026-07-27T20:09:31.000Z");
      expect((yield* authorization.viewer())?.capability).toBe("viewer-2");
      expect(calls).toBe(2);
    }),
  );

  it.effect("acquires a separate exact-session controller capability", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly body: unknown }> = [];
      const authorization = makeSessionFabricCapabilityAuthorization({
        endpoint: "http://127.0.0.1:5733/api/session-fabric/capabilities",
        deployment: "staging",
        now: () => Date.parse("2026-07-27T20:00:00.000Z"),
        fetch: (async (input, init) => {
          calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
          return Response.json(grant("controller", "controller-secret"));
        }) as typeof fetch,
      });

      const result = yield* authorization.controller({
        fabricSessionId: SessionFabricSessionId.make("fabric-1"),
        scaffoldSessionId: "ses-1",
        scaffoldLifecycleEpoch: 2,
      });
      expect(result?.role).toBe("controller");
      expect(calls).toEqual([
        {
          url: "http://127.0.0.1:5733/api/session-fabric/capabilities",
          body: {
            role: "controller",
            fabricSessionId: "fabric-1",
            scaffoldSessionId: "ses-1",
            scaffoldLifecycleEpoch: 2,
            deployment: "staging",
          },
        },
      ]);
      expect(calls[0]!.url).not.toContain("controller-secret");
    }),
  );

  it.effect("rejects a controller capability with a different authoritative binding", () =>
    Effect.gen(function* () {
      const authorization = makeSessionFabricCapabilityAuthorization({
        endpoint: "http://127.0.0.1:5733/api/session-fabric/capabilities",
        fetch: (async () =>
          Response.json({
            ...grant("controller", "controller-secret"),
            bindings: {
              fabricSessionId: SessionFabricSessionId.make("fabric-other"),
              scaffoldSessionId: "ses-1",
              scaffoldLifecycleEpoch: 2,
            },
          })) as typeof fetch,
      });

      const error = yield* authorization
        .controller({
          fabricSessionId: SessionFabricSessionId.make("fabric-1"),
          scaffoldSessionId: "ses-1",
          scaffoldLifecycleEpoch: 2,
        })
        .pipe(Effect.flip);

      expect(error.reason).toBe("invalid-response");
    }),
  );

  it("keeps capabilities only in headers and websocket protocols", () => {
    const viewer = grant("viewer", "viewer-secret");
    expect(sessionFabricAuthorizationHeaders(viewer)).toEqual({
      authorization: "Bearer viewer-secret",
    });
    expect(sessionFabricWebSocketProtocols(viewer)).toEqual([
      "t3.session-fabric.v1",
      "t3.session-fabric.capability.viewer-secret",
    ]);
    expect(sessionFabricWebSocketProtocols(null)).toEqual([]);
    expect(JSON.stringify(makeDisabledSessionFabricAuthorization())).not.toContain("secret");
  });
});
