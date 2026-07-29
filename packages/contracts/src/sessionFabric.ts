import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ClientOrchestrationCommand,
  OrchestrationEvent,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
} from "./orchestration.ts";

export const SESSION_FABRIC_PROTOCOL_VERSION = 1 as const;
export const SESSION_FABRIC_CAPABILITY_VERSION = 1 as const;
export const SESSION_FABRIC_CAPABILITY_TYP = "ashler-session-fabric-capability+jwt" as const;
export const SESSION_FABRIC_WS_PROTOCOL = "t3.session-fabric.v1" as const;
export const SESSION_FABRIC_WS_CAPABILITY_PREFIX = "t3.session-fabric.capability." as const;

const makeId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

/**
 * Stable identity for a session across runner restarts and local-to-Scaffold
 * handoffs. Environment and thread ids identify the current execution
 * location; this id identifies the durable conversation.
 */
export const SessionFabricSessionId = makeId("SessionFabricSessionId");
export type SessionFabricSessionId = typeof SessionFabricSessionId.Type;

export const SessionFabricRunnerId = makeId("SessionFabricRunnerId");
export type SessionFabricRunnerId = typeof SessionFabricRunnerId.Type;

export const SessionFabricClientId = makeId("SessionFabricClientId");
export type SessionFabricClientId = typeof SessionFabricClientId.Type;

export const SessionFabricEnvironmentKind = Schema.Literals(["local", "scaffold"]);
export type SessionFabricEnvironmentKind = typeof SessionFabricEnvironmentKind.Type;

export const SessionFabricPublication = Schema.Literals(["public", "local_only"]);
export type SessionFabricPublication = typeof SessionFabricPublication.Type;

export const SessionFabricRunnerState = Schema.Literals([
  "connecting",
  "online",
  "offline",
  "paused",
  "failed",
  "deleted",
]);
export type SessionFabricRunnerState = typeof SessionFabricRunnerState.Type;

export const SessionFabricCursor = Schema.Struct({
  eventSequence: NonNegativeInt,
  snapshotSequence: NonNegativeInt,
});
export type SessionFabricCursor = typeof SessionFabricCursor.Type;

export const SessionFabricExecutionLocation = Schema.Struct({
  environmentKind: SessionFabricEnvironmentKind,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  repositoryRoot: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  scaffoldSessionId: Schema.NullOr(TrimmedNonEmptyString),
  scaffoldSessionUrl: Schema.NullOr(TrimmedNonEmptyString),
  scaffoldLifecycleEpoch: Schema.optional(Schema.NullOr(NonNegativeInt)),
});
export type SessionFabricExecutionLocation = typeof SessionFabricExecutionLocation.Type;

export const SessionFabricCapabilityScope = Schema.Literals([
  "directory:read",
  "session:read",
  "session:command",
  "session:publish",
  "session:execute",
]);
export type SessionFabricCapabilityScope = typeof SessionFabricCapabilityScope.Type;

export const SessionFabricCapabilityRole = Schema.Literals([
  "viewer",
  "controller",
  "runner",
  "tombstone",
]);
export type SessionFabricCapabilityRole = typeof SessionFabricCapabilityRole.Type;

const SessionFabricCapabilityBaseClaims = {
  v: Schema.Literal(SESSION_FABRIC_CAPABILITY_VERSION),
  iss: TrimmedNonEmptyString,
  aud: TrimmedNonEmptyString,
  sub: TrimmedNonEmptyString,
  jti: TrimmedNonEmptyString,
  iat: NonNegativeInt,
  nbf: NonNegativeInt,
  exp: NonNegativeInt,
} as const;

export const SessionFabricViewerCapabilityClaims = Schema.Struct({
  ...SessionFabricCapabilityBaseClaims,
  role: Schema.Literal("viewer"),
  actorId: TrimmedNonEmptyString,
  scopes: Schema.Tuple([Schema.Literal("directory:read"), Schema.Literal("session:read")]),
});
export type SessionFabricViewerCapabilityClaims = typeof SessionFabricViewerCapabilityClaims.Type;

const SessionFabricLocalControllerAuthorityBindingFields = {
  fabricSessionId: SessionFabricSessionId,
  environmentKind: Schema.Literal("local"),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  actorId: TrimmedNonEmptyString,
} as const;

export const SessionFabricLocalControllerAuthorityBinding = Schema.Struct(
  SessionFabricLocalControllerAuthorityBindingFields,
).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SessionFabricLocalControllerAuthorityBinding =
  typeof SessionFabricLocalControllerAuthorityBinding.Type;

export const SessionFabricLocalAuthorityBinding = Schema.Struct({
  ...SessionFabricLocalControllerAuthorityBindingFields,
  runnerId: SessionFabricRunnerId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SessionFabricLocalAuthorityBinding = typeof SessionFabricLocalAuthorityBinding.Type;

export const SessionFabricScaffoldControllerCapabilityClaims = Schema.Struct({
  ...SessionFabricCapabilityBaseClaims,
  role: Schema.Literal("controller"),
  actorId: TrimmedNonEmptyString,
  scopes: Schema.Tuple([Schema.Literal("session:read"), Schema.Literal("session:command")]),
  fabricSessionId: SessionFabricSessionId,
  scaffoldSessionId: TrimmedNonEmptyString,
  scaffoldLifecycleEpoch: NonNegativeInt,
});
export type SessionFabricScaffoldControllerCapabilityClaims =
  typeof SessionFabricScaffoldControllerCapabilityClaims.Type;

export const SessionFabricLocalControllerCapabilityClaims = Schema.Struct({
  ...SessionFabricCapabilityBaseClaims,
  role: Schema.Literal("controller"),
  scopes: Schema.Tuple([Schema.Literal("session:read"), Schema.Literal("session:command")]),
  ...SessionFabricLocalControllerAuthorityBindingFields,
});
export type SessionFabricLocalControllerCapabilityClaims =
  typeof SessionFabricLocalControllerCapabilityClaims.Type;

export const SessionFabricControllerCapabilityClaims = Schema.Union([
  SessionFabricScaffoldControllerCapabilityClaims,
  SessionFabricLocalControllerCapabilityClaims,
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SessionFabricControllerCapabilityClaims =
  typeof SessionFabricControllerCapabilityClaims.Type;

export const SessionFabricScaffoldRunnerCapabilityClaims = Schema.Struct({
  ...SessionFabricCapabilityBaseClaims,
  role: Schema.Literal("runner"),
  runnerId: Schema.optional(TrimmedNonEmptyString),
  scopes: Schema.Tuple([Schema.Literal("session:publish"), Schema.Literal("session:execute")]),
  scaffoldSessionId: TrimmedNonEmptyString,
  scaffoldLifecycleEpoch: NonNegativeInt,
});
export type SessionFabricScaffoldRunnerCapabilityClaims =
  typeof SessionFabricScaffoldRunnerCapabilityClaims.Type;

export const SessionFabricLocalRunnerCapabilityClaims = Schema.Struct({
  ...SessionFabricCapabilityBaseClaims,
  role: Schema.Literal("runner"),
  scopes: Schema.Tuple([Schema.Literal("session:publish"), Schema.Literal("session:execute")]),
  ...SessionFabricLocalControllerAuthorityBindingFields,
  runnerId: SessionFabricRunnerId,
});
export type SessionFabricLocalRunnerCapabilityClaims =
  typeof SessionFabricLocalRunnerCapabilityClaims.Type;

export const SessionFabricRunnerCapabilityClaims = Schema.Union([
  SessionFabricScaffoldRunnerCapabilityClaims,
  SessionFabricLocalRunnerCapabilityClaims,
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SessionFabricRunnerCapabilityClaims = typeof SessionFabricRunnerCapabilityClaims.Type;

export const SessionFabricTombstoneCapabilityClaims = Schema.Struct({
  ...SessionFabricCapabilityBaseClaims,
  role: Schema.Literal("tombstone"),
  scopes: Schema.Tuple([]),
  scaffoldSessionId: TrimmedNonEmptyString,
  scaffoldLifecycleEpoch: NonNegativeInt,
});
export type SessionFabricTombstoneCapabilityClaims =
  typeof SessionFabricTombstoneCapabilityClaims.Type;

export const SessionFabricCapabilityClaims = Schema.Union([
  SessionFabricViewerCapabilityClaims,
  SessionFabricControllerCapabilityClaims,
  SessionFabricRunnerCapabilityClaims,
  SessionFabricTombstoneCapabilityClaims,
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SessionFabricCapabilityClaims = typeof SessionFabricCapabilityClaims.Type;

const SessionFabricScaffoldCapabilityGrantBindings = Schema.Struct({
  fabricSessionId: Schema.optional(SessionFabricSessionId),
  scaffoldSessionId: Schema.optional(TrimmedNonEmptyString),
  scaffoldLifecycleEpoch: Schema.optional(NonNegativeInt),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export const SessionFabricCapabilityGrant = Schema.Struct({
  capability: TrimmedNonEmptyString,
  tokenType: Schema.Literal("Bearer"),
  role: SessionFabricCapabilityRole,
  scopes: Schema.Array(SessionFabricCapabilityScope),
  expiresAt: IsoDateTime,
  issuer: TrimmedNonEmptyString,
  audience: TrimmedNonEmptyString,
  keyId: TrimmedNonEmptyString,
  bindings: Schema.Union([
    SessionFabricScaffoldCapabilityGrantBindings,
    SessionFabricLocalControllerAuthorityBinding,
    SessionFabricLocalAuthorityBinding,
  ]).annotate({ parseOptions: { onExcessProperty: "error" } }),
});
export type SessionFabricCapabilityGrant = typeof SessionFabricCapabilityGrant.Type;

export const SessionFabricSessionRecord = Schema.Struct({
  sessionId: SessionFabricSessionId,
  title: TrimmedNonEmptyString,
  publication: SessionFabricPublication,
  runnerState: SessionFabricRunnerState,
  location: SessionFabricExecutionLocation,
  initialPrompt: Schema.NullOr(Schema.String),
  searchableText: Schema.String,
  summary: Schema.NullOr(Schema.String),
  cursor: SessionFabricCursor,
  lastEventAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SessionFabricSessionRecord = typeof SessionFabricSessionRecord.Type;

export const SessionFabricSnapshot = Schema.Struct({
  session: SessionFabricSessionRecord,
  shell: OrchestrationShellSnapshot,
  thread: OrchestrationThreadDetailSnapshot,
  compactedThroughEventSequence: NonNegativeInt,
});
export type SessionFabricSnapshot = typeof SessionFabricSnapshot.Type;

/**
 * A committed orchestration event published by the runner. Provider events
 * are deliberately excluded: the fabric mirrors product state only after the
 * local orchestration transaction has committed.
 */
export const SessionFabricPublishedEvent = Schema.Struct({
  sessionId: SessionFabricSessionId,
  runnerId: SessionFabricRunnerId,
  runnerGeneration: NonNegativeInt,
  event: OrchestrationEvent,
});
export type SessionFabricPublishedEvent = typeof SessionFabricPublishedEvent.Type;

export const SessionFabricPublishedSnapshot = Schema.Struct({
  sessionId: SessionFabricSessionId,
  runnerId: SessionFabricRunnerId,
  runnerGeneration: NonNegativeInt,
  snapshot: SessionFabricSnapshot,
});
export type SessionFabricPublishedSnapshot = typeof SessionFabricPublishedSnapshot.Type;

/**
 * Heavy session context is published separately from the live snapshot so
 * transcript clients do not repeatedly download a potentially large patch.
 * `continuationRef` is an opaque fabric-owned reference; clients resume the
 * session through the fabric instead of learning provider-native credentials
 * or resume cursors.
 */
export const SessionFabricContextPublication = Schema.Struct({
  sessionId: SessionFabricSessionId,
  runnerId: SessionFabricRunnerId,
  runnerGeneration: NonNegativeInt,
  codeDiff: Schema.NullOr(Schema.String),
  continuationRef: Schema.NullOr(TrimmedNonEmptyString),
  publishedAt: IsoDateTime,
});
export type SessionFabricContextPublication = typeof SessionFabricContextPublication.Type;

export const SessionFabricRunnerHello = Schema.Struct({
  protocolVersion: Schema.Literal(SESSION_FABRIC_PROTOCOL_VERSION),
  sessionId: SessionFabricSessionId,
  runnerId: SessionFabricRunnerId,
  runnerGeneration: NonNegativeInt,
  location: SessionFabricExecutionLocation,
  publication: SessionFabricPublication,
  lastCommittedEventSequence: NonNegativeInt,
  connectedAt: IsoDateTime,
});
export type SessionFabricRunnerHello = typeof SessionFabricRunnerHello.Type;

export const SessionFabricClientHello = Schema.Struct({
  protocolVersion: Schema.Literal(SESSION_FABRIC_PROTOCOL_VERSION),
  sessionId: SessionFabricSessionId,
  clientId: SessionFabricClientId,
  afterEventSequence: NonNegativeInt,
  connectedAt: IsoDateTime,
});
export type SessionFabricClientHello = typeof SessionFabricClientHello.Type;

export const SessionFabricCommand = Schema.Struct({
  sessionId: SessionFabricSessionId,
  commandId: CommandId,
  clientId: SessionFabricClientId,
  command: ClientOrchestrationCommand,
  submittedAt: IsoDateTime,
});
export type SessionFabricCommand = typeof SessionFabricCommand.Type;

const SessionFabricPendingCommandReceipt = Schema.Struct({
  sessionId: SessionFabricSessionId,
  commandId: CommandId,
  status: Schema.Literals(["queued", "delivered", "rejected"]),
  resultSequence: Schema.Null,
  detail: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});

const SessionFabricAcceptedCommandReceipt = Schema.Struct({
  sessionId: SessionFabricSessionId,
  commandId: CommandId,
  status: Schema.Literal("accepted"),
  /** The original orchestration result sequence, preserved for duplicate command ids. */
  resultSequence: NonNegativeInt,
  detail: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});

export const SessionFabricCommandReceipt = Schema.Union([
  SessionFabricPendingCommandReceipt,
  SessionFabricAcceptedCommandReceipt,
]);
export type SessionFabricCommandReceipt = typeof SessionFabricCommandReceipt.Type;

export const SessionFabricEventPointer = Schema.Struct({
  sessionId: SessionFabricSessionId,
  eventId: EventId,
  sequence: NonNegativeInt,
});
export type SessionFabricEventPointer = typeof SessionFabricEventPointer.Type;

export const SessionFabricServerFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("session.snapshot"),
    snapshot: SessionFabricSnapshot,
  }),
  Schema.Struct({
    type: Schema.Literal("session.event"),
    sequence: NonNegativeInt,
    published: SessionFabricPublishedEvent,
  }),
  Schema.Struct({
    type: Schema.Literal("session.event-receipt"),
    pointer: SessionFabricEventPointer,
  }),
  Schema.Struct({
    type: Schema.Literal("session.synchronized"),
    cursor: SessionFabricCursor,
  }),
  Schema.Struct({
    type: Schema.Literal("command.dispatch"),
    command: SessionFabricCommand,
  }),
  Schema.Struct({
    type: Schema.Literal("command.receipt"),
    receipt: SessionFabricCommandReceipt,
  }),
  Schema.Struct({
    type: Schema.Literal("runner.state"),
    state: SessionFabricRunnerState,
    updatedAt: IsoDateTime,
  }),
]);
export type SessionFabricServerFrame = typeof SessionFabricServerFrame.Type;

export const SessionFabricClientFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("client.hello"),
    hello: SessionFabricClientHello,
  }),
  Schema.Struct({
    type: Schema.Literal("runner.hello"),
    hello: SessionFabricRunnerHello,
  }),
  Schema.Struct({
    type: Schema.Literal("session.publish-event"),
    published: SessionFabricPublishedEvent,
  }),
  Schema.Struct({
    type: Schema.Literal("session.publish-snapshot"),
    published: SessionFabricPublishedSnapshot,
  }),
  Schema.Struct({
    type: Schema.Literal("session.publish-context"),
    published: SessionFabricContextPublication,
  }),
  Schema.Struct({
    type: Schema.Literal("command.submit"),
    command: SessionFabricCommand,
  }),
  Schema.Struct({
    type: Schema.Literal("command.receipt"),
    receipt: SessionFabricCommandReceipt,
  }),
]);
export type SessionFabricClientFrame = typeof SessionFabricClientFrame.Type;

export const SessionFabricSearchRequest = Schema.Struct({
  query: TrimmedNonEmptyString,
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)),
});
export type SessionFabricSearchRequest = typeof SessionFabricSearchRequest.Type;

export const SessionFabricSearchResult = Schema.Struct({
  session: SessionFabricSessionRecord,
  score: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  matchText: Schema.String,
});
export type SessionFabricSearchResult = typeof SessionFabricSearchResult.Type;

export const SessionFabricSearchResponse = Schema.Struct({
  results: Schema.Array(SessionFabricSearchResult),
});
export type SessionFabricSearchResponse = typeof SessionFabricSearchResponse.Type;

export const SessionFabricDirectoryResponse = Schema.Struct({
  sessions: Schema.Array(SessionFabricSessionRecord),
});
export type SessionFabricDirectoryResponse = typeof SessionFabricDirectoryResponse.Type;

export const SessionFabricContextRequest = Schema.Struct({
  sessionId: SessionFabricSessionId,
  includeCodeDiff: Schema.Boolean,
  includeContinuation: Schema.Boolean,
});
export type SessionFabricContextRequest = typeof SessionFabricContextRequest.Type;

export const SessionFabricContextBundle = Schema.Struct({
  session: SessionFabricSessionRecord,
  snapshot: SessionFabricSnapshot,
  codeDiff: Schema.NullOr(Schema.String),
  continuationRef: Schema.NullOr(TrimmedNonEmptyString),
  generatedAt: IsoDateTime,
});
export type SessionFabricContextBundle = typeof SessionFabricContextBundle.Type;

export const SessionFabricEventBatch = Schema.Struct({
  sessionId: SessionFabricSessionId,
  afterEventSequence: NonNegativeInt,
  events: Schema.Array(
    Schema.Struct({
      sequence: NonNegativeInt,
      published: SessionFabricPublishedEvent,
    }),
  ),
  nextEventSequence: NonNegativeInt,
});
export type SessionFabricEventBatch = typeof SessionFabricEventBatch.Type;
