import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  SessionFabricSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";
import { afterEach, vi } from "vite-plus/test";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { scaffoldSessionFabricCapabilityRouteLayer } from "./http.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

const makeEnvironmentAuthLayer = () =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-session-fabric-capability-route-test-",
      }),
    ),
  );

const makeRouteLayer = () =>
  HttpRouter.serve(scaffoldSessionFabricCapabilityRouteLayer, {
    disableListenLog: true,
    disableLogger: true,
  });

const requestUrl = (input: Parameters<typeof fetch>[0]) =>
  new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

const testLayer = makeEnvironmentAuthLayer().pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
);

const JsonRecordFromString = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonRecord = Schema.decodeUnknownSync(JsonRecordFromString);
const encodeJsonRecord = Schema.encodeSync(JsonRecordFromString);

const authenticatedCookie = Effect.gen(function* () {
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const pairing = yield* serverAuth.issuePairingCredential({
    scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
  });
  const session = yield* serverAuth.createBrowserSession(pairing.credential, {
    deviceType: "desktop",
    os: "macOS",
    browser: "Chrome",
    ipAddress: "127.0.0.1",
  });
  const descriptor = yield* serverAuth.getDescriptor();
  return `${descriptor.sessionCookieName}=${session.sessionToken}`;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/session-fabric/capabilities", () => {
  it.effect("forwards exact Scaffold and local controller bindings", () =>
    Effect.gen(function* () {
      vi.stubEnv("T3CODE_SCAFFOLD_STAGING_URL", "https://staging.scaffold.test");
      vi.stubEnv("T3CODE_SCAFFOLD_STAGING_AUTH_MODE", "iap");
      vi.stubEnv("T3CODE_SCAFFOLD_STAGING_AUTHORIZATION", "Bearer staging-server-secret");

      const forwardedBodies: Array<unknown> = [];
      const nativeFetch = globalThis.fetch.bind(globalThis);
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = requestUrl(input);
        if (url.origin !== "https://staging.scaffold.test") return nativeFetch(input, init);
        const body = decodeJsonRecord(String(init?.body));
        forwardedBodies.push(body);
        const local = body.environmentKind === "local";
        return Response.json({
          capability: "header.payload.signature",
          tokenType: "Bearer",
          role: "controller",
          scopes: ["session:read", "session:command"],
          expiresAt: "2099-07-24T20:01:00.000Z",
          issuer: "scaffold",
          audience: "session-fabric",
          keyId: "proof-1",
          bindings: local
            ? {
                fabricSessionId: body.fabricSessionId,
                environmentKind: body.environmentKind,
                environmentId: body.environmentId,
                threadId: body.threadId,
              }
            : {
                fabricSessionId: body.fabricSessionId,
                scaffoldSessionId: body.scaffoldSessionId,
                scaffoldLifecycleEpoch: body.scaffoldLifecycleEpoch,
              },
        });
      });

      yield* makeRouteLayer().pipe(Layer.build);
      const cookie = yield* authenticatedCookie;
      const scaffoldBinding = {
        role: "controller" as const,
        fabricSessionId: SessionFabricSessionId.make("sf:scaffold-env:scaffold-thread"),
        scaffoldSessionId: "ses_1",
        scaffoldLifecycleEpoch: 7,
      };
      const localBinding = {
        role: "controller" as const,
        fabricSessionId: SessionFabricSessionId.make("sf:env_1:thread_1"),
        environmentKind: "local" as const,
        environmentId: EnvironmentId.make("env_1"),
        threadId: ThreadId.make("thread_1"),
      };

      for (const body of [scaffoldBinding, localBinding]) {
        const response = yield* HttpClient.post("/api/session-fabric/capabilities", {
          headers: { cookie },
          body: yield* HttpBody.json(body),
        });
        expect(response.status).toBe(200);
      }

      expect(forwardedBodies).toEqual([scaffoldBinding, localBinding]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects mixed and excess bindings before contacting Scaffold", () =>
    Effect.gen(function* () {
      vi.stubEnv("T3CODE_SCAFFOLD_STAGING_URL", "https://staging.scaffold.test");
      vi.stubEnv("T3CODE_SCAFFOLD_STAGING_AUTH_MODE", "iap");
      vi.stubEnv("T3CODE_SCAFFOLD_STAGING_AUTHORIZATION", "Bearer staging-server-secret");

      const nativeFetch = globalThis.fetch.bind(globalThis);
      const scaffoldFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = requestUrl(input);
        return url.origin === "https://staging.scaffold.test"
          ? Promise.reject(new Error("Scaffold must not be contacted"))
          : nativeFetch(input, init);
      });

      yield* makeRouteLayer().pipe(Layer.build);
      const cookie = yield* authenticatedCookie;
      const fabricSessionId = SessionFabricSessionId.make("sf:env_1:thread_1");
      const invalidBodies = [
        {
          role: "controller",
          fabricSessionId,
          environmentKind: "local",
          environmentId: "env_1",
          threadId: "thread_1",
          scaffoldSessionId: "ses_1",
          scaffoldLifecycleEpoch: 7,
        },
        {
          role: "controller",
          fabricSessionId,
          environmentKind: "local",
          environmentId: "env_1",
          threadId: "thread_1",
          unexpected: true,
        },
      ];

      for (const body of invalidBodies) {
        const response = yield* HttpClient.post("/api/session-fabric/capabilities", {
          headers: { cookie },
          body: yield* HttpBody.json(body),
        });
        expect(response.status).toBe(400);
      }
      expect(
        scaffoldFetch.mock.calls.filter(
          ([input]) => requestUrl(input).origin === "https://staging.scaffold.test",
        ),
      ).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves controller scope denials and invalidates the cached OAuth credential", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-scaffold-oauth-",
      });
      const tokenFile = path.join(tempDirectory, "token.json");
      yield* fileSystem.writeFileString(
        tokenFile,
        encodeJsonRecord({
          accessToken: "cached-token",
          tokenType: "Bearer",
          resource: "https://staging.scaffold.test/",
          scope:
            "remote_code:create remote_code:read remote_code:write remote_code:exec remote_code:lifecycle",
        }),
        { mode: 0o600 },
      );
      vi.stubEnv("T3CODE_SCAFFOLD_STAGING_URL", "https://staging.scaffold.test");
      vi.stubEnv("T3CODE_SCAFFOLD_STAGING_AUTH_MODE", "oauth");
      vi.stubEnv("T3CODE_SCAFFOLD_STAGING_OAUTH_TOKEN_FILE", tokenFile);

      const nativeFetch = globalThis.fetch.bind(globalThis);
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = requestUrl(input);
        if (url.origin !== "https://staging.scaffold.test") return nativeFetch(input, init);
        const body = decodeJsonRecord(String(init?.body));
        if (body.role === "controller") {
          return Response.json({ error: "remote_code_token_forbidden" }, { status: 403 });
        }
        return Response.json({
          capability: "header.payload.signature",
          tokenType: "Bearer",
          role: "viewer",
          scopes: ["directory:read", "session:read"],
          expiresAt: "2099-07-24T20:01:00.000Z",
          issuer: "scaffold",
          audience: "session-fabric",
          keyId: "proof-1",
          bindings: {},
        });
      });

      yield* makeRouteLayer().pipe(Layer.build);
      const cookie = yield* authenticatedCookie;
      const viewerResponse = yield* HttpClient.post("/api/session-fabric/capabilities", {
        headers: { cookie },
        body: yield* HttpBody.json({ role: "viewer", deployment: "staging" }),
      });
      expect(viewerResponse.status).toBe(200);
      expect(yield* fileSystem.exists(tokenFile)).toBe(true);

      const controllerResponse = yield* HttpClient.post("/api/session-fabric/capabilities", {
        headers: { cookie },
        body: yield* HttpBody.json({
          role: "controller",
          deployment: "staging",
          fabricSessionId: "sf:scaffold-env:scaffold-thread",
          scaffoldSessionId: "ses_1",
          scaffoldLifecycleEpoch: 7,
        }),
      });
      expect(controllerResponse.status).toBe(403);
      expect(yield* controllerResponse.json).toEqual({ error: "remote_code_token_forbidden" });
      expect(yield* fileSystem.exists(tokenFile)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );
});
