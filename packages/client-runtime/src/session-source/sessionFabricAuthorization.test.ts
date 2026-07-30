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

  it.effect("clears a timed-out pending request so the next capability request can retry", () =>
    Effect.gen(function* () {
      let calls = 0;
      const authorization = makeSessionFabricCapabilityAuthorization({
        endpoint: "https://t3.example/api/session-fabric/capabilities",
        requestTimeoutMs: 5,
        fetch: (async (_input, init) => {
          calls += 1;
          if (calls === 1) {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
              });
            });
          }
          return Response.json(grant("viewer", "viewer-after-timeout"));
        }) as typeof fetch,
      });

      const error = yield* authorization.viewer().pipe(Effect.flip);
      expect(error.reason).toBe("network");
      expect((yield* authorization.viewer())?.capability).toBe("viewer-after-timeout");
      expect(calls).toBe(2);
    }),
  );

  it.effect("rejects viewer capabilities carrying any session binding shape", () =>
    Effect.gen(function* () {
      const bindings = [
        { fabricSessionId: "fabric-1" },
        { scaffoldSessionId: "ses-1" },
        { scaffoldLifecycleEpoch: 2 },
        {
          fabricSessionId: "fabric-1",
          environmentKind: "local",
          environmentId: "environment-1",
          threadId: "thread-1",
          actorId: "user-1",
        },
        {
          fabricSessionId: "fabric-1",
          environmentKind: "local",
          environmentId: "environment-1",
          threadId: "thread-1",
          actorId: "user-1",
          runnerId: "runner-1",
        },
      ] as const;

      for (const binding of bindings) {
        const authorization = makeSessionFabricCapabilityAuthorization({
          endpoint: "https://t3.example/api/session-fabric/capabilities",
          fetch: (async () =>
            Response.json({ ...grant("viewer", "viewer"), bindings: binding })) as typeof fetch,
        });
        const error = yield* authorization.viewer().pipe(Effect.flip);
        expect(error.reason).toBe("invalid-response");
      }
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

  it.effect("treats a controller OAuth scope denial as reconnect-required, not read-only", () =>
    Effect.gen(function* () {
      const authorization = makeSessionFabricCapabilityAuthorization({
        endpoint: "http://127.0.0.1:5733/api/session-fabric/capabilities",
        fetch: (async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { role: "viewer" | "controller" };
          return body.role === "viewer"
            ? Response.json(grant("viewer", "viewer-secret"))
            : Response.json({ error: "remote_code_token_forbidden" }, { status: 403 });
        }) as typeof fetch,
      });

      expect((yield* authorization.viewer())?.role).toBe("viewer");
      const error = yield* authorization
        .controller({
          fabricSessionId: SessionFabricSessionId.make("fabric-1"),
          scaffoldSessionId: "ses-1",
          scaffoldLifecycleEpoch: 2,
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe("authentication");
      expect(error.status).toBe(403);
      expect(error.detail).toContain("Reconnect Scaffold");
      expect(error.detail).not.toContain("read-only");
    }),
  );

  it.effect("keeps a Scaffold control ownership denial classified as read-only", () =>
    Effect.gen(function* () {
      const authorization = makeSessionFabricCapabilityAuthorization({
        endpoint: "http://127.0.0.1:5733/api/session-fabric/capabilities",
        fetch: (async () =>
          Response.json(
            { error: "session_fabric_control_forbidden" },
            { status: 403 },
          )) as typeof fetch,
      });
      const error = yield* authorization
        .controller({
          fabricSessionId: SessionFabricSessionId.make("fabric-1"),
          scaffoldSessionId: "ses-1",
          scaffoldLifecycleEpoch: 2,
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe("permission");
      expect(error.detail).toContain("read-only");
      expect(error.detail).not.toContain("Reconnect Scaffold");
    }),
  );

  it.effect("acquires a local controller capability without any Scaffold binding", () =>
    Effect.gen(function* () {
      const bodies: unknown[] = [];
      const authorization = makeSessionFabricCapabilityAuthorization({
        endpoint: "http://127.0.0.1:5733/api/session-fabric/capabilities",
        now: () => Date.parse("2026-07-27T20:00:00.000Z"),
        fetch: (async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return Response.json({
            capability: "local.controller.token",
            tokenType: "Bearer",
            role: "controller",
            scopes: ["session:read", "session:command"],
            expiresAt,
            issuer: "scaffold",
            audience: "session-fabric",
            keyId: "key-1",
            bindings: {
              fabricSessionId: "fabric-local",
              environmentKind: "local",
              environmentId: "environment-local",
              threadId: "thread-local",
            },
          });
        }) as typeof fetch,
      });
      const result = yield* authorization.controller({
        fabricSessionId: SessionFabricSessionId.make("fabric-local"),
        environmentKind: "local",
        environmentId: "environment-local",
        threadId: "thread-local",
      });
      expect(result?.bindings).toMatchObject({
        environmentKind: "local",
      });
      expect(bodies).toEqual([
        {
          role: "controller",
          fabricSessionId: "fabric-local",
          environmentKind: "local",
          environmentId: "environment-local",
          threadId: "thread-local",
        },
      ]);
    }),
  );

  it.effect("rejects a local controller capability with a different response binding", () =>
    Effect.gen(function* () {
      const authorization = makeSessionFabricCapabilityAuthorization({
        endpoint: "http://127.0.0.1:5733/api/session-fabric/capabilities",
        fetch: (async () =>
          Response.json({
            capability: "local.controller.token",
            tokenType: "Bearer",
            role: "controller",
            scopes: ["session:read", "session:command"],
            expiresAt,
            issuer: "scaffold",
            audience: "session-fabric",
            keyId: "key-1",
            bindings: {
              fabricSessionId: "fabric-local",
              environmentKind: "local",
              environmentId: "environment-other",
              threadId: "thread-local",
            },
          })) as typeof fetch,
      });

      const error = yield* authorization
        .controller({
          fabricSessionId: SessionFabricSessionId.make("fabric-local"),
          environmentKind: "local",
          environmentId: "environment-local",
          threadId: "thread-local",
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
