import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

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

export const ScaffoldAttachCredential = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9._~-]+$/),
);
export type ScaffoldAttachCredential = typeof ScaffoldAttachCredential.Type;

export class ScaffoldSessionObservation extends Schema.Class<ScaffoldSessionObservation>(
  "ScaffoldSessionObservation",
)({
  sessionId: TrimmedNonEmptyString,
  status: ScaffoldSessionStatus,
  lifecycleEpoch: NonNegativeInt,
  updatedAt: Schema.optionalKey(TrimmedNonEmptyString),
}) {}

export class ScaffoldSessionLinks extends Schema.Class<ScaffoldSessionLinks>(
  "ScaffoldSessionLinks",
)({
  session: TrimmedNonEmptyString,
  web: TrimmedNonEmptyString,
  tilt: TrimmedNonEmptyString,
}) {}

/** Safe to cache. This projection deliberately cannot represent transport authority. */
export class ScaffoldEnvironmentBinding extends Schema.Class<ScaffoldEnvironmentBinding>(
  "ScaffoldEnvironmentBinding",
)({
  deployment: ScaffoldDeployment,
  environmentId: EnvironmentId,
  sessionId: TrimmedNonEmptyString,
  lifecycleEpoch: NonNegativeInt,
  status: ScaffoldSessionStatus,
  links: ScaffoldSessionLinks,
  lastKnownAt: TrimmedNonEmptyString,
}) {}

export class ScaffoldCreateParameters extends Schema.Class<ScaffoldCreateParameters>(
  "ScaffoldCreateParameters",
)({
  sourceRef: Schema.optionalKey(TrimmedNonEmptyString),
  snapshotId: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
}) {}

export class ScaffoldCreateAndPrepareInput extends Schema.TaggedClass<ScaffoldCreateAndPrepareInput>()(
  "ScaffoldCreateAndPrepareInput",
  {
    deployment: ScaffoldDeployment,
    operationId: TrimmedNonEmptyString,
    sessionId: Schema.optionalKey(TrimmedNonEmptyString),
    create: ScaffoldCreateParameters,
  },
) {}

export class ScaffoldResumeAndPrepareInput extends Schema.TaggedClass<ScaffoldResumeAndPrepareInput>()(
  "ScaffoldResumeAndPrepareInput",
  {
    deployment: ScaffoldDeployment,
    operationId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    sessionId: TrimmedNonEmptyString,
    expectedLifecycleEpoch: NonNegativeInt,
  },
) {}

export const ScaffoldPrepareConnectionInput = Schema.Union([
  ScaffoldCreateAndPrepareInput,
  ScaffoldResumeAndPrepareInput,
]);
export type ScaffoldPrepareConnectionInput = typeof ScaffoldPrepareConnectionInput.Type;

export class ScaffoldPauseInput extends Schema.Class<ScaffoldPauseInput>("ScaffoldPauseInput")({
  deployment: ScaffoldDeployment,
  operationId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  sessionId: TrimmedNonEmptyString,
  expectedLifecycleEpoch: NonNegativeInt,
}) {}

/**
 * Ephemeral RPC result. `bootstrapCredential` must be exchanged directly with
 * the sandbox and must never be written to a client cache or connection profile.
 */
export class ScaffoldPreparedConnection extends Schema.Class<ScaffoldPreparedConnection>(
  "ScaffoldPreparedConnection",
)({
  binding: ScaffoldEnvironmentBinding,
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  bootstrapCredential: TrimmedNonEmptyString,
  attachCredential: ScaffoldAttachCredential,
  expiresAt: TrimmedNonEmptyString,
}) {}

export const ScaffoldLifecycleErrorReason = Schema.Literals([
  "configuration",
  "authentication",
  "network",
  "conflict",
  "not_found",
  "terminal",
  "invalid_response",
  "unavailable",
]);
export type ScaffoldLifecycleErrorReason = typeof ScaffoldLifecycleErrorReason.Type;

export class ScaffoldLifecycleError extends Schema.TaggedErrorClass<ScaffoldLifecycleError>()(
  "ScaffoldLifecycleError",
  {
    reason: ScaffoldLifecycleErrorReason,
    message: Schema.String,
    status: NonNegativeInt,
    code: TrimmedNonEmptyString,
    retryAfterMs: Schema.optionalKey(NonNegativeInt),
    observation: Schema.optionalKey(ScaffoldSessionObservation),
  },
) {}
