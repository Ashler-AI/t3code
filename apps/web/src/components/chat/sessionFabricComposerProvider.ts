import {
  ProviderDriverKind,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationSession,
  type ServerProvider,
} from "@t3tools/contracts";

import { composerFabricSessionId } from "./composerAtMentions";

interface SessionFabricComposerThread {
  readonly modelSelection: ModelSelection;
  readonly session: OrchestrationSession | null;
  readonly updatedAt: string;
}

function modelDisplayName(model: string): string {
  return model.split("/").at(-1) ?? model;
}

function lockedModel(selection: ModelSelection): ServerProvider["models"][number] {
  const optionDescriptors = selection.options?.map((option) =>
    typeof option.value === "boolean"
      ? {
          id: option.id,
          label: option.id,
          type: "boolean" as const,
          currentValue: option.value,
        }
      : {
          id: option.id,
          label: option.id,
          type: "select" as const,
          currentValue: option.value,
          options: [{ id: option.value, label: option.value, isDefault: true }],
        },
  );
  return {
    slug: selection.model,
    name: modelDisplayName(selection.model),
    isCustom: false,
    isDefault: false,
    capabilities: optionDescriptors?.length ? { optionDescriptors } : null,
  };
}

function preserveLockedModel(
  providers: ServerProvider[],
  selection: ModelSelection | null | undefined,
): ServerProvider[] {
  if (!selection) return providers;

  const providerIndex = providers.findIndex(
    (provider) => provider.instanceId === selection.instanceId,
  );
  const provider = providers[providerIndex];
  if (!provider || provider.models.some((model) => model.slug === selection.model)) {
    return providers;
  }

  const nextProviders = [...providers];
  nextProviders[providerIndex] = {
    ...provider,
    models: [...provider.models, lockedModel(selection)],
  };
  return nextProviders;
}

/**
 * A durable session view intentionally has no server config of its own. Reuse
 * the provider/model already committed to the thread so the composer can send
 * commands back to the owning runner without inventing a second model choice.
 */
export function resolveSessionFabricComposerProviders(input: {
  readonly environmentId: EnvironmentId;
  readonly providers: ServerProvider[];
  readonly thread: SessionFabricComposerThread | undefined;
  readonly lockedModelSelection?: ModelSelection | null;
}): ServerProvider[] {
  const providers = preserveLockedModel(input.providers, input.lockedModelSelection);
  if (
    providers.length > 0 ||
    composerFabricSessionId(input.environmentId) === null ||
    input.thread === undefined
  ) {
    return providers;
  }

  const selection = input.thread.modelSelection;
  const providerName = input.thread.session?.providerName ?? "omp";
  const displayName = providerName.toLowerCase() === "omp" ? "OMP" : providerName;

  return [
    {
      instanceId: selection.instanceId,
      driver: ProviderDriverKind.make(providerName),
      displayName,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: input.thread.session?.updatedAt ?? input.thread.updatedAt,
      models: [{ ...lockedModel(selection), isDefault: true }],
      slashCommands: [],
      skills: [],
    },
  ];
}
