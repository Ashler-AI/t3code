import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

const installedRequire = NodeModule.createRequire(import.meta.url);
const platformRequire = NodeModule.createRequire(
  installedRequire.resolve("@effect/platform-node/package.json"),
);
const installedEffectPath = NodeFS.realpathSync(installedRequire.resolve("effect/Effect"));
const platformEffectPath = NodeFS.realpathSync(platformRequire.resolve("effect/Effect"));
if (installedEffectPath !== platformEffectPath) {
  throw new Error(`Packed Effect runtime split: ${installedEffectPath} !== ${platformEffectPath}`);
}

const program = Effect.scoped(
  Effect.gen(function* () {
    const serverLayer = McpServer.layerHttp({
      name: "Packed artifact MCP verification",
      version: "1.0.0",
      path: "/mcp",
    });
    yield* HttpRouter.serve(serverLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(Layer.build);
    const httpClient = yield* HttpClient.HttpClient;

    const initializeResponse = yield* httpClient.post("/mcp", {
      headers: { accept: "application/json, text/event-stream" },
      body: HttpBody.text(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "packed-artifact-test", version: "1.0.0" },
          },
        }),
        "application/json",
      ),
    });
    const sessionId = initializeResponse.headers["mcp-session-id"];
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      throw new Error(`Missing MCP session header: ${String(sessionId)}`);
    }

    const toolsResponse = yield* httpClient.post("/mcp", {
      headers: {
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: HttpBody.text(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        "application/json",
      ),
    });
    if (toolsResponse.status !== 200) {
      throw new Error(`MCP tools/list failed with status ${toolsResponse.status}`);
    }
    const toolsBody = yield* toolsResponse.text;
    if (toolsBody.includes('"error"')) {
      throw new Error(`MCP tools/list returned an error: ${toolsBody}`);
    }
  }),
).pipe(Effect.provide(NodeHttpServer.layerTest));

NodeRuntime.runMain(program);
