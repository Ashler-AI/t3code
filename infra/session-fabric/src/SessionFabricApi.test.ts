import * as NodeCrypto from "node:crypto";

import {
  type SessionFabricCapabilityClaims,
  SessionFabricRunnerId,
} from "@t3tools/contracts/session-fabric";
import {
  authorizeSessionFabricCapability,
  sessionFabricWebSocketProtocols,
  signSessionFabricCapability,
} from "@t3tools/shared/sessionFabricCapability";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import {
  finalizeSessionFabricSessionResponse,
  forwardSessionFabricRequest,
  normalizeSessionFabricAuthorizationRequestUrl,
  resolveSessionFabricCorsOrigin,
  resolveSessionFabricRequestAuthorization,
} from "./SessionFabricApi.ts";
import { resolveSessionFabricRoute } from "./route.ts";

const disabledVerifierConfig = { mode: "disabled" as const };
const NOW = 1_785_000_000;
const keys = NodeCrypto.generateKeyPairSync("ed25519", {
  publicKeyEncoding: { format: "pem", type: "spki" },
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
});
const verifierConfig = {
  mode: "required" as const,
  issuer: "https://scaffold.example",
  audience: "ashler-session-fabric",
  publicKeys: { current: keys.publicKey },
};
const runnerClaims = {
  v: 1,
  iss: verifierConfig.issuer,
  aud: verifierConfig.audience,
  sub: "sandbox-1",
  jti: "capability-1",
  iat: NOW,
  nbf: NOW - 1,
  exp: NOW + 60,
  role: "runner",
  runnerId: SessionFabricRunnerId.make("runner-1"),
  scopes: ["session:publish", "session:execute"],
  scaffoldSessionId: "ses_1",
  scaffoldLifecycleEpoch: 7,
} as const satisfies SessionFabricCapabilityClaims;

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

describe("session fabric API session forwarding", () => {
  it.effect("forwards canonical HTTP authorization through the real Web request conversion", () =>
    Effect.gen(function* () {
      const url =
        "https://fabric.example/v1/session-fabric/sessions/sf%3Aenv%3Athread/snapshot?cursor=7";
      const capability = yield* signSessionFabricCapability({
        privateKey: keys.privateKey,
        keyId: "current",
        claims: runnerClaims,
      });
      const protocol = sessionFabricWebSocketProtocols(capability).join(", ");
      const canonicalAuthorization = `Bearer ${capability}`;

      for (const rawAuthorization of [undefined, "Bearer decoy-capability"]) {
        const headers = new Headers({
          "sec-websocket-protocol": protocol,
        });
        if (rawAuthorization !== undefined) headers.set("authorization", rawAuthorization);
        const rawRequest = new Request(url, { method: "GET", headers });
        const sourceRequest = HttpServerRequest.fromWeb(rawRequest);
        const outerRequest = sourceRequest.modify({
          headers: { ...sourceRequest.headers, authorization: canonicalAuthorization },
        });
        const resolvedAuthorization = resolveSessionFabricRequestAuthorization({
          authorization: outerRequest.headers.authorization,
          upgrade: outerRequest.headers.upgrade,
          websocketProtocol: outerRequest.headers["sec-websocket-protocol"],
        });

        const forwarded = yield* HttpServerRequest.toWeb(
          forwardSessionFabricRequest({
            request: outerRequest,
            rawRequest,
            resolvedAuthorization,
          }),
        );

        expect(resolvedAuthorization).toBe(canonicalAuthorization);
        expect(forwarded).not.toBe(rawRequest);
        expect(forwarded.url).toBe(url);
        expect(forwarded.method).toBe("GET");
        expect(forwarded.headers.get("authorization")).toBe(canonicalAuthorization);
        expect(forwarded.headers.get("sec-websocket-protocol")).toBe(protocol);
        expect(
          yield* authorizeSessionFabricCapability({
            config: verifierConfig,
            authorization: forwarded.headers.get("authorization") ?? undefined,
            requestUrl: forwarded.url,
            nowEpochSeconds: NOW,
          }),
        ).toEqual(runnerClaims);
      }
    }),
  );

  it.effect("keeps WebSocket forwarding on the original request source", () =>
    Effect.gen(function* () {
      const capability = yield* signSessionFabricCapability({
        privateKey: keys.privateKey,
        keyId: "current",
        claims: runnerClaims,
      });
      const protocol = sessionFabricWebSocketProtocols(capability).join(", ");
      const rawRequest = new Request(
        "https://fabric.example/v1/session-fabric/sessions/sf%3Aenv%3Athread/connect",
        {
          method: "GET",
          headers: { upgrade: "websocket", "sec-websocket-protocol": protocol },
        },
      );
      const request = HttpServerRequest.fromWeb(rawRequest);
      const resolvedAuthorization = resolveSessionFabricRequestAuthorization({
        authorization: request.headers.authorization,
        upgrade: request.headers.upgrade,
        websocketProtocol: request.headers["sec-websocket-protocol"],
      });

      const forwardedRequest = forwardSessionFabricRequest({
        request,
        rawRequest,
        resolvedAuthorization,
      });
      const forwarded = yield* HttpServerRequest.toWeb(forwardedRequest);

      expect(resolvedAuthorization).toBe(`Bearer ${capability}`);
      expect(forwardedRequest).toBe(request);
      expect(forwarded).toBe(rawRequest);
      expect(forwarded.headers.get("authorization")).toBeNull();
      expect(forwarded.headers.get("sec-websocket-protocol")).toBe(protocol);
      expect(forwarded.headers.get("upgrade")).toBe("websocket");
    }),
  );
});

describe("session fabric API WebSocket authorization", () => {
  it.effect("authorizes a session upgrade from its capability subprotocol", () =>
    Effect.gen(function* () {
      const capability = yield* signSessionFabricCapability({
        privateKey: keys.privateKey,
        keyId: "current",
        claims: runnerClaims,
      });
      const protocols = sessionFabricWebSocketProtocols(capability);
      const authorization = resolveSessionFabricRequestAuthorization({
        authorization: undefined,
        upgrade: "websocket",
        websocketProtocol: protocols.join(", "),
      });

      expect(
        yield* authorizeSessionFabricCapability({
          config: verifierConfig,
          authorization,
          requestUrl: "https://fabric.example/v1/session-fabric/sessions/sf%3Aenv%3Athread/connect",
          nowEpochSeconds: NOW,
        }),
      ).toEqual(runnerClaims);
      expect(
        resolveSessionFabricRoute(
          "GET",
          new URL("https://fabric.example/v1/session-fabric/sessions/sf%3Aenv%3Athread/connect"),
        ),
      ).toEqual({ type: "session", sessionId: "sf:env:thread" });
    }),
  );

  it.effect("rejects anonymous and malformed WebSocket capability protocols", () =>
    Effect.gen(function* () {
      const protocolHeaders = [
        undefined,
        "t3.session-fabric.capability.header.payload.signature",
        "t3.session-fabric.v1, t3.session-fabric.capability.not-a-capability",
      ];

      for (const websocketProtocol of protocolHeaders) {
        const result = yield* authorizeSessionFabricCapability({
          config: verifierConfig,
          authorization: resolveSessionFabricRequestAuthorization({
            authorization: undefined,
            upgrade: "websocket",
            websocketProtocol,
          }),
          requestUrl: "https://fabric.example/v1/session-fabric/sessions/sf%3Aenv%3Athread/connect",
          nowEpochSeconds: NOW,
        }).pipe(Effect.result);

        expect(result).toMatchObject({ _tag: "Failure" });
      }
    }),
  );

  it.effect("preserves HTTP Bearer authorization outside WebSocket upgrades", () =>
    Effect.gen(function* () {
      const capability = yield* signSessionFabricCapability({
        privateKey: keys.privateKey,
        keyId: "current",
        claims: runnerClaims,
      });
      const authorization = `Bearer ${capability}`;

      expect(
        resolveSessionFabricRequestAuthorization({
          authorization,
          upgrade: undefined,
          websocketProtocol: sessionFabricWebSocketProtocols(capability).join(", "),
        }),
      ).toBe(authorization);
      expect(
        yield* authorizeSessionFabricCapability({
          config: verifierConfig,
          authorization,
          requestUrl: "https://fabric.example/v1/session-fabric/sessions",
          nowEpochSeconds: NOW,
        }),
      ).toEqual(runnerClaims);
    }),
  );

  it("forwards the selected WebSocket subprotocol response untouched", () => {
    const response = {
      status: 101,
      headers: { "sec-websocket-protocol": "t3.session-fabric.v1" },
    };

    expect(
      finalizeSessionFabricSessionResponse({
        upgrade: "WebSocket",
        response,
        withCors: () => {
          throw new Error("WebSocket upgrades must not be decorated");
        },
      }),
    ).toBe(response);
  });
});
