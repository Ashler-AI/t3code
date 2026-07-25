// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OmpSettings } from "@t3tools/contracts";

import {
  buildInitialOmpProviderSnapshot,
  buildOmpDiscoveredModelsFromConfigOptions,
  checkOmpProviderStatus,
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
    expect(models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "reasoningEffort",
      currentValue: "high",
    });
  });

  it.effect("publishes standard ACP commands as pathless OMP skills", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeMockOmpProviderWrapper());
      const snapshot = yield* checkOmpProviderStatus(decodeOmpSettings({ binaryPath }));

      expect(snapshot.status).toBe("ready");
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
});
