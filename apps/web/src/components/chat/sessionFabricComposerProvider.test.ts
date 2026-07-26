import {
  EnvironmentId,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

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
