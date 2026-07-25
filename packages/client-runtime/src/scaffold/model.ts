import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "@t3tools/contracts";
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
}) {}

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
