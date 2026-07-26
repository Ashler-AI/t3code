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

/**
 * A durable session view intentionally has no server config of its own. Reuse
 * the provider/model already committed to the thread so the composer can send
 * commands back to the owning runner without inventing a second model choice.
 */
export function resolveSessionFabricComposerProviders(input: {
  readonly environmentId: EnvironmentId;
  readonly providers: ServerProvider[];
  readonly thread: SessionFabricComposerThread | undefined;
}): ServerProvider[] {
  if (
    input.providers.length > 0 ||
    composerFabricSessionId(input.environmentId) === null ||
    input.thread === undefined
  ) {
    return input.providers;
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
      models: [
        {
          slug: selection.model,
          name: modelDisplayName(selection.model),
          isCustom: false,
          isDefault: true,
          capabilities: null,
        },
      ],
      slashCommands: [],
      skills: [],
    },
  ];
}
