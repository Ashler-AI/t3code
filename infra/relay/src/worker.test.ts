import { describe, expect, it } from "@effect/vitest";
import { sessionFabricWebSocketProtocols } from "@t3tools/shared/sessionFabricCapability";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import {
  forwardRelaySessionFabricRequest,
  resolveRelaySessionFabricRequestAuthorization,
} from "./worker.ts";

describe("relay session fabric forwarding", () => {
  it.effect("forwards canonical HTTP authorization through the real Web request conversion", () =>
    Effect.gen(function* () {
      const url =
        "https://relay.example/v1/session-fabric/sessions/sf%3Aenv%3Athread/snapshot?cursor=7";
      const canonicalAuthorization = "Bearer canonical-capability";
      const protocol = sessionFabricWebSocketProtocols("canonical-capability").join(", ");

      for (const rawAuthorization of [undefined, "Bearer decoy-capability"]) {
        const headers = new Headers({
          "sec-websocket-protocol": protocol,
        });
        if (rawAuthorization !== undefined) headers.set("authorization", rawAuthorization);
        const rawRequest = new Request(url, { method: "GET", headers });
        const sourceRequest = HttpServerRequest.fromWeb(rawRequest);
        const request = sourceRequest.modify({
          headers: { ...sourceRequest.headers, authorization: canonicalAuthorization },
        });
        const resolvedAuthorization = resolveRelaySessionFabricRequestAuthorization(request);

        const forwarded = yield* HttpServerRequest.toWeb(
          forwardRelaySessionFabricRequest({ request, rawRequest, resolvedAuthorization }),
        );

        expect(resolvedAuthorization).toBe(canonicalAuthorization);
        expect(forwarded).not.toBe(rawRequest);
        expect(forwarded.url).toBe(url);
        expect(forwarded.method).toBe("GET");
        expect(forwarded.headers.get("authorization")).toBe(canonicalAuthorization);
        expect(forwarded.headers.get("sec-websocket-protocol")).toBe(protocol);
      }
    }),
  );

  it.effect("keeps WebSocket forwarding on the original request source", () =>
    Effect.gen(function* () {
      const protocol = sessionFabricWebSocketProtocols("canonical-capability").join(", ");
      const rawRequest = new Request(
        "https://relay.example/v1/session-fabric/sessions/sf%3Aenv%3Athread/connect",
        {
          method: "GET",
          headers: { upgrade: "websocket", "sec-websocket-protocol": protocol },
        },
      );
      const request = HttpServerRequest.fromWeb(rawRequest);
      const resolvedAuthorization = resolveRelaySessionFabricRequestAuthorization(request);

      const forwardedRequest = forwardRelaySessionFabricRequest({
        request,
        rawRequest,
        resolvedAuthorization,
      });
      const forwarded = yield* HttpServerRequest.toWeb(forwardedRequest);

      expect(resolvedAuthorization).toBe("Bearer canonical-capability");
      expect(forwardedRequest).toBe(request);
      expect(forwarded).toBe(rawRequest);
      expect(forwarded.headers.get("authorization")).toBeNull();
      expect(forwarded.headers.get("sec-websocket-protocol")).toBe(protocol);
      expect(forwarded.headers.get("upgrade")).toBe("websocket");
    }),
  );
});
