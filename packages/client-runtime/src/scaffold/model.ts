import {
  EnvironmentId,
  type ModelSelection,
  NonNegativeInt,
  ProjectId,
  ScaffoldAgentEffort,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const ScaffoldDeployment = Schema.Literals(["staging", "production"]);
export type ScaffoldDeployment = typeof ScaffoldDeployment.Type;

export const ScaffoldSessionStatus = Schema.Literals([
  "creating",
  "restoring_snapshot",
  "starting",
  "ready",
  "agent_running",
  "paused",
  "resuming",
  "stopped",
  "failed",
]);
export type ScaffoldSessionStatus = typeof ScaffoldSessionStatus.Type;

export const ScaffoldLifecycleActionKind = Schema.Literals(["create", "resume", "pause"]);
export type ScaffoldLifecycleActionKind = typeof ScaffoldLifecycleActionKind.Type;

export class ScaffoldConnectionProfile extends Schema.Class<ScaffoldConnectionProfile>(
  "ScaffoldConnectionProfile",
)({
  connectionId: TrimmedNonEmptyString,
  deployment: ScaffoldDeployment,
  controlPlaneBaseUrl: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
}) {}

export class ScaffoldSessionProjection extends Schema.Class<ScaffoldSessionProjection>(
  "ScaffoldSessionProjection",
)({
  environmentId: EnvironmentId,
  connectionId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  status: ScaffoldSessionStatus,
  lifecycleEpoch: NonNegativeInt,
  updatedAt: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
}) {}

export class ScaffoldCreateParameters extends Schema.Class<ScaffoldCreateParameters>(
  "ScaffoldCreateParameters",
)({
  sourceRef: Schema.optionalKey(TrimmedNonEmptyString),
  snapshotId: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  modelRouteId: Schema.optionalKey(TrimmedNonEmptyString),
  agentEffort: Schema.optionalKey(ScaffoldAgentEffort),
}) {}

const SCAFFOLD_AGENT_EFFORTS = new Set<string>(ScaffoldAgentEffort.literals);

/**
 * Converts an OMP catalog selection into the logical route granted when the
 * Scaffold sandbox is created. The route is durable, but contains no account
 * credential or provider grant.
 */
export function scaffoldCreateParametersForModelSelection(
  selection: ModelSelection,
): Pick<ScaffoldCreateParameters, "modelRouteId" | "agentEffort"> | null {
  if (selection.instanceId !== "omp") return null;

  const [provider, ...modelSegments] = selection.model.trim().split("/");
  const model = modelSegments.join("/");
  if (!provider || !model) return null;
  const modelRouteId =
    provider === "openai" || provider === "openai-codex"
      ? `scaffold-openai/${model}`
      : provider === "anthropic" || provider === "ashler"
        ? `${provider}/${model}`
        : null;
  if (modelRouteId === null) return null;

  const effort = selection.options?.find(
    (option) =>
      option.id === "reasoningEffort" || option.id === "reasoning_effort" || option.id === "effort",
  )?.value;
  const agentEffort =
    typeof effort === "string" && SCAFFOLD_AGENT_EFFORTS.has(effort)
      ? (effort as ScaffoldAgentEffort)
      : undefined;
  return {
    modelRouteId,
    ...(agentEffort ? { agentEffort } : {}),
  };
}

const ScaffoldLifecycleActionBase = {
  actionId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  connectionId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  expectedLifecycleEpoch: NonNegativeInt,
  createdAt: TrimmedNonEmptyString,
  attempt: NonNegativeInt,
  nextAttemptAt: Schema.NullOr(NonNegativeInt),
  lastErrorCode: Schema.NullOr(TrimmedNonEmptyString),
  blocked: Schema.Boolean,
} as const;

/** Persisted create intent. Transport credentials are intentionally absent. */
export class ScaffoldCreateLifecycleAction extends Schema.Class<ScaffoldCreateLifecycleAction>(
  "ScaffoldCreateLifecycleAction",
)({
  ...ScaffoldLifecycleActionBase,
  kind: Schema.Literal("create"),
  // Optional only so persisted pre-target actions can still be decoded and
  // quarantined. Every newly constructed create action must supply a target.
  deployment: Schema.optionalKey(ScaffoldDeployment),
  draftId: Schema.optionalKey(TrimmedNonEmptyString),
  sourceEnvironmentId: Schema.optionalKey(EnvironmentId),
  sourceProjectId: Schema.optionalKey(ProjectId),
  create: ScaffoldCreateParameters,
}) {}

export class ScaffoldResumeLifecycleAction extends Schema.Class<ScaffoldResumeLifecycleAction>(
  "ScaffoldResumeLifecycleAction",
)({
  ...ScaffoldLifecycleActionBase,
  kind: Schema.Literal("resume"),
}) {}

export class ScaffoldPauseLifecycleAction extends Schema.Class<ScaffoldPauseLifecycleAction>(
  "ScaffoldPauseLifecycleAction",
)({
  ...ScaffoldLifecycleActionBase,
  kind: Schema.Literal("pause"),
  sourceThreadId: ThreadId,
}) {}

/**
 * Persisted lifecycle intent. The discriminant makes create parameters
 * available only on create actions, and no transport grant or token can be
 * represented by this schema.
 */
export const ScaffoldLifecycleAction = Schema.Union([
  ScaffoldCreateLifecycleAction,
  ScaffoldResumeLifecycleAction,
  ScaffoldPauseLifecycleAction,
]);
export type ScaffoldLifecycleAction = typeof ScaffoldLifecycleAction.Type;

export interface ScaffoldSessionObservation {
  readonly sessionId: string;
  readonly status: ScaffoldSessionStatus;
  readonly lifecycleEpoch: number;
  readonly updatedAt?: string;
  readonly errorCode?: string;
  readonly message?: string;
}

/** Ephemeral authority returned by Scaffold. Never persist this object. */
export interface ScaffoldT3TransportGrant {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
  readonly lifecycleEpoch: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly token: string;
  readonly expiresAt: string;
}

export function normalizeScaffoldControlPlaneBaseUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      throw new Error("invalid");
    }
    return `${url.origin}/`;
  } catch {
    // Do not include the rejected URL: it may contain credentials or tokens.
    throw new Error("Invalid Scaffold control-plane URL.");
  }
}

export function makeScaffoldSessionProjection(input: {
  readonly environmentId: EnvironmentId;
  readonly connectionId: string;
  readonly sessionId: string;
  readonly status: ScaffoldSessionStatus;
  readonly lifecycleEpoch?: number;
  readonly updatedAt: string;
  readonly label: string;
}): ScaffoldSessionProjection {
  return new ScaffoldSessionProjection({
    ...input,
    lifecycleEpoch: input.lifecycleEpoch ?? 0,
  });
}
