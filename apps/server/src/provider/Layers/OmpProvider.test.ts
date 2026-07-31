// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { OmpSettings } from "@t3tools/contracts";

import {
  buildInitialOmpProviderSnapshot,
  buildOmpDiscoveredModelsFromConfigOptions,
  checkOmpProviderStatus,
  OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS,
} from "./OmpProvider.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockOmpProviderWrapper(options?: { readonly versionDelaySeconds?: number }) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-provider-mock-"));
  const wrapperPath = NodePath.join(dir, "omp");
  const versionDelaySeconds = options?.versionDelaySeconds ?? 0;
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  sleep ${versionDelaySeconds}
  echo "omp/17.1.2"
  exit 0
fi
export T3_ACP_EMIT_AVAILABLE_COMMANDS=1
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

describe("OmpProvider", () => {
  it.effect("defaults to an enabled pending snapshot without inventing models", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOmpProviderSnapshot(
        decodeOmpSettings({ customModels: ["openai/gpt-5.6-terra"] }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.models).toEqual([]);
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
      expect(snapshot.message).toContain("Checking OMP");
    }),
  );

  it("discovers provider/model ids and thinking levels from OMP config options", () => {
    const models = buildOmpDiscoveredModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "openai/gpt-5.6-terra",
        options: [
          { value: "openai/gpt-5.6-terra", name: "GPT-5.6 Terra" },
          { value: "anthropic/claude-sonnet-5", name: "Sonnet 5" },
          { value: "openai/gpt-5.5", name: "GPT-5.5" },
        ],
      },
      {
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "off", name: "Off" },
          { value: "high", name: "High" },
        ],
      },
    ]);

    expect(models.map((model) => model.slug)).toEqual([
      "openai/gpt-5.6-terra",
      "anthropic/claude-sonnet-5",
    ]);
    expect(models.map((model) => ({ slug: model.slug, isDefault: model.isDefault }))).toEqual([
      { slug: "openai/gpt-5.6-terra", isDefault: true },
      { slug: "anthropic/claude-sonnet-5", isDefault: undefined },
    ]);
    expect(models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "reasoningEffort",
      currentValue: "high",
    });
  });

  it("preserves Scaffold's live OMP model selection as the catalog default", () => {
    const models = buildOmpDiscoveredModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "openai/gpt-5.6-sol",
        options: [
          { value: "ashler/moonshotai/Kimi-K2.6", name: "Kimi K2.6" },
          { value: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol" },
        ],
      },
    ]);

    expect(models.map((model) => ({ slug: model.slug, isDefault: model.isDefault }))).toEqual([
      { slug: "ashler/moonshotai/Kimi-K2.6", isDefault: undefined },
      { slug: "openai/gpt-5.6-sol", isDefault: true },
    ]);
  });

  it("advertises every allowed Scaffold model with the bootstrap model as default", () => {
    const models = buildOmpDiscoveredModelsFromConfigOptions(
      [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "anthropic/claude-fable-5",
          options: [
            { value: "anthropic/claude-fable-5", name: "Claude Fable 5" },
            { value: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol" },
            { value: "openai/gpt-5.6-terra", name: "GPT-5.6 Terra" },
            { value: "x-ai/grok-4.5", name: "Grok 4.5" },
          ],
        },
        {
          id: "thinking",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            { value: "off", name: "Off" },
            { value: "high", name: "High" },
          ],
        },
      ],
      {
        SCAFFOLD_RUNTIME_PROFILE: "agent_t3_omp",
        OMP_AGENT_MODEL: "anthropic/claude-fable-5",
        OMP_AGENT_ALLOWED_MODELS:
          "anthropic/claude-fable-5,openai/gpt-5.6-sol,openai/gpt-5.6-terra",
      },
    );

    expect(models.map((model) => ({ slug: model.slug, isDefault: model.isDefault }))).toEqual([
      { slug: "anthropic/claude-fable-5", isDefault: true },
      { slug: "openai/gpt-5.6-sol", isDefault: undefined },
      { slug: "openai/gpt-5.6-terra", isDefault: undefined },
    ]);
    expect(
      models.every((model) => model.capabilities?.optionDescriptors?.[0]?.currentValue === "high"),
    ).toBe(true);
  });

  it("does not advertise models outside the managed Scaffold allowlist", () => {
    const models = buildOmpDiscoveredModelsFromConfigOptions(
      [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "openai/gpt-5.6-sol",
          options: [
            { value: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol" },
            { value: "anthropic/claude-sonnet-5", name: "Sonnet 5" },
          ],
        },
      ],
      {
        SCAFFOLD_RUNTIME_PROFILE: "agent_t3_omp",
        OMP_AGENT_MODEL: "openai/gpt-5.6-sol",
        OMP_AGENT_ALLOWED_MODELS: "openai/gpt-5.6-sol",
      },
    );

    expect(models.map((model) => model.slug)).toEqual(["openai/gpt-5.6-sol"]);
  });

  it("keeps an exact managed Scaffold grant that is newer than the local model policy", () => {
    const configOptions = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select" as const,
        currentValue: "openai/gpt-5.7-sol",
        options: [{ value: "openai/gpt-5.7-sol", name: "GPT-5.7 Sol" }],
      },
    ];

    const managedModels = buildOmpDiscoveredModelsFromConfigOptions(configOptions, {
      SCAFFOLD_RUNTIME_PROFILE: "agent_t3_omp",
      OMP_AGENT_MODEL: "openai/gpt-5.7-sol",
      OMP_AGENT_ALLOWED_MODELS: "openai/gpt-5.7-sol",
    });
    const localModels = buildOmpDiscoveredModelsFromConfigOptions(configOptions);

    expect(
      managedModels.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    ).toEqual([{ slug: "openai/gpt-5.7-sol", isDefault: true }]);
    expect(localModels).toEqual([]);
  });

  it.effect("publishes standard ACP commands as pathless OMP skills", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeMockOmpProviderWrapper());
      const snapshot = yield* checkOmpProviderStatus(decodeOmpSettings({ binaryPath }));

      expect(snapshot.status).toBe("ready");
      expect(snapshot.slashCommands).toEqual([
        {
          name: "handoff",
          description: "Hand work to another environment.",
        },
        {
          name: "skill:review",
          description: "Review the current changes.",
        },
      ]);
      expect(snapshot.skills).toEqual([
        {
          name: "handoff",
          description: "Hand work to another environment.",
          shortDescription: "Hand work to another environment.",
          scope: "omp",
          enabled: true,
        },
        {
          name: "skill:review",
          displayName: "Review",
          description: "Review the current changes.",
          shortDescription: "Review the current changes.",
          scope: "omp",
          enabled: true,
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a slow successful OMP version probe available", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockOmpProviderWrapper({ versionDelaySeconds: 5 }),
      );
      const snapshot = yield* checkOmpProviderStatus(decodeOmpSettings({ binaryPath }), {
        ...process.env,
        T3_ACP_OMP_ADVISOR_POLICY_OPTIONS: "1",
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("17.1.2");
      expect(snapshot.models.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("bounds hanging ACP discovery and closes its child scope", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeMockOmpProviderWrapper());
      const discoveryStarted = yield* Deferred.make<void>();
      const childCleanupCalls = yield* Ref.make(0);
      const hangingDiscovery = () =>
        Effect.acquireRelease(Deferred.succeed(discoveryStarted, undefined), () =>
          Ref.update(childCleanupCalls, (count) => count + 1),
        ).pipe(Effect.flatMap(() => Effect.never));

      const probeFiber = yield* checkOmpProviderStatus(
        decodeOmpSettings({ binaryPath }),
        process.env,
        hangingDiscovery,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(discoveryStarted);
      yield* TestClock.adjust(`${OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS + 1} millis`);
      const snapshot = yield* Fiber.join(probeFiber);

      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe(
        `OMP CLI is installed but ACP startup timed out after ${OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      );
      expect(yield* Ref.get(childCleanupCalls)).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
