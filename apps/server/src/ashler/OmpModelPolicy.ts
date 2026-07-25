import type { ServerProviderModel } from "@t3tools/contracts";
import { PREFERRED_DEFAULT_OMP_MODELS } from "@t3tools/contracts";

import policyDocument from "../../../../ashler/model-policy.json" with { type: "json" };

export type AshlerOmpModelFamily = "openai" | "anthropic" | "bifrost";

export interface AshlerOmpAdvisorSelection {
  readonly modelSlug: string;
  readonly effort: "high";
}

interface ModelFamilyPolicy {
  readonly providerAliases: ReadonlyArray<string>;
  readonly modelIds: ReadonlyArray<string>;
}

interface AdvisorTargetPolicy {
  readonly targetFamily: AshlerOmpModelFamily;
  readonly modelId: string;
  readonly effort: "high";
}

const MODEL_FAMILIES = policyDocument.modelFamilies satisfies Record<
  AshlerOmpModelFamily,
  ModelFamilyPolicy
>;

function decodeAdvisorTargetPolicy(input: {
  readonly targetFamily: string;
  readonly modelId: string;
  readonly effort: string;
}): AdvisorTargetPolicy {
  if (!(input.targetFamily in MODEL_FAMILIES) || input.effort !== "high") {
    throw new Error("Invalid Ashler OMP advisor model policy");
  }
  const targetFamily = input.targetFamily as AshlerOmpModelFamily;
  const configuredModels = MODEL_FAMILIES[targetFamily].modelIds;
  if (!configuredModels.some((modelId) => modelId.toLowerCase() === input.modelId.toLowerCase())) {
    throw new Error("Ashler OMP advisor target is not in the model allowlist");
  }
  return {
    targetFamily,
    modelId: input.modelId,
    effort: input.effort,
  };
}

const ADVISOR_POLICY: {
  readonly openaiPrimary: AdvisorTargetPolicy;
  readonly anthropicPrimary: AdvisorTargetPolicy;
  readonly default: AdvisorTargetPolicy;
} = {
  openaiPrimary: decodeAdvisorTargetPolicy(policyDocument.advisor.openaiPrimary),
  anthropicPrimary: decodeAdvisorTargetPolicy(policyDocument.advisor.anthropicPrimary),
  default: decodeAdvisorTargetPolicy(policyDocument.advisor.default),
};

const normalizedProviderAliases = new Map<string, AshlerOmpModelFamily>();
const normalizedModelIds = new Map<AshlerOmpModelFamily, ReadonlySet<string>>();

for (const [family, config] of Object.entries(MODEL_FAMILIES) as ReadonlyArray<
  readonly [AshlerOmpModelFamily, ModelFamilyPolicy]
>) {
  for (const alias of config.providerAliases) {
    normalizedProviderAliases.set(alias.toLowerCase(), family);
  }
  normalizedModelIds.set(family, new Set(config.modelIds.map((modelId) => modelId.toLowerCase())));
}

function splitModelSlug(
  slug: string,
): { readonly provider: string; readonly modelId: string } | null {
  const normalized = slug.trim();
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator === normalized.length - 1) return null;
  return {
    provider: normalized.slice(0, separator),
    modelId: normalized.slice(separator + 1),
  };
}

export function ashlerOmpModelFamily(slug: string): AshlerOmpModelFamily | undefined {
  const parsed = splitModelSlug(slug);
  if (!parsed) return undefined;
  return normalizedProviderAliases.get(parsed.provider.toLowerCase());
}

export function ashlerOmpModelIsAllowed(slug: string): boolean {
  const parsed = splitModelSlug(slug);
  if (!parsed) return false;
  const family = normalizedProviderAliases.get(parsed.provider.toLowerCase());
  if (!family) return false;
  return normalizedModelIds.get(family)?.has(parsed.modelId.toLowerCase()) ?? false;
}

/**
 * Return only models OMP actually discovered and Ashler currently supports.
 * Model objects are deliberately not rebuilt so names, defaults, and runtime
 * capabilities remain authoritative to OMP.
 */
export function filterAshlerOmpModels(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  return models.filter((model) => ashlerOmpModelIsAllowed(model.slug));
}

/** Choose a default exclusively from the live, policy-filtered OMP catalog. */
export function resolveAshlerOmpDefaultModel(
  models: ReadonlyArray<ServerProviderModel>,
): ServerProviderModel | undefined {
  const allowed = filterAshlerOmpModels(models);
  for (const preferredSlug of PREFERRED_DEFAULT_OMP_MODELS) {
    const preferred = allowed.find(
      (model) => model.slug.toLowerCase() === preferredSlug.toLowerCase(),
    );
    if (preferred) return preferred;
  }
  return allowed.find((model) => model.isDefault) ?? allowed[0];
}

function advisorTargetForPrimary(primaryModelSlug: string): AdvisorTargetPolicy {
  const primaryFamily = ashlerOmpModelFamily(primaryModelSlug);
  if (primaryFamily === "openai") return ADVISOR_POLICY.openaiPrimary;
  if (primaryFamily === "anthropic") return ADVISOR_POLICY.anthropicPrimary;
  return ADVISOR_POLICY.default;
}

/**
 * Resolve the cross-provider advisor from the live, already-filtered catalog.
 * Missing targets stay missing; policy never fabricates an advisor route.
 */
export function resolveAshlerOmpAdvisor(input: {
  readonly primaryModelSlug: string;
  readonly availableModels: ReadonlyArray<ServerProviderModel>;
}): AshlerOmpAdvisorSelection | undefined {
  const target = advisorTargetForPrimary(input.primaryModelSlug);
  const targetId = target.modelId.toLowerCase();
  const model = input.availableModels.find((candidate) => {
    const parsed = splitModelSlug(candidate.slug);
    return (
      parsed !== null &&
      ashlerOmpModelFamily(candidate.slug) === target.targetFamily &&
      parsed.modelId.toLowerCase() === targetId &&
      ashlerOmpModelIsAllowed(candidate.slug)
    );
  });
  return model ? { modelSlug: model.slug, effort: target.effort } : undefined;
}
