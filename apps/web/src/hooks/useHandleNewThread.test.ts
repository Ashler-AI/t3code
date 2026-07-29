import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "../composerDraftStore";
import {
  createLatestDraftNavigationCoordinator,
  createLatestSingleFlightCoordinator,
  resolveScaffoldDraftModelSelection,
} from "./useHandleNewThread";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("createLatestDraftNavigationCoordinator", () => {
  it("keeps production visible when an older staging navigation settles last", async () => {
    const stagingDraftId = DraftId.make("draft-staging");
    const productionDraftId = DraftId.make("draft-production");
    const stagingNavigation = deferred();
    const productionNavigation = deferred();
    const calls: Array<{ readonly draftId: DraftId; readonly replace: boolean }> = [];
    let visibleDraftId: DraftId | null = null;

    const navigate = createLatestDraftNavigationCoordinator(async ({ draftId, replace }) => {
      calls.push({ draftId, replace });
      if (
        draftId === stagingDraftId &&
        calls.filter((call) => call.draftId === draftId).length === 1
      ) {
        await stagingNavigation.promise;
      }
      if (
        draftId === productionDraftId &&
        calls.filter((call) => call.draftId === draftId).length === 1
      ) {
        await productionNavigation.promise;
      }
      visibleDraftId = draftId;
    });

    const staging = navigate({ draftId: stagingDraftId, replace: false });
    const production = navigate({ draftId: productionDraftId, replace: false });

    productionNavigation.resolve();
    await production;
    expect(visibleDraftId).toBe(productionDraftId);

    stagingNavigation.resolve();
    await staging;

    expect(visibleDraftId).toBe(productionDraftId);
    expect(calls).toEqual([
      { draftId: stagingDraftId, replace: false },
      { draftId: productionDraftId, replace: false },
      { draftId: productionDraftId, replace: true },
    ]);
  });
});

describe("createLatestSingleFlightCoordinator", () => {
  it("coalesces pre-lock staging then production into one production action", async () => {
    const beforeLock = deferred();
    const visibleTargets: string[] = [];
    const actions: string[] = [];

    const launch = createLatestSingleFlightCoordinator<string>(async (_initial, context) => {
      context.observeLatest((target) => visibleTargets.push(target));
      await beforeLock.promise;
      actions.push(context.lockLatest());
    });

    const staging = launch("staging");
    await Promise.resolve();
    const production = launch("production");

    expect(production).toBe(staging);
    expect(visibleTargets).toEqual(["staging", "production"]);
    beforeLock.resolve();
    await staging;

    expect(actions).toEqual(["production"]);
  });

  it("queues the first post-lock selection as a second flight and coalesces later selections", async () => {
    const firstSettled = deferred();
    const firstLocked = deferred();
    const actions: string[] = [];
    let draftCount = 0;

    const launch = createLatestSingleFlightCoordinator<string>(async (_initial, context) => {
      draftCount += 1;
      const target = context.lockLatest();
      actions.push(target);
      if (draftCount === 1) {
        firstLocked.resolve();
        await firstSettled.promise;
      }
    });

    const first = launch("staging");
    await firstLocked.promise;
    const second = launch("production");
    const coalescedSecond = launch("staging");

    expect(second).not.toBe(first);
    expect(coalescedSecond).toBe(second);
    expect(draftCount).toBe(1);
    expect(actions).toEqual(["staging"]);

    firstSettled.resolve();
    await Promise.all([first, second]);

    expect(draftCount).toBe(2);
    expect(actions).toEqual(["staging", "staging"]);
  });
});

function provider(input: {
  readonly driver: "omp" | "codex" | "claudeAgent";
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isDefault?: boolean;
    readonly capabilities?: ServerProvider["models"][number]["capabilities"];
  }>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.driver),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-27T00:00:00.000Z",
    models: input.models.map((model) => ({
      slug: model.slug,
      name: model.slug,
      isCustom: false,
      ...(model.isDefault ? { isDefault: true } : {}),
      capabilities: model.capabilities ?? {},
    })),
    slashCommands: [],
    skills: [],
  };
}

describe("resolveScaffoldDraftModelSelection", () => {
  const providers = [
    provider({
      driver: "omp",
      models: [
        { slug: "openai/gpt-5.6-sol", isDefault: true },
        { slug: "anthropic/claude-sonnet-5" },
      ],
    }),
    provider({ driver: "codex", models: [{ slug: "gpt-5.6-sol", isDefault: true }] }),
    provider({
      driver: "claudeAgent",
      models: [{ slug: "claude-sonnet-5", isDefault: true }],
    }),
  ];

  it.each([
    {
      sourceSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
        options: [{ id: "reasoning_effort", value: "high" }],
      },
      targetModel: "openai/gpt-5.6-sol",
    },
    {
      sourceSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-5",
        options: [{ id: "reasoning_effort", value: "high" }],
      },
      targetModel: "anthropic/claude-sonnet-5",
    },
  ])(
    "translates a direct-provider source to the matching OMP route",
    ({ sourceSelection, targetModel }) => {
      expect(resolveScaffoldDraftModelSelection(providers, sourceSelection)).toEqual({
        ...sourceSelection,
        instanceId: "omp",
        model: targetModel,
      });
    },
  );

  it("uses the OMP default when a direct-provider model has no unique route", () => {
    expect(
      resolveScaffoldDraftModelSelection(providers, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-unknown",
      }),
    ).toEqual({
      instanceId: "omp",
      model: "openai/gpt-5.6-sol",
    });
  });

  it("preserves an exact target OMP model and its options", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("omp"),
      model: "anthropic/claude-sonnet-5",
      options: [{ id: "reasoning_effort", value: "high" }],
    };

    expect(resolveScaffoldDraftModelSelection(providers, selection)).toBe(selection);
  });

  it("materializes the target model's default effort for a new Scaffold grant", () => {
    const providersWithEffort = [
      provider({
        driver: "omp",
        models: [
          {
            slug: "openai/gpt-5.6-sol",
            isDefault: true,
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Effort",
                  type: "select",
                  currentValue: "high",
                  options: [{ id: "high", label: "High", isDefault: true }],
                },
              ],
            },
          },
        ],
      }),
    ];

    expect(resolveScaffoldDraftModelSelection(providersWithEffort, null)).toEqual({
      instanceId: "omp",
      model: "openai/gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("translates a local OMP route to the unique target route with the same payload", () => {
    expect(
      resolveScaffoldDraftModelSelection(providers, {
        instanceId: ProviderInstanceId.make("omp"),
        model: "openai-codex/gpt-5.6-sol",
        options: [{ id: "reasoning_effort", value: "high" }],
      }),
    ).toEqual({
      instanceId: "omp",
      model: "openai/gpt-5.6-sol",
      options: [{ id: "reasoning_effort", value: "high" }],
    });
  });

  it("preserves nested route payloads after replacing only the route prefix", () => {
    const nestedProviders = [
      provider({
        driver: "omp",
        models: [
          { slug: "scaffold/openai/gpt-5.6-sol" },
          { slug: "scaffold/anthropic/claude-sonnet-5", isDefault: true },
        ],
      }),
    ];

    expect(
      resolveScaffoldDraftModelSelection(nestedProviders, {
        instanceId: ProviderInstanceId.make("omp"),
        model: "local/openai/gpt-5.6-sol",
      }),
    ).toEqual({ instanceId: "omp", model: "scaffold/openai/gpt-5.6-sol" });
  });

  it.each([
    {
      name: "ambiguous route payload",
      sourceModel: "local/gpt-5.6-sol",
      targetModels: [
        { slug: "openai/gpt-5.6-sol" },
        { slug: "bifrost/gpt-5.6-sol" },
        { slug: "anthropic/claude-sonnet-5", isDefault: true },
      ],
    },
    {
      name: "missing route payload",
      sourceModel: "local/missing-model",
      targetModels: [
        { slug: "openai/gpt-5.6-sol" },
        { slug: "anthropic/claude-sonnet-5", isDefault: true },
      ],
    },
  ])("uses the target OMP default for a $name", ({ sourceModel, targetModels }) => {
    expect(
      resolveScaffoldDraftModelSelection([provider({ driver: "omp", models: targetModels })], {
        instanceId: ProviderInstanceId.make("omp"),
        model: sourceModel,
      }),
    ).toEqual({ instanceId: "omp", model: "anthropic/claude-sonnet-5" });
  });

  it("returns null until the target OMP catalog has a default-capable model", () => {
    expect(resolveScaffoldDraftModelSelection([], null)).toBeNull();
    expect(
      resolveScaffoldDraftModelSelection([provider({ driver: "omp", models: [] })], null),
    ).toBeNull();
  });
});
