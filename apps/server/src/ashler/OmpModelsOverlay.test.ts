import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYaml } from "yaml";

import {
  buildAshlerBrokerProviderOverlays,
  buildAshlerGatewayProviderOverlay,
  prepareAshlerOmpModelsOverlay,
  validateAshlerGatewayBaseUrl,
} from "./OmpModelsOverlay.ts";

describe("Ashler OMP models overlay", () => {
  it("accepts secure and loopback gateway URLs only", () => {
    expect(validateAshlerGatewayBaseUrl("https://gateway.example/v1/")).toBe(
      "https://gateway.example/v1",
    );
    expect(validateAshlerGatewayBaseUrl("http://127.0.0.1:8080/v1")).toBe(
      "http://127.0.0.1:8080/v1",
    );
    expect(validateAshlerGatewayBaseUrl("http://gateway.example/v1")).toBeUndefined();
  });

  it("uses canonical live Bifrost model casing and environment references", () => {
    const provider = buildAshlerGatewayProviderOverlay("https://gateway.example/v1");
    expect(provider.apiKey).toBe("LLM_GATEWAY_API_KEY");
    expect(provider.headers["x-bf-vk"]).toBe("LLM_GATEWAY_API_KEY");
    expect(provider.models.map((model) => model.id)).toEqual([
      "moonshotai/Kimi-K2.6",
      "x-ai/grok-4.5",
    ]);
    expect(provider.models.map((model) => model.compat.extraBody.model)).toEqual([
      "baseten/moonshotai/Kimi-K2.6",
      "openrouter/x-ai/grok-4.5",
    ]);
    expect(JSON.stringify(provider)).not.toContain("secret-value");
  });

  it("references enabled Scaffold broker grants without serializing their bytes", () => {
    const providers = buildAshlerBrokerProviderOverlays({
      SCAFFOLD_OPENAI_BROKER_ENABLED: "1",
      SCAFFOLD_OPENAI_BROKER_BASE_URL: "https://scaffold.test/api/llm-proxy/openai/v1/",
      SCAFFOLD_OMP_OPENAI_BROKER_GRANT: "openai-grant-canary",
      SCAFFOLD_ANTHROPIC_BROKER_ENABLED: "1",
      SCAFFOLD_ANTHROPIC_BROKER_BASE_URL: "https://scaffold.test/api/llm-proxy/anthropic/v1/",
      SCAFFOLD_OMP_ANTHROPIC_BROKER_GRANT: "anthropic-grant-canary",
    });

    expect(providers).toEqual({
      openai: {
        baseUrl: "https://scaffold.test/api/llm-proxy/openai/v1",
        apiKey: "SCAFFOLD_OMP_OPENAI_BROKER_GRANT",
      },
      anthropic: {
        baseUrl: "https://scaffold.test/api/llm-proxy/anthropic",
        apiKey: "SCAFFOLD_OMP_ANTHROPIC_BROKER_GRANT",
        api: "anthropic-messages",
        auth: "oauth",
        models: [
          { id: "claude-sonnet-5", api: "anthropic-messages" },
          { id: "claude-fable-5", api: "anthropic-messages" },
        ],
      },
    });
    expect(JSON.stringify(providers)).not.toMatch(/(?:openai|anthropic)-grant-canary/u);
  });

  it("fails closed when an enabled Scaffold broker is malformed", () => {
    expect(() =>
      buildAshlerBrokerProviderOverlays({
        SCAFFOLD_OPENAI_BROKER_ENABLED: "1",
        SCAFFOLD_OPENAI_BROKER_BASE_URL: "http://scaffold.test/api/llm-proxy/openai/v1",
        SCAFFOLD_OMP_OPENAI_BROKER_GRANT: "openai-grant-canary",
      }),
    ).toThrow(/enabled but incomplete/u);
    expect(() =>
      buildAshlerBrokerProviderOverlays({ SCAFFOLD_OPENAI_BROKER_ENABLED: "yes" }),
    ).toThrow(/must be either 0 or 1/u);
  });

  it("leaves local OAuth providers untouched when Scaffold brokers are absent", () => {
    expect(buildAshlerBrokerProviderOverlays({})).toEqual({});
  });

  it.effect("merges the managed provider without persisting its credential", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fileSystem.makeTempDirectoryScoped();
      const modelsPath = path.join(agentDir, "models.yml");
      yield* fileSystem.writeFileString(
        modelsPath,
        "providers:\n  local:\n    baseUrl: http://127.0.0.1:11434/v1\n    auth: none\n",
      );

      const result = yield* prepareAshlerOmpModelsOverlay(
        { agentDir },
        {
          HOME: "/tmp/home",
          LLM_GATEWAY_URL: "https://gateway.example/v1/",
          LLM_GATEWAY_API_KEY: "secret-value",
          SCAFFOLD_SESSION_ID: "ses_test",
        },
      );
      const written = yield* fileSystem.readFileString(modelsPath);
      const parsed = parseYaml(written) as { providers: Record<string, unknown> };

      expect(result.status).toBe("ready");
      expect(result.environment.PI_CODING_AGENT_DIR).toBe(agentDir);
      expect(parsed.providers.local).toBeDefined();
      expect(parsed.providers.ashler).toBeDefined();
      expect(written).not.toContain("secret-value");
      expect(written).toContain("LLM_GATEWAY_API_KEY");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes broker and Bifrost references only into the isolated agent directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fileSystem.makeTempDirectoryScoped();
      const result = yield* prepareAshlerOmpModelsOverlay(
        { agentDir },
        {
          LLM_GATEWAY_URL: "https://gateway.example/v1",
          LLM_GATEWAY_API_KEY: "bifrost-key-canary",
          SCAFFOLD_SESSION_ID: "ses_test",
          SCAFFOLD_OPENAI_BROKER_ENABLED: "1",
          SCAFFOLD_OPENAI_BROKER_BASE_URL: "https://scaffold.test/api/llm-proxy/openai/v1",
          SCAFFOLD_OMP_OPENAI_BROKER_GRANT: "openai-grant-canary",
          SCAFFOLD_ANTHROPIC_BROKER_ENABLED: "1",
          SCAFFOLD_ANTHROPIC_BROKER_BASE_URL: "https://scaffold.test/api/llm-proxy/anthropic",
          SCAFFOLD_OMP_ANTHROPIC_BROKER_GRANT: "anthropic-grant-canary",
        },
      );
      const written = yield* fileSystem.readFileString(path.join(agentDir, "models.yml"));

      expect(result.status).toBe("ready");
      expect(result.environment.PI_CODING_AGENT_DIR).toBe(agentDir);
      expect(written).toContain("SCAFFOLD_OMP_OPENAI_BROKER_GRANT");
      expect(written).toContain("SCAFFOLD_OMP_ANTHROPIC_BROKER_GRANT");
      expect(written).toContain("LLM_GATEWAY_API_KEY");
      expect(written).not.toMatch(/(?:bifrost-key|openai-grant|anthropic-grant)-canary/u);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not write into an implicit user OMP directory", () =>
    Effect.gen(function* () {
      const result = yield* prepareAshlerOmpModelsOverlay(
        { agentDir: "" },
        {
          HOME: "/tmp/home",
          LLM_GATEWAY_URL: "https://gateway.example/v1",
          LLM_GATEWAY_API_KEY: "secret-value",
        },
      );
      expect(result.status).toBe("not-configured");
      expect(result.overlayPath).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
