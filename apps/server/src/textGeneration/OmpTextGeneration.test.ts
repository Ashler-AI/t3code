// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { OmpSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeOmpTextGeneration } from "./OmpTextGeneration.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const OmpTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-omp-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpOmpWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const ompPath = NodePath.join(binDir, "omp");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    ompPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(ompPath, 0o755);
  return ompPath;
}

function withFakeAcpOmp<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-omp-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpOmpWrapper(tempDir, env);
    const config = decodeOmpSettings({ binaryPath });
    const textGeneration = yield* makeOmpTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function readJsonRpcRequests(
  filePath: string,
): ReadonlyArray<{ readonly method?: string; readonly params?: Record<string, unknown> }> {
  return NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

it.layer(OmpTextGenerationTestLayer)("OmpTextGeneration", (it) => {
  it.effect("forwards the requested OMP model and thinking level through ACP", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-omp-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpOmp(
      {
        T3_ACP_OMP_CONFIG_OPTIONS: "1",
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add OMP provider",
          body: "Route text generation through the same ACP harness.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/omp",
            stagedSummary: "M apps/server/src/provider/Drivers/OmpDriver.ts",
            stagedPatch: "diff --git a/OmpDriver.ts b/OmpDriver.ts",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("omp"),
              "anthropic/claude-sonnet-5",
              [{ id: "reasoningEffort", value: "high" }],
            ),
          });

          expect(generated).toEqual({
            subject: "Add OMP provider",
            body: "Route text generation through the same ACP harness.",
          });

          const requests = readJsonRpcRequests(requestLogPath);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "model" &&
                request.params?.value === "anthropic/claude-sonnet-5",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "thinking" &&
                request.params?.value === "high",
            ),
          ).toBe(true);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => NodeFS.rmSync(requestLogDir, { recursive: true, force: true })),
          ),
        ),
    );
  });

  it.effect("extracts structured output from conversational OMP output", () =>
    withFakeAcpOmp(
      {
        T3_ACP_OMP_CONFIG_OPTIONS: "1",
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Here is the title:\n" + JSON.stringify({ title: "Investigate OMP session state" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "why did the sandbox session disconnect?",
            modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "openai/gpt-5.6"),
          });
          expect(generated.title).toBe("Investigate OMP session state");
        }),
    ),
  );

  it.effect("surfaces OMP config failures as text generation errors", () =>
    withFakeAcpOmp(
      {
        T3_ACP_OMP_CONFIG_OPTIONS: "1",
        T3_ACP_FAIL_SET_CONFIG_OPTION: "1",
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "unreachable" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateBranchName({
              cwd: process.cwd(),
              message: "wire up OMP",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("omp"),
                "openai/gpt-5.6",
              ),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toContain("OMP ACP model");
        }),
    ),
  );
});
