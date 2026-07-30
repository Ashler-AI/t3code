import {
  EnvironmentId,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { deriveEffectiveComposerModelState } from "../../composerDraftStore";
import { getComposerProviderState } from "./composerProviderState";
import { resolveSessionFabricComposerProviders } from "./sessionFabricComposerProvider";

const now = "2026-07-24T12:00:00.000Z";

describe("resolveSessionFabricComposerProviders", () => {
  it("restores the committed OMP model for a durable session view", () => {
    const providers = resolveSessionFabricComposerProviders({
      environmentId: EnvironmentId.make("session-fabric:global-session-1"),
      providers: [],
      thread: {
        modelSelection: ModelSelection.make({
          instanceId: ProviderInstanceId.make("omp"),
          model: "openai-codex/gpt-5.6-luna",
          options: [{ id: "reasoningEffort", value: "high" }],
        }),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "omp",
          providerInstanceId: ProviderInstanceId.make("omp"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        updatedAt: now,
      },
    });

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      instanceId: ProviderInstanceId.make("omp"),
      driver: ProviderDriverKind.make("omp"),
      displayName: "OMP",
      status: "ready",
      models: [
        {
          slug: "openai-codex/gpt-5.6-luna",
          name: "gpt-5.6-luna",
        },
      ],
    });
  });

  it("never shadows a live server provider catalog", () => {
    const liveProvider = {
      instanceId: ProviderInstanceId.make("omp"),
      driver: ProviderDriverKind.make("omp"),
      enabled: true,
      installed: true,
      version: "17.1.2",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: now,
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;

    expect(
      resolveSessionFabricComposerProviders({
        environmentId: EnvironmentId.make("session-fabric:global-session-1"),
        providers: [liveProvider],
        thread: undefined,
      }),
    ).toEqual([liveProvider]);
  });

  it("keeps a locked Scaffold grant model visible when the local OMP catalog lacks its route", () => {
    const liveProvider = {
      instanceId: ProviderInstanceId.make("omp"),
      driver: ProviderDriverKind.make("omp"),
      enabled: true,
      installed: true,
      version: "17.1.2",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: now,
      models: [
        {
          slug: "anthropic/claude-fable-5",
          name: "Claude Fable 5",
          isCustom: false,
          isDefault: true,
          capabilities: null,
        },
      ],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;
    const lockedModelSelection = ModelSelection.make({
      instanceId: ProviderInstanceId.make("omp"),
      model: "openai/gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });

    const liveProviders = [liveProvider];
    const providers = resolveSessionFabricComposerProviders({
      environmentId: EnvironmentId.make("local"),
      providers: liveProviders,
      thread: undefined,
      lockedModelSelection,
    });

    expect(providers).not.toBe(liveProviders);
    expect(providers[0]?.models).toEqual([
      liveProvider.models[0],
      {
        slug: "openai/gpt-5.6-sol",
        name: "gpt-5.6-sol",
        isCustom: false,
        isDefault: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "reasoningEffort",
              type: "select",
              currentValue: "high",
              options: [{ id: "high", label: "high", isDefault: true }],
            },
          ],
        },
      },
    ]);

    const modelState = deriveEffectiveComposerModelState({
      draft: {
        activeProvider: lockedModelSelection.instanceId,
        modelSelectionByProvider: {
          [lockedModelSelection.instanceId]: lockedModelSelection,
        },
      },
      providers,
      selectedProvider: ProviderDriverKind.make("omp"),
      selectedInstanceId: lockedModelSelection.instanceId,
      threadModelSelection: null,
      projectModelSelection: ModelSelection.make({
        instanceId: ProviderInstanceId.make("omp"),
        model: "anthropic/claude-fable-5",
      }),
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(modelState.selectedModel).toBe("openai/gpt-5.6-sol");
    expect(
      getComposerProviderState({
        provider: ProviderDriverKind.make("omp"),
        model: modelState.selectedModel,
        models: providers[0]?.models ?? [],
        modelOptions: modelState.modelOptions?.[lockedModelSelection.instanceId],
      }),
    ).toMatchObject({
      promptEffort: "high",
      modelOptionsForDispatch: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("does not invent providers for ordinary local environments", () => {
    expect(
      resolveSessionFabricComposerProviders({
        environmentId: EnvironmentId.make("local"),
        providers: [],
        thread: undefined,
      }),
    ).toEqual([]);
  });
});
