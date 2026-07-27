import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const OmpAccountProvider = TrimmedNonEmptyString;
export type OmpAccountProvider = typeof OmpAccountProvider.Type;

/**
 * Opaque handle minted by OMP for account operations. It must not be a
 * credential database id or contain credential material.
 */
export const OmpAccountRef = TrimmedNonEmptyString.pipe(Schema.brand("OmpAccountRef"));
export type OmpAccountRef = typeof OmpAccountRef.Type;

export const OmpAccountAuthKind = Schema.Literals(["oauth", "api-key", "managed"]);
export type OmpAccountAuthKind = typeof OmpAccountAuthKind.Type;

export const OmpAccountState = Schema.Literals(["available", "limited", "unavailable", "unknown"]);
export type OmpAccountState = typeof OmpAccountState.Type;

export const OmpUsageUnit = Schema.Literals([
  "percent",
  "tokens",
  "requests",
  "usd",
  "minutes",
  "bytes",
  "unknown",
]);
export type OmpUsageUnit = typeof OmpUsageUnit.Type;

export const OmpUsageStatus = Schema.Literals(["ok", "warning", "exhausted", "unknown"]);
export type OmpUsageStatus = typeof OmpUsageStatus.Type;

export const OmpUsageAmount = Schema.Struct({
  used: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
  remaining: Schema.optionalKey(Schema.Number),
  usedFraction: Schema.optionalKey(Schema.Number),
  remainingFraction: Schema.optionalKey(Schema.Number),
  unit: OmpUsageUnit,
});
export type OmpUsageAmount = typeof OmpUsageAmount.Type;

/** Usage scope intentionally excludes provider account, project, and org ids. */
export const OmpUsageScope = Schema.Struct({
  provider: OmpAccountProvider,
  modelId: Schema.optionalKey(TrimmedNonEmptyString),
  tier: Schema.optionalKey(TrimmedNonEmptyString),
  windowId: Schema.optionalKey(TrimmedNonEmptyString),
  shared: Schema.optionalKey(Schema.Boolean),
});
export type OmpUsageScope = typeof OmpUsageScope.Type;

export const OmpUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  durationMs: Schema.optionalKey(Schema.Number),
  resetsAt: Schema.optionalKey(Schema.Number),
});
export type OmpUsageWindow = typeof OmpUsageWindow.Type;

export const OmpUsageLimit = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  scope: OmpUsageScope,
  window: Schema.optionalKey(OmpUsageWindow),
  amount: OmpUsageAmount,
  status: Schema.optionalKey(OmpUsageStatus),
  notes: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type OmpUsageLimit = typeof OmpUsageLimit.Type;

export const OmpUsageReport = Schema.Struct({
  provider: OmpAccountProvider,
  accountRef: Schema.optionalKey(OmpAccountRef),
  maskedAccount: Schema.optionalKey(TrimmedNonEmptyString),
  fetchedAt: Schema.Number,
  limits: Schema.Array(OmpUsageLimit),
  notes: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type OmpUsageReport = typeof OmpUsageReport.Type;

export const OmpUsageSnapshot = Schema.Struct({
  reports: Schema.Array(OmpUsageReport),
  refreshedAt: Schema.NullOr(Schema.Number),
  stale: Schema.Boolean,
  warning: Schema.NullOr(Schema.String),
});
export type OmpUsageSnapshot = typeof OmpUsageSnapshot.Type;

export const OmpAccountSummary = Schema.Struct({
  accountRef: OmpAccountRef,
  provider: OmpAccountProvider,
  authKind: OmpAccountAuthKind,
  displayName: TrimmedNonEmptyString,
  maskedEmail: Schema.optionalKey(TrimmedNonEmptyString),
  organization: Schema.optionalKey(TrimmedNonEmptyString),
  state: OmpAccountState,
  managed: Schema.Boolean,
});
export type OmpAccountSummary = typeof OmpAccountSummary.Type;

export const OmpAccountCapabilities = Schema.Struct({
  accounts: Schema.Boolean,
  login: Schema.Boolean,
  remove: Schema.Boolean,
  assignment: Schema.Boolean,
  usage: Schema.Boolean,
});
export type OmpAccountCapabilities = typeof OmpAccountCapabilities.Type;

export const OmpAccountsSnapshot = Schema.Struct({
  mode: Schema.Literals(["local", "broker"]),
  managed: Schema.Boolean,
  accounts: Schema.Array(OmpAccountSummary),
  capabilities: OmpAccountCapabilities,
  warning: Schema.NullOr(Schema.String),
});
export type OmpAccountsSnapshot = typeof OmpAccountsSnapshot.Type;

export const OmpAccountOverview = Schema.Struct({
  accounts: OmpAccountsSnapshot,
  usage: OmpUsageSnapshot,
});
export type OmpAccountOverview = typeof OmpAccountOverview.Type;

export class OmpAccountOperationError extends Schema.TaggedErrorClass<OmpAccountOperationError>()(
  "OmpAccountOperationError",
  {
    reason: Schema.Literals([
      "unavailable",
      "invalid-response",
      "managed-by-broker",
      "request-failed",
    ]),
    operation: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
  },
) {
  override get message() {
    return this.detail;
  }
}

/**
 * Sanitized reason an automatic session assignment changed. Provider-private
 * error text and credential identifiers must never cross this boundary.
 */
export const OmpAccountReassignmentReason = Schema.Literals([
  "initial-assignment",
  "load-balanced",
  "usage-limited",
  "quota-exhausted",
  "account-unavailable",
  "broker-policy",
  "unknown",
]);
export type OmpAccountReassignmentReason = typeof OmpAccountReassignmentReason.Type;

export const OmpAccountAssignment = Schema.Struct({
  threadId: ThreadId,
  account: Schema.NullOr(OmpAccountSummary),
  automatic: Schema.Literal(true),
  reassignmentReason: Schema.optionalKey(OmpAccountReassignmentReason),
});
export type OmpAccountAssignment = typeof OmpAccountAssignment.Type;

export const OmpLoginChallenge = Schema.Struct({
  flowId: TrimmedNonEmptyString,
  provider: OmpAccountProvider,
  kind: Schema.Literals(["browser", "code", "input", "complete"]),
  url: Schema.optionalKey(TrimmedNonEmptyString),
  message: Schema.optionalKey(TrimmedNonEmptyString),
  prompt: Schema.optionalKey(TrimmedNonEmptyString),
  maskedAccount: Schema.optionalKey(TrimmedNonEmptyString),
  /** Epoch-millisecond deadline after which clients must dismiss/cancel this flow. */
  expiresAt: Schema.optionalKey(Schema.Number),
  /** Terminal result. Present when `kind` is `complete`. */
  outcome: Schema.optionalKey(Schema.Literals(["success", "failure"])),
});
export type OmpLoginChallenge = typeof OmpLoginChallenge.Type;
