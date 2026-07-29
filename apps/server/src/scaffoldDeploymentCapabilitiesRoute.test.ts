import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpRouter } from "effect/unstable/http";
import { afterEach, vi } from "vite-plus/test";

import * as ServerConfig from "./config.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { scaffoldDeploymentCapabilitiesRouteLayer } from "./http.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

const makeEnvironmentAuthLayer = () =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-scaffold-deployments-route-test-",
      }),
    ),
  );

const makeRouteLayer = () =>
  HttpRouter.serve(scaffoldDeploymentCapabilitiesRouteLayer, {
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

describe("GET /api/scaffold/deployments", () => {
  it.effect("requires authentication before probing Scaffold", () =>
    Effect.gen(function* () {
      const scaffoldFetch = vi.spyOn(globalThis, "fetch");
      yield* makeRouteLayer().pipe(Layer.build);

      const response = yield* HttpClient.get("/api/scaffold/deployments");

      expect(response.status).toBe(401);
      expect(
        scaffoldFetch.mock.calls.filter(([input]) =>
          requestUrl(input).hostname.endsWith(".scaffold.test"),
        ),
      ).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns safe deployment capabilities to an authenticated local browser session", () =>
    Effect.gen(function* () {
      vi.stubEnv("T3CODE_SCAFFOLD_STAGING_URL", "https://staging.scaffold.test");
      vi.stubEnv("T3CODE_SCAFFOLD_STAGING_AUTH_MODE", "iap");
      vi.stubEnv("T3CODE_SCAFFOLD_STAGING_AUTHORIZATION", "Bearer staging-server-secret");
      vi.stubEnv("T3CODE_SCAFFOLD_PRODUCTION_URL", "https://production.scaffold.test");
      vi.stubEnv("T3CODE_SCAFFOLD_PRODUCTION_AUTH_MODE", "iap");
      vi.stubEnv("T3CODE_SCAFFOLD_PRODUCTION_AUTHORIZATION", "Bearer production-server-secret");

      const nativeFetch = globalThis.fetch.bind(globalThis);
      const scaffoldFetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const url = requestUrl(input);
          if (url.origin === "https://staging.scaffold.test") {
            return Response.json({ sessions: [] });
          }
          if (url.origin === "https://production.scaffold.test") {
            return Response.json({ error: "remote_code_sandbox_not_found" }, { status: 404 });
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

      const response = yield* HttpClient.get("/api/scaffold/deployments", {
        headers: {
          cookie: `${descriptor.sessionCookieName}=${session.sessionToken}`,
        },
      });
      const body = yield* response.json;

      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(body).toEqual({
        deployments: [
          {
            deployment: "staging",
            status: "available",
            description: "New Scaffold sandbox",
          },
          {
            deployment: "production",
            status: "unsupported",
            description: "Agent sessions are not available in this deployment",
          },
        ],
      });
      expect(
        scaffoldFetch.mock.calls
          .filter(([input]) => requestUrl(input).hostname.endsWith(".scaffold.test"))
          .map(([input, init]) => [
            requestUrl(input).hostname,
            new Headers(init?.headers).get("authorization"),
          ]),
      ).toEqual([
        ["staging.scaffold.test", "Bearer staging-server-secret"],
        ["production.scaffold.test", "Bearer production-server-secret"],
      ]);
      expect(body).not.toHaveProperty("authorization");
      expect(body).not.toHaveProperty("credential");
    }).pipe(Effect.provide(testLayer)),
  );
});
