import {
  type OmpSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { filterAshlerOmpModels } from "../../ashler/OmpModelPolicy.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildOmpSkillsFromAvailableCommands,
  makeOmpAcpRuntime,
  OMP_MODEL_CONFIG_ID,
  OMP_THINKING_CONFIG_ID,
} from "../acp/OmpAcpSupport.ts";

const OMP_PRESENTATION = {
  displayName: "OMP",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

// OMP startup can briefly contend with an active harness process or a busy
// development machine. Keep the availability probe bounded, but do not hide
// the entire model catalog because a cold `omp --version` crossed four seconds.
const VERSION_PROBE_TIMEOUT_MS = 15_000;
const OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

export function buildInitialOmpProviderSnapshot(
  ompSettings: OmpSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models: ReadonlyArray<ServerProviderModel> = [];

    if (!ompSettings.enabled) {
      return buildServerProvider({
        presentation: OMP_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "OMP is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking OMP CLI availability...",
      },
    });
  });
}

export function buildOmpDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = configOptions?.find(
    (option) => option.id === OMP_MODEL_CONFIG_ID && option.type === "select",
  );
  if (!modelOption || modelOption.type !== "select") {
    return [];
  }
  const thinkingOption = configOptions?.find(
    (option) => option.id === OMP_THINKING_CONFIG_ID && option.type === "select",
  );
  const thinkingDescriptor =
    thinkingOption?.type === "select"
      ? {
          id: "reasoningEffort",
          label: "Thinking",
          type: "select" as const,
          currentValue: thinkingOption.currentValue,
          options: thinkingOption.options.flatMap((entry) =>
            "value" in entry
              ? [
                  {
                    id: entry.value,
                    label: entry.name,
                    ...(entry.description ? { description: entry.description } : {}),
                    ...(entry.value === thinkingOption.currentValue ? { isDefault: true } : {}),
                  },
                ]
              : entry.options.map((option) => ({
                  id: option.value,
                  label: option.name,
                  ...(option.description ? { description: option.description } : {}),
                  ...(option.value === thinkingOption.currentValue ? { isDefault: true } : {}),
                })),
          ),
        }
      : undefined;
  const capabilities = thinkingDescriptor
    ? createModelCapabilities({ optionDescriptors: [thinkingDescriptor] })
    : EMPTY_CAPABILITIES;
  const currentModel = modelOption.currentValue.trim();
  const seen = new Set<string>();
  const discoveredModels = modelOption.options
    .flatMap((entry) => ("value" in entry ? [entry] : entry.options))
    .map((model): ServerProviderModel | undefined => {
      const slug = model.value.trim();
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        ...(slug === currentModel ? { isDefault: true } : {}),
        capabilities,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
  return filterAshlerOmpModels(discoveredModels);
}

const discoverOmpCatalogViaAcp = (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeOmpAcpRuntime({
      ompSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    const availableCommands = yield* acp.awaitAvailableCommands.pipe(
      Effect.timeoutOption(500),
      Effect.map(Option.getOrElse(() => [])),
    );
    return {
      models: buildOmpDiscoveredModelsFromConfigOptions(started.sessionSetupResult.configOptions),
      skills: buildOmpSkillsFromAvailableCommands(availableCommands),
    };
  }).pipe(Effect.scoped);

const runOmpVersionCommand = (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = ompSettings.binaryPath || "omp";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  // A configured policy entry is not proof that the runtime can serve a model.
  // Stay empty until OMP reports its live ACP catalog.
  const fallbackModels: ReadonlyArray<ServerProviderModel> = [];

  if (!ompSettings.enabled) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OMP is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runOmpVersionCommand(ompSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("OMP CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "OMP CLI (`omp`) is not installed or not on PATH."
          : "Failed to execute OMP CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "OMP CLI is installed but timed out while running `omp --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("OMP CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "OMP CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverOmpCatalogViaAcp(ompSettings, environment).pipe(
    Effect.timeoutOption(OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("OMP ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "OMP CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `OMP ACP model discovery timed out after ${OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `OMP CLI is installed but ACP startup timed out after ${OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discoveredModels = discoveryExit.value.value.models;
  const models = discoveredModels.length > 0 ? discoveredModels : fallbackModels;
  const skills = discoveryExit.value.value.skills;

  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: ompSettings.enabled,
    checkedAt,
    models,
    skills,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichOmpSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("OMP version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
