import type { OmpSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { writeFileStringAtomically } from "../atomicWrite.ts";

const MODEL_CONFIG_FILE = "models.yml";
const GATEWAY_PROVIDER_ID = "ashler";
const OPENAI_BROKER_PROVIDER_ID = "openai-codex";
const ANTHROPIC_BROKER_PROVIDER_ID = "anthropic";

const MANAGED_BROKER_DEFINITIONS = [
  {
    provider: OPENAI_BROKER_PROVIDER_ID,
    enabledEnv: "SCAFFOLD_OPENAI_BROKER_ENABLED",
    baseUrlEnv: "SCAFFOLD_OPENAI_BROKER_BASE_URL",
    apiKeyEnv: "SCAFFOLD_OMP_OPENAI_BROKER_GRANT",
  },
  {
    provider: ANTHROPIC_BROKER_PROVIDER_ID,
    enabledEnv: "SCAFFOLD_ANTHROPIC_BROKER_ENABLED",
    baseUrlEnv: "SCAFFOLD_ANTHROPIC_BROKER_BASE_URL",
    apiKeyEnv: "SCAFFOLD_OMP_ANTHROPIC_BROKER_GRANT",
  },
] as const;

type OmpAgentDirectorySettings = Pick<OmpSettings, "agentDir">;

export interface AshlerOmpOverlayResult {
  readonly environment: NodeJS.ProcessEnv;
  readonly overlayPath?: string;
  readonly status: "not-configured" | "ready";
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

function expandHome(value: string, environment: NodeJS.ProcessEnv): string {
  if (value === "~" || value.startsWith("~/")) {
    const home = environmentValue(environment, "HOME");
    return home ? `${home}${value.slice(1)}` : value;
  }
  return value;
}

export function resolveAshlerOmpAgentDir(
  settings: OmpAgentDirectorySettings,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const configured =
    settings.agentDir.trim() || environmentValue(environment, "ASHLER_OMP_AGENT_DIR");
  return configured ? expandHome(configured, environment) : undefined;
}

export function validateAshlerGatewayBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const isLoopback =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) return undefined;
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

function gatewayModel(input: {
  readonly id: string;
  readonly requestModelId: string;
  readonly name: string;
  readonly contextWindow: number;
}) {
  return {
    id: input.id,
    name: input.name,
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    supportsTools: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.contextWindow,
    maxTokens: 32_768,
    thinking: {
      mode: "effort",
      efforts: ["low", "medium", "high", "max"],
      defaultLevel: "high",
    },
    compat: { extraBody: { model: input.requestModelId } },
  } as const;
}

export function buildAshlerGatewayProviderOverlay(baseUrl: string) {
  return {
    baseUrl,
    apiKey: "LLM_GATEWAY_API_KEY",
    api: "openai-completions",
    authHeader: true,
    headers: {
      "x-bf-vk": "LLM_GATEWAY_API_KEY",
      "x-bf-dim-gateway_backend": "bifrost",
      "x-bf-dim-environment": "platform",
      "x-bf-dim-caller_service": "scaffold-sandbox",
      "x-bf-dim-workflow_type": "coding-agent",
      "x-bf-dim-surface": "scaffold",
      "x-bf-dim-generation_module": "omp",
      "x-bf-dim-generation_task_type": "software-engineering",
      "x-bf-dim-producer": "ashler-code",
      "x-bf-dim-schema_version": "v1",
      "x-bf-dim-ashler_session_id": "SCAFFOLD_SESSION_ID",
    },
    models: [
      gatewayModel({
        id: "moonshotai/Kimi-K2.6",
        requestModelId: "baseten/moonshotai/Kimi-K2.6",
        name: "Kimi K2.6",
        contextWindow: 262_144,
      }),
      gatewayModel({
        id: "x-ai/grok-4.5",
        requestModelId: "openrouter/x-ai/grok-4.5",
        name: "Grok 4.5",
        contextWindow: 256_000,
      }),
    ],
  } as const;
}

function brokerEnabled(environment: NodeJS.ProcessEnv, name: string): boolean {
  const value = environmentValue(environment, name);
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`${name} must be either 0 or 1`);
}

/**
 * Build provider overrides for Scaffold's session-scoped account brokers.
 * The opaque grants are deliberately referenced by child-environment name;
 * neither the grant files nor their bytes are serialized into models.yml.
 */
export function buildAshlerBrokerProviderOverlays(
  environment: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const definition of MANAGED_BROKER_DEFINITIONS) {
    if (!brokerEnabled(environment, definition.enabledEnv)) continue;
    const rawBaseUrl = environmentValue(environment, definition.baseUrlEnv);
    const grant = environmentValue(environment, definition.apiKeyEnv);
    const baseUrl = rawBaseUrl ? validateAshlerGatewayBaseUrl(rawBaseUrl) : undefined;
    if (!baseUrl || !grant) {
      throw new Error(`${definition.provider} Scaffold broker is enabled but incomplete`);
    }
    const common = {
      baseUrl:
        definition.provider === ANTHROPIC_BROKER_PROVIDER_ID
          ? baseUrl.replace(/\/v1$/u, "")
          : baseUrl,
      apiKey: definition.apiKeyEnv,
    };
    providers[definition.provider] =
      definition.provider === ANTHROPIC_BROKER_PROVIDER_ID
        ? {
            ...common,
            api: "anthropic-messages",
            auth: "oauth",
            models: [
              { id: "claude-sonnet-5", api: "anthropic-messages" },
              { id: "claude-fable-5", api: "anthropic-messages" },
            ],
          }
        : common;
  }
  return providers;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Materialize managed broker and Bifrost providers into an explicitly isolated OMP
 * agent directory. The file contains environment-variable references only;
 * the gateway credential stays in the child process environment.
 */
export const prepareAshlerOmpModelsOverlay = Effect.fn("prepareAshlerOmpModelsOverlay")(function* (
  settings: OmpAgentDirectorySettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<AshlerOmpOverlayResult, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const agentDir = resolveAshlerOmpAgentDir(settings, environment);
  const nextEnvironment = agentDir
    ? { ...environment, PI_CODING_AGENT_DIR: agentDir }
    : environment;
  const rawBaseUrl = environmentValue(environment, "LLM_GATEWAY_URL");
  const apiKeyPresent = environmentValue(environment, "LLM_GATEWAY_API_KEY") !== undefined;
  if (!agentDir || !path.isAbsolute(agentDir)) {
    return { environment: nextEnvironment, status: "not-configured" };
  }
  const brokerProviders = yield* Effect.sync(() =>
    buildAshlerBrokerProviderOverlays(environment),
  ).pipe(Effect.orDie);
  const baseUrl = rawBaseUrl ? validateAshlerGatewayBaseUrl(rawBaseUrl) : undefined;
  if (rawBaseUrl && apiKeyPresent && !baseUrl) {
    yield* Effect.logWarning("Ignoring invalid Ashler OMP gateway URL.");
  }
  const managedProviders = {
    ...brokerProviders,
    ...(baseUrl && apiKeyPresent
      ? { [GATEWAY_PROVIDER_ID]: buildAshlerGatewayProviderOverlay(baseUrl) }
      : {}),
  };
  if (Object.keys(managedProviders).length === 0) {
    return { environment: nextEnvironment, status: "not-configured" };
  }

  const overlayPath = path.join(agentDir, MODEL_CONFIG_FILE);
  const existing = yield* fileSystem.readFileString(overlayPath).pipe(
    Effect.map((contents) => asRecord(parseYaml(contents))),
    Effect.orElseSucceed((): Record<string, unknown> => ({})),
  );
  const providers = asRecord(existing.providers);
  const nextConfig = {
    ...existing,
    providers: {
      ...providers,
      ...managedProviders,
    },
  };
  const installed = yield* Effect.gen(function* () {
    yield* writeFileStringAtomically({
      filePath: overlayPath,
      contents: stringifyYaml(nextConfig, { lineWidth: 100 }) + "\n",
    });
    yield* fileSystem.chmod(overlayPath, 0o600);
    return true;
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning("Could not install the Ashler OMP model overlay.").pipe(Effect.as(false)),
    ),
  );
  if (!installed) {
    return { environment: nextEnvironment, status: "not-configured" };
  }
  return { environment: nextEnvironment, overlayPath, status: "ready" };
});
