import { describe, expect, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";

import {
  ashlerOmpModelIsAllowed,
  filterAshlerOmpModels,
  resolveAshlerOmpDefaultModel,
  resolveAshlerOmpAdvisor,
} from "./OmpModelPolicy.ts";

const model = (slug: string, name = slug): ServerProviderModel => ({
  slug,
  name,
  isCustom: false,
  capabilities: null,
});

describe("Ashler OMP model policy", () => {
  it("accepts current models across local and Scaffold aliases", () => {
    expect(ashlerOmpModelIsAllowed("openai-codex/gpt-5.6-luna")).toBe(true);
    expect(ashlerOmpModelIsAllowed("scaffold-openai/gpt-5.6-terra")).toBe(true);
    expect(ashlerOmpModelIsAllowed("scaffold-anthropic/claude-fable-5")).toBe(true);
    expect(ashlerOmpModelIsAllowed("ashler/x-ai/grok-4.5")).toBe(true);
    expect(ashlerOmpModelIsAllowed("bifrost/moonshotai/Kimi-K2.6")).toBe(true);
  });

  it("rejects retired, unknown, and malformed routes", () => {
    expect(ashlerOmpModelIsAllowed("openai-codex/gpt-5.5")).toBe(false);
    expect(ashlerOmpModelIsAllowed("anthropic/claude-opus-4-7")).toBe(false);
    expect(ashlerOmpModelIsAllowed("ashler/deepseek/deepseek-v4")).toBe(false);
    expect(ashlerOmpModelIsAllowed("gpt-5.6-terra")).toBe(false);
  });

  it("filters without replacing OMP names or capabilities", () => {
    const capabilities = {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Thinking",
          type: "select" as const,
          currentValue: "high",
          options: [{ id: "high", label: "High", isDefault: true }],
        },
      ],
    };
    const terra: ServerProviderModel = {
      ...model("openai/gpt-5.6-terra", "Terra from OMP"),
      capabilities,
    };
    const filtered = filterAshlerOmpModels([terra, model("openai/gpt-5.5")]);

    expect(filtered).toEqual([terra]);
    expect(filtered[0]).toBe(terra);
  });

  it("uses Sonnet high for OpenAI primaries", () => {
    expect(
      resolveAshlerOmpAdvisor({
        primaryModelSlug: "openai-codex/gpt-5.6-sol",
        availableModels: [model("openai-codex/gpt-5.6-sol"), model("anthropic/claude-sonnet-5")],
      }),
    ).toEqual({ modelSlug: "anthropic/claude-sonnet-5", effort: "high" });
  });

  it("uses Terra high for Anthropic primaries and the policy default", () => {
    const availableModels = [
      model("scaffold-openai/gpt-5.6-terra"),
      model("anthropic/claude-fable-5"),
      model("ashler/x-ai/grok-4.5"),
    ];
    expect(
      resolveAshlerOmpAdvisor({
        primaryModelSlug: "anthropic/claude-fable-5",
        availableModels,
      }),
    ).toEqual({ modelSlug: "scaffold-openai/gpt-5.6-terra", effort: "high" });
    expect(
      resolveAshlerOmpAdvisor({
        primaryModelSlug: "ashler/x-ai/grok-4.5",
        availableModels,
      }),
    ).toEqual({ modelSlug: "scaffold-openai/gpt-5.6-terra", effort: "high" });
  });

  it("does not invent an unavailable advisor", () => {
    expect(
      resolveAshlerOmpAdvisor({
        primaryModelSlug: "openai/gpt-5.6-terra",
        availableModels: [model("openai/gpt-5.6-terra")],
      }),
    ).toBeUndefined();
  });

  it("prefers Sol but falls back only to a live allowed OMP model", () => {
    const terra = model("openai-codex/gpt-5.6-terra");
    const sol = model("openai-codex/gpt-5.6-sol");
    expect(resolveAshlerOmpDefaultModel([terra, sol])).toBe(sol);
    expect(resolveAshlerOmpDefaultModel([terra])).toBe(terra);
    expect(resolveAshlerOmpDefaultModel([model("openai-codex/gpt-5.5")])).toBeUndefined();
    expect(resolveAshlerOmpDefaultModel([])).toBeUndefined();
  });
});
