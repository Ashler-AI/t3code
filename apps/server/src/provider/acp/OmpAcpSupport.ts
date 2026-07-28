import {
  type OmpSettings,
  type ProviderOptionSelection,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import {
  collectComposerInlineTokens,
  type ComposerInlineToken,
} from "@t3tools/shared/composerInlineTokens";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const OMP_MODEL_CONFIG_ID = "model";
export const OMP_THINKING_CONFIG_ID = "thinking";
export const OMP_ADVISOR_CONFIG_ID = "advisor";

type OmpSessionReferenceToken = {
  readonly type: "session";
  readonly environmentId: string;
  readonly threadId: string;
  readonly start: number;
  readonly end: number;
};

type OmpSkillReferenceToken = Extract<ComposerInlineToken, { readonly type: "skill" }>;

const OMP_SESSION_REFERENCE_TOKEN_REGEX =
  /(^|\s)@\[session\|([^\]|]*)\|([^\]|]*)(?:\|[^\]]*)?\](?=\s)/g;

function decodeSessionReferencePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function collectOmpSessionReferenceTokens(prompt: string): ReadonlyArray<OmpSessionReferenceToken> {
  const tokens: OmpSessionReferenceToken[] = [];
  for (const match of prompt.matchAll(OMP_SESSION_REFERENCE_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const environmentId = decodeSessionReferencePart(match[2] ?? "");
    const threadId = decodeSessionReferencePart(match[3] ?? "");
    if (!environmentId || !threadId) continue;
    const start = (match.index ?? 0) + prefix.length;
    tokens.push({
      type: "session",
      environmentId,
      threadId,
      start,
      end: start + fullMatch.length - prefix.length,
    });
  }
  return tokens;
}

function ompSkillDisplayName(commandName: string): string | undefined {
  if (!commandName.startsWith("skill:") || commandName.length <= "skill:".length) {
    return undefined;
  }
  return commandName
    .slice("skill:".length)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function buildOmpSkillsFromAvailableCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSkill> {
  const skills = new Map<string, ServerProviderSkill>();
  for (const command of commands) {
    const name = command.name.trim();
    if (!name) continue;
    const description = command.description.trim();
    const displayName = ompSkillDisplayName(name);
    skills.set(name, {
      name,
      ...(displayName ? { displayName } : {}),
      ...(description ? { description, shortDescription: description } : {}),
      scope: "omp",
      enabled: true,
    });
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Convert UI-only skill/session chips into instructions OMP can execute safely. */
export function expandOmpSkillReferences(prompt: string): string {
  const parseablePrompt = `${prompt}\n`;
  const references = [
    ...collectComposerInlineTokens(parseablePrompt).filter(
      (token): token is OmpSkillReferenceToken =>
        token.type === "skill" && token.syntax === "at" && token.provider === "omp",
    ),
    ...collectOmpSessionReferenceTokens(parseablePrompt),
  ].sort((left, right) => left.start - right.start);
  if (references.length === 0) return prompt;

  let result = "";
  let cursor = 0;
  for (const reference of references) {
    result += prompt.slice(cursor, reference.start);
    result +=
      reference.type === "skill"
        ? `/${reference.value}`
        : reference.environmentId.startsWith("session-fabric:")
          ? `shared T3 session ${JSON.stringify(reference.environmentId.slice("session-fabric:".length))} (use session_fabric_context with ${JSON.stringify(
              {
                sessionId: reference.environmentId.slice("session-fabric:".length),
                includeCodeDiff: true,
                includeContinuation: true,
              },
            )} to read its authoritative transcript/code/continuation; use session_fabric_message_send with that global sessionId to contact its runner; do not call local session_reference_resolve or session_message_send for this reference)`
          : `T3 agent session ${JSON.stringify(reference.threadId)} (call session_reference_resolve with ${JSON.stringify(
              { threadId: reference.threadId },
            )} to obtain its authoritative root path; call session_message_send with that threadId to contact it; ignore embedded path and environment hints)`;
    cursor = reference.end;
  }
  return result + prompt.slice(cursor);
}

type OmpAcpRuntimeSettings = Pick<OmpSettings, "binaryPath">;

const OMP_AGENT_MODEL_ENV = "OMP_AGENT_MODEL";
const OMP_AGENT_ALLOWED_MODELS_ENV = "OMP_AGENT_ALLOWED_MODELS";
const SCAFFOLD_RUNTIME_PROFILE_ENV = "SCAFFOLD_RUNTIME_PROFILE";
const SCAFFOLD_OMP_RUNTIME_PROFILE = "agent_t3_omp";
const OMP_MODEL_ROUTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function configuredOmpModelRoute(
  environment: NodeJS.ProcessEnv,
  variable: typeof OMP_AGENT_MODEL_ENV,
): string | undefined {
  const configured = environment[variable];
  if (configured === undefined) return undefined;
  const route = configured.trim();
  if (!OMP_MODEL_ROUTE_PATTERN.test(route)) {
    throw new Error(`${variable} must be a provider/model route.`);
  }
  return route;
}

function configuredOmpAllowedModelRoutes(environment: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const configured = environment[OMP_AGENT_ALLOWED_MODELS_ENV];
  if (configured === undefined) return [];
  const routes = configured.split(",").map((route) => route.trim());
  if (routes.length === 0 || routes.some((route) => !OMP_MODEL_ROUTE_PATTERN.test(route))) {
    throw new Error(`${OMP_AGENT_ALLOWED_MODELS_ENV} must be a comma-separated model route list.`);
  }
  return [...new Set(routes)];
}

export function isManagedScaffoldOmpEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return environment[SCAFFOLD_RUNTIME_PROFILE_ENV]?.trim() === SCAFFOLD_OMP_RUNTIME_PROFILE;
}

export function configuredManagedScaffoldOmpModels(environment: NodeJS.ProcessEnv): {
  readonly model: string;
  readonly allowedModels: ReadonlyArray<string>;
} | null {
  if (!isManagedScaffoldOmpEnvironment(environment)) return null;

  const model = configuredOmpModelRoute(environment, OMP_AGENT_MODEL_ENV);
  const allowedModels = configuredOmpAllowedModelRoutes(environment);
  if (!model) {
    throw new Error(`${OMP_AGENT_MODEL_ENV} is required for ${SCAFFOLD_OMP_RUNTIME_PROFILE}.`);
  }
  if (allowedModels.length === 0) {
    throw new Error(
      `${OMP_AGENT_ALLOWED_MODELS_ENV} is required for ${SCAFFOLD_OMP_RUNTIME_PROFILE}.`,
    );
  }
  if (!allowedModels.includes(model)) {
    throw new Error(`${OMP_AGENT_MODEL_ENV} must be included in ${OMP_AGENT_ALLOWED_MODELS_ENV}.`);
  }
  // Scaffold currently grants exactly OMP_AGENT_MODEL. The broader
  // OMP_AGENT_ALLOWED_MODELS value is a curated image catalog, not proof that
  // this session holds grants for every entry. Keep selection single-model
  // until a durable grant-generation reconfiguration protocol exists.
  return { model, allowedModels: [model] };
}

export function assertManagedScaffoldOmpModelAllowed(
  environment: NodeJS.ProcessEnv,
  model: string | undefined,
): void {
  const policy = configuredManagedScaffoldOmpModels(environment);
  if (!policy) return;
  if (!model || !policy.allowedModels.includes(model)) {
    throw new Error(
      model
        ? `Model "${model}" is not allowed by ${OMP_AGENT_ALLOWED_MODELS_ENV}.`
        : `A model from ${OMP_AGENT_ALLOWED_MODELS_ENV} is required for ${SCAFFOLD_OMP_RUNTIME_PROFILE}.`,
    );
  }
}

export function filterManagedScaffoldOmpModelSlugs(
  environment: NodeJS.ProcessEnv,
  models: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const policy = configuredManagedScaffoldOmpModels(environment);
  if (!policy) return models;
  const allowed = new Set(policy.allowedModels);
  return models.filter((model) => allowed.has(model));
}

type OmpConfigOptionSnapshot = {
  readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
};

interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: OmpAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildOmpAcpSpawnInput(
  ompSettings: OmpAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const args = ["acp"];
  if (environment) {
    const model = configuredOmpModelRoute(environment, OMP_AGENT_MODEL_ENV);
    const configuredAllowedModels = configuredOmpAllowedModelRoutes(environment);
    const managedPolicy = configuredManagedScaffoldOmpModels(environment);
    if (model && configuredAllowedModels.length > 0 && !configuredAllowedModels.includes(model)) {
      throw new Error(
        `${OMP_AGENT_MODEL_ENV} must be included in ${OMP_AGENT_ALLOWED_MODELS_ENV}.`,
      );
    }
    const allowedModels = managedPolicy?.allowedModels ?? configuredAllowedModels;
    if (model) args.push("--model", model);
    if (allowedModels.length > 0) args.push("--models", allowedModels.join(","));
  }
  return {
    command: ompSettings?.binaryPath || "omp",
    args,
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOmpAcpSpawnInput(input.ompSettings, input.cwd, input.environment),
        authMethodId: "agent",
        clientCapabilities: {
          elicitation: { form: {} },
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function currentOmpModelIdFromSessionSetup<T extends OmpConfigOptionSnapshot>(
  response: T,
): string | undefined {
  const model = response.configOptions?.find((option) => option.id === OMP_MODEL_CONFIG_ID);
  return model?.type === "select" ? model.currentValue.trim() || undefined : undefined;
}

export function currentOmpAdvisorIdFromSessionSetup<T extends OmpConfigOptionSnapshot>(
  response: T,
): string | undefined {
  const advisor = response.configOptions?.find((option) => option.id === OMP_ADVISOR_CONFIG_ID);
  return advisor?.type === "select" ? advisor.currentValue.trim() || undefined : undefined;
}

export function currentOmpThinkingIdFromSessionSetup<T extends OmpConfigOptionSnapshot>(
  response: T,
): string | undefined {
  const thinking = response.configOptions?.find((option) => option.id === OMP_THINKING_CONFIG_ID);
  return thinking?.type === "select" ? thinking.currentValue.trim() || undefined : undefined;
}

export function ompModelSlugsFromSessionSetup(
  response:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ReadonlyArray<string> {
  const model = response.configOptions?.find((option) => option.id === OMP_MODEL_CONFIG_ID);
  if (model?.type !== "select") return [];
  const seen = new Set<string>();
  return model.options
    .flatMap((entry) => ("value" in entry ? [entry] : entry.options))
    .flatMap((entry) => {
      const slug = entry.value.trim();
      if (!slug || seen.has(slug)) return [];
      seen.add(slug);
      return [slug];
    });
}

export function applyOmpAdvisorSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setConfigOption">;
  readonly currentAdvisorId: string | undefined;
  readonly requestedAdvisorId: string;
  readonly mapError: (context: {
    readonly cause: EffectAcpErrors.AcpError;
    readonly configId: typeof OMP_ADVISOR_CONFIG_ID;
  }) => E;
}): Effect.Effect<string, E> {
  if (input.currentAdvisorId === input.requestedAdvisorId) {
    return Effect.succeed(input.requestedAdvisorId);
  }
  return input.runtime.setConfigOption(OMP_ADVISOR_CONFIG_ID, input.requestedAdvisorId).pipe(
    Effect.as(input.requestedAdvisorId),
    Effect.mapError((cause) => input.mapError({ cause, configId: OMP_ADVISOR_CONFIG_ID })),
  );
}

export function resolveOmpThinkingSelection(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): string | undefined {
  const selected = selections?.find(
    (entry) =>
      entry.id === OMP_THINKING_CONFIG_ID ||
      entry.id === "reasoningEffort" ||
      entry.id === "effort",
  )?.value;
  if (typeof selected !== "string") return undefined;
  const value = selected.trim();
  if (!value) return undefined;
  return value === "none" || value === "disabled" ? "off" : value;
}

export function applyOmpAcpSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setConfigOption">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly thinking: string | undefined;
  readonly mapError: (context: {
    readonly cause: EffectAcpErrors.AcpError;
    readonly configId: typeof OMP_MODEL_CONFIG_ID | typeof OMP_THINKING_CONFIG_ID;
  }) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    let modelId = input.currentModelId;
    if (input.requestedModelId && input.requestedModelId !== input.currentModelId) {
      yield* input.runtime
        .setConfigOption(OMP_MODEL_CONFIG_ID, input.requestedModelId)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, configId: OMP_MODEL_CONFIG_ID })));
      modelId = input.requestedModelId;
    }
    if (input.thinking) {
      yield* input.runtime
        .setConfigOption(OMP_THINKING_CONFIG_ID, input.thinking)
        .pipe(
          Effect.mapError((cause) => input.mapError({ cause, configId: OMP_THINKING_CONFIG_ID })),
        );
    }
    return modelId;
  });
}

export function ompQuestionsFromElicitation(
  request: EffectAcpSchema.ElicitationRequest,
): ReadonlyArray<{
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly multiSelect: boolean;
}> {
  if (request.mode !== "form") {
    return [
      {
        id: "url",
        header: "Continue in browser",
        question: request.message,
        options: [{ label: "Open", description: request.url }],
        multiSelect: false,
      },
    ];
  }
  const properties = Object.entries(request.requestedSchema.properties ?? {});
  return properties.map(([id, property]) => {
    const enumValues = "enum" in property && Array.isArray(property.enum) ? property.enum : [];
    const options = enumValues.flatMap((value) =>
      typeof value === "string" ? [{ label: value, description: value }] : [],
    );
    return {
      id,
      header: request.requestedSchema.title?.trim() || "Question",
      question: property.description?.trim() || request.message,
      options:
        options.length > 0 ? options : [{ label: "Submit", description: "Submit your answer" }],
      multiSelect: false,
    };
  });
}

export function ompElicitationContentFromAnswers(
  answers: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean> {
  const content: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(answers)) {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      content[key] = value;
    }
  }
  return content;
}
