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
});
export type SessionFabricExecutionLocation = typeof SessionFabricExecutionLocation.Type;

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
