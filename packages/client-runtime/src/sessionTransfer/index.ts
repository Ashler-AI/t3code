export type ScaffoldSessionTransferKind = "exact-omp" | "contextual-native";

const CONTEXTUAL_NATIVE_PROVIDER_NAMES = new Set([
  "claude",
  "claude agent",
  "claudeagent",
  "codex",
]);

function normalizedProviderName(providerName: string | null | undefined): string | null {
  const normalized = providerName?.trim().toLowerCase();
  return normalized ? normalized : null;
}

/**
 * OMP can preserve its own private continuation exactly. Codex and Claude can
 * only hand off user-visible context into a fresh OMP destination thread.
 */
export function scaffoldSessionTransferKind(
  providerName: string | null | undefined,
): ScaffoldSessionTransferKind | null {
  const normalized = normalizedProviderName(providerName);
  if (normalized === "omp") return "exact-omp";
  if (normalized !== null && CONTEXTUAL_NATIVE_PROVIDER_NAMES.has(normalized)) {
    return "contextual-native";
  }
  return null;
}

export interface ScaffoldSessionTransferPresentation {
  readonly kind: ScaffoldSessionTransferKind;
  readonly commandTitle: string;
  readonly progressVerb: string;
  readonly completionVerb: string;
  readonly disclosure: string | null;
}

export function scaffoldSessionTransferPresentation(
  kind: ScaffoldSessionTransferKind,
): ScaffoldSessionTransferPresentation {
  if (kind === "exact-omp") {
    return {
      kind,
      commandTitle: "Copy to Scaffold",
      progressVerb: "Copying session to",
      completionVerb: "Session copied to",
      disclosure: null,
    };
  }
  return {
    kind,
    commandTitle: "Continue in Scaffold (context only)",
    progressVerb: "Handing off context to",
    completionVerb: "Context handed off to",
    disclosure:
      "Starts a new OMP session with the visible conversation and workspace. It does not continue the native Codex or Claude session.",
  };
}
