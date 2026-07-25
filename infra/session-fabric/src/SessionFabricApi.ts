import {
  SessionFabricContextRequest,
  SessionFabricSearchRequest,
} from "@t3tools/contracts/session-fabric";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import SessionDirectory from "../../relay/src/sessionFabric/SessionDirectory.ts";
import SessionStreamCoordinator from "../../relay/src/sessionFabric/SessionStreamCoordinator.ts";
import { resolveSessionFabricRoute } from "./route.ts";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "content-type",
} as const;

const PREFLIGHT_HEADERS = {
  ...CORS_HEADERS,
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
} as const;

const withCors = (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.setHeaders(response, CORS_HEADERS);

export default class SessionFabricApi extends Cloudflare.Worker<SessionFabricApi>()(
  "SessionFabricApi",
  {
    name: "ashler-session-fabric-proof",
    main: import.meta.filename,
    compatibility: {
      date: "2026-05-22",
      flags: ["nodejs_compat"],
    },
    dev: {
      host: "127.0.0.1",
      port: 8788,
      strictPort: true,
    },
    observability: { enabled: true },
  },
  Effect.gen(function* () {
    const sessionStreams = yield* SessionStreamCoordinator;
    const sessionDirectory = yield* SessionDirectory;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.method === "OPTIONS") {
          return HttpServerResponse.empty({ status: 204, headers: PREFLIGHT_HEADERS });
        }

        const route = resolveSessionFabricRoute(
          request.method,
          new URL(request.url, "http://session-fabric.local"),
        );
        switch (route.type) {
          case "health":
            return withCors(HttpServerResponse.jsonUnsafe({ ok: true }));
          case "directory": {
            const sessions = yield* sessionDirectory.getByName("public-session-directory").list();
            return withCors(
              HttpServerResponse.jsonUnsafe(
                { sessions },
                { headers: { "cache-control": "no-store" } },
              ),
            );
          }
          case "search": {
            const decoded = yield* Effect.result(
              HttpServerRequest.schemaBodyJson(SessionFabricSearchRequest),
            );
            if (decoded._tag === "Failure") {
              return withCors(
                HttpServerResponse.text("Invalid session search request", { status: 400 }),
              );
            }
            const response = yield* sessionDirectory
              .getByName("public-session-directory")
              .search(decoded.success);
            return withCors(
              HttpServerResponse.jsonUnsafe(response, {
                headers: { "cache-control": "no-store" },
              }),
            );
          }
          case "context": {
            const decoded = yield* Effect.result(
              HttpServerRequest.schemaBodyJson(SessionFabricContextRequest),
            );
            if (decoded._tag === "Failure") {
              return withCors(
                HttpServerResponse.text("Invalid session context request", { status: 400 }),
              );
            }
            const context = yield* sessionStreams
              .getByName(decoded.success.sessionId)
              .getContext(decoded.success.includeCodeDiff, decoded.success.includeContinuation);
            return withCors(
              context === null
                ? HttpServerResponse.empty({ status: 404 })
                : HttpServerResponse.jsonUnsafe(context, {
                    headers: { "cache-control": "no-store" },
                  }),
            );
          }
          case "session": {
            const response = yield* sessionStreams.getByName(route.sessionId).fetch(request);
            // A 101 response owns immutable upgrade headers in workerd. WebSocket
            // clients do not use CORS response headers, so forward the upgrade
            // untouched and decorate only ordinary HTTP reads.
            return request.headers.upgrade?.toLowerCase() === "websocket"
              ? response
              : withCors(response);
          }
          case "not-found":
            return withCors(HttpServerResponse.empty({ status: 404 }));
        }
      }),
    };
  }),
) {}
