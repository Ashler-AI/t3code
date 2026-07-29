import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";
import { afterEach, vi } from "vite-plus/test";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { scaffoldObserveSessionRouteLayer } from "./http.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

const makeEnvironmentAuthLayer = () =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-scaffold-observation-route-test-",
      }),
    ),
  );

const makeRouteLayer = () =>
  HttpRouter.serve(scaffoldObserveSessionRouteLayer, {
    disableListenLog: true,
    disableLogger: true,
  });

const requestUrl = (input: Parameters<typeof fetch>[0]) =>
  new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

const testLayer = makeEnvironmentAuthLayer().pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/scaffold/observation", () => {
  it.effect("requires read authentication before observing Scaffold", () =>
    Effect.gen(function* () {
      const scaffoldFetch = vi.spyOn(globalThis, "fetch");
      yield* makeRouteLayer().pipe(Layer.build);

      const response = yield* HttpClient.post("/api/scaffold/observation", {
        body: yield* HttpBody.json({ deployment: "staging", sessionId: "ses_1" }),
      });

      expect(response.status).toBe(401);
      expect(
        scaffoldFetch.mock.calls.filter(([input]) =>
          requestUrl(input).hostname.endsWith(".scaffold.test"),
        ),
      ).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("performs exactly one no-store GET for an authenticated observation", () =>
    Effect.gen(function* () {
      vi.stubEnv("T3CODE_SCAFFOLD_STAGING_URL", "https://staging.scaffold.test");
      vi.stubEnv("T3CODE_SCAFFOLD_STAGING_AUTH_MODE", "iap");
      vi.stubEnv("T3CODE_SCAFFOLD_STAGING_AUTHORIZATION", "Bearer staging-server-secret");

      const nativeFetch = globalThis.fetch.bind(globalThis);
      const scaffoldFetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const url = requestUrl(input);
          if (url.origin === "https://staging.scaffold.test") {
            return Response.json({ id: "ses_1", status: "stopped", lifecycleEpoch: 4 });
          }
          return nativeFetch(input, init);
        });

      yield* makeRouteLayer().pipe(Layer.build);
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairing = yield* serverAuth.issuePairingCredential({
        scopes: [AuthOrchestrationReadScope],
      });
      const session = yield* serverAuth.createBrowserSession(pairing.credential, {
        deviceType: "desktop",
        os: "macOS",
        browser: "Chrome",
        ipAddress: "127.0.0.1",
      });
      const descriptor = yield* serverAuth.getDescriptor();

      const response = yield* HttpClient.post("/api/scaffold/observation", {
        headers: {
          cookie: `${descriptor.sessionCookieName}=${session.sessionToken}`,
        },
        body: yield* HttpBody.json({ deployment: "staging", sessionId: "ses_1" }),
      });

      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(yield* response.json).toEqual({
        sessionId: "ses_1",
        status: "stopped",
        lifecycleEpoch: 4,
      });
      const calls = scaffoldFetch.mock.calls.filter(
        ([input]) => requestUrl(input).origin === "https://staging.scaffold.test",
      );
      expect(calls).toHaveLength(1);
      expect(requestUrl(calls[0]![0]).pathname).toBe("/api/sessions/ses_1");
      expect(calls[0]![1]?.method).toBeUndefined();
      expect(new Headers(calls[0]![1]?.headers).get("authorization")).toBe(
        "Bearer staging-server-secret",
      );
    }).pipe(Effect.provide(testLayer)),
  );
});
