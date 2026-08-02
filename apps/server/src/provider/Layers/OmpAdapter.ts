import {
  ApprovalRequestId,
  type OmpSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ServerProviderModel,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { resolveAshlerOmpAdvisor } from "../../ashler/OmpModelPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { makeOmpMetricRecorder } from "../../observability/OmpMetrics.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  extractAcpSubagentSnapshots,
  makeAcpSubagentTaskEvent,
  makeAcpThreadMetadataUpdatedEvent,
  makeAcpTokenUsageUpdatedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  parsePermissionRequest,
  parseSessionUpdateEvent,
  type AcpParsedSessionEvent,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyOmpAcpSelection,
  applyOmpAdvisorSelection,
  assertManagedScaffoldOmpModelAllowed,
  currentOmpAdvisorIdFromSessionSetup,
  currentOmpModelIdFromSessionSetup,
  currentOmpThinkingIdFromSessionSetup,
  makeOmpAcpRuntime,
  ompElicitationContentFromAnswers,
  ompModelSlugsFromSessionSetup,
  ompQuestionsFromElicitation,
  expandOmpSkillReferences,
  filterManagedScaffoldOmpModelSlugs,
  resolveOmpThinkingSelection,
} from "../acp/OmpAcpSupport.ts";
import { type OmpAdapterShape } from "../Services/OmpAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

const PROVIDER = ProviderDriverKind.make("omp");
const OMP_RESUME_VERSION = 3 as const;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function unavailableOmpModelIssue(modelId: string): string {
  const provider = modelId.split("/", 1)[0]?.trim().toLowerCase();
  const reconnect =
    provider === "anthropic"
      ? "Reconnect Claude"
      : provider === "openai-codex" || provider === "openai"
        ? "Reconnect ChatGPT"
        : "Reconnect the model provider";
  return `Selected model "${modelId}" is unavailable in the live OMP session. ${reconnect} or switch models.`;
}

export interface OmpAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

interface OmpSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; late prompt RPCs must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  currentModelId: string | undefined;
  currentThinkingId: string | undefined;
  currentAdvisorId: string | undefined;
  readonly subagentTaskStates: Map<string, string>;
  readonly availableModelSlugs: ReadonlyArray<string>;
  acpSequence: number;
  stopped: boolean;
}

function advisorConfigForPrimary(
  primaryModelSlug: string | undefined,
  availableModelSlugs: ReadonlyArray<string>,
): string {
  if (!primaryModelSlug) return "off";
  const availableModels: ReadonlyArray<ServerProviderModel> = availableModelSlugs.map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  }));
  const advisor = resolveAshlerOmpAdvisor({ primaryModelSlug, availableModels });
  return advisor ? `${advisor.modelSlug}:${advisor.effort}` : "off";
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsCancelled(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
    { discard: true },
  );
}

function appendPromptResultToTurn(
  ctx: OmpSessionContext,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId);
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId
          ? { ...turn, items: [...turn.items, { prompt: promptParts, result }] }
          : turn,
      )
    : [...ctx.turns, { id: turnId, items: [{ prompt: promptParts, result }] }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildOmpSteerRequest(sessionId: string, text: string) {
  return { method: "_omp/session/steer" as const, payload: { sessionId, text } };
}

export function parseOmpSteerResult(value: unknown):
  | { readonly accepted: true; readonly state: "streaming" }
  | {
      readonly accepted: false;
      readonly state: "idle";
    }
  | undefined {
  if (!isRecord(value)) return undefined;
  if (value.accepted === true && value.state === "streaming") {
    return { accepted: true, state: "streaming" };
  }
  if (value.accepted === false && value.state === "idle") {
    return { accepted: false, state: "idle" };
  }
  return undefined;
}

const resolveNotificationTurnId = (ctx: OmpSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveCallbackTurnId = (ctx: OmpSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, OmpSessionContext>,
  threadId: ThreadId,
): TurnId | undefined => {
  const ctx = sessions.get(threadId);
  return ctx ? resolveCallbackTurnId(ctx) : undefined;
};

export function parseOmpResume(raw: unknown):
  | {
      sessionId: string;
      eventSequence: number;
      acpSequence: number;
      activeTurnId?: TurnId;
    }
  | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2 && raw.schemaVersion !== 3)
    return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  const eventSequence =
    (raw.schemaVersion === 2 || raw.schemaVersion === 3) &&
    typeof raw.eventSequence === "number" &&
    Number.isSafeInteger(raw.eventSequence) &&
    raw.eventSequence >= 0
      ? raw.eventSequence
      : 0;
  const acpSequence =
    raw.schemaVersion === 3 &&
    typeof raw.acpSequence === "number" &&
    Number.isSafeInteger(raw.acpSequence) &&
    raw.acpSequence >= 0
      ? raw.acpSequence
      : 0;
  const activeTurnId =
    raw.schemaVersion === 3 && typeof raw.activeTurnId === "string" && raw.activeTurnId.trim()
      ? TurnId.make(raw.activeTurnId.trim())
      : undefined;
  return {
    sessionId: raw.sessionId.trim(),
    eventSequence,
    acpSequence,
    ...(activeTurnId ? { activeTurnId } : {}),
  };
}

export function makeOmpEventId(sessionId: string, eventSequence: number): EventId {
  return EventId.make(`omp:${encodeURIComponent(sessionId)}:${eventSequence}`);
}

export function makeOmpSourceEventId(
  sessionId: string,
  sourceSequence: number,
  discriminator: string,
): EventId {
  return EventId.make(
    `omp:${encodeURIComponent(sessionId)}:acp:${sourceSequence}:${encodeURIComponent(discriminator)}`,
  );
}

export function advanceOmpEventCursor(input: {
  readonly currentSequence: number;
  readonly sourceSequence?: number;
}): { readonly sequence: number; readonly duplicate: boolean } {
  if (
    input.sourceSequence !== undefined &&
    Number.isSafeInteger(input.sourceSequence) &&
    input.sourceSequence >= 0
  ) {
    if (input.sourceSequence > input.currentSequence + 1) {
      throw new Error(
        `OMP source sequence gap: expected ${input.currentSequence + 1}, received ${input.sourceSequence}.`,
      );
    }
    return {
      sequence: input.sourceSequence,
      duplicate: input.sourceSequence <= input.currentSequence,
    };
  }
  return { sequence: input.currentSequence + 1, duplicate: false };
}

export function reserveOmpEventCursor(input: {
  readonly currentSequence: number;
  readonly sessionId: string;
  readonly offeredEventIds: ReadonlySet<EventId>;
  readonly source?: { readonly sequence: number; readonly discriminator: string };
}): { readonly sequence: number; readonly eventId: EventId; readonly duplicate: boolean } {
  const sourceEventId = input.source
    ? makeOmpSourceEventId(input.sessionId, input.source.sequence, input.source.discriminator)
    : undefined;
  if (sourceEventId !== undefined && input.offeredEventIds.has(sourceEventId)) {
    return {
      sequence: input.currentSequence,
      eventId: sourceEventId,
      duplicate: true,
    };
  }
  const next = advanceOmpEventCursor({ currentSequence: input.currentSequence });
  return {
    sequence: next.sequence,
    eventId: sourceEventId ?? makeOmpEventId(input.sessionId, next.sequence),
    duplicate: false,
  };
}

export function resumedOmpCursorForSession(
  sessionId: string,
  resume: ReturnType<typeof parseOmpResume>,
): ReturnType<typeof parseOmpResume> {
  return resume?.sessionId === sessionId ? resume : undefined;
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

function completedStopReasonFromPromptResponse(
  response: EffectAcpSchema.PromptResponse | undefined,
): EffectAcpSchema.StopReason | null {
  return response?.stopReason ?? null;
}

export function ompPromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string;
  readonly expectedAcpSessionId: string;
  readonly liveActiveTurnId: TurnId | undefined;
  readonly liveSessionActiveTurnId: TurnId | undefined;
  readonly turnId: TurnId;
}): boolean {
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    (input.liveActiveTurnId === input.turnId || input.liveSessionActiveTurnId === input.turnId)
  );
}

export function makeOmpAdapter(ompSettings: OmpSettings, options?: OmpAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("omp");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, OmpSessionContext>();
    const eventSequences = new Map<ThreadId, { sessionId: string; sequence: number }>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const offeredEventIds = new Set<EventId>();
    const metrics = yield* makeOmpMetricRecorder;

    const validateManagedModelSelection = (
      operation: string,
      model: string | undefined,
    ): Effect.Effect<void, ProviderAdapterValidationError> =>
      Effect.try({
        try: () => assertManagedScaffoldOmpModelAllowed(options?.environment ?? process.env, model),
        catch: (cause) =>
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation,
            issue: cause instanceof Error ? cause.message : String(cause),
          }),
      });

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OMP runtime identifier.",
            cause,
          }),
      ),
    );
    const makeEventStamp = (
      threadId: ThreadId,
      source?: { readonly sequence: number; readonly discriminator: string },
    ) =>
      Effect.gen(function* () {
        const current = eventSequences.get(threadId) ?? {
          sessionId: `thread-${threadId}`,
          sequence: 0,
        };
        const reserved = reserveOmpEventCursor({
          currentSequence: current.sequence,
          sessionId: current.sessionId,
          offeredEventIds,
          ...(source ? { source } : {}),
        });
        const sequence = reserved.sequence;
        if (!reserved.duplicate) {
          eventSequences.set(threadId, {
            ...current,
            sequence: Math.max(current.sequence, sequence),
          });
        }
        const ctx = sessions.get(threadId);
        if (ctx && !reserved.duplicate) {
          if (source) {
            ctx.acpSequence = Math.max(ctx.acpSequence, source.sequence);
          }
          ctx.session = {
            ...ctx.session,
            resumeCursor: {
              schemaVersion: OMP_RESUME_VERSION,
              sessionId: ctx.acpSessionId,
              eventSequence: sequence,
              acpSequence: ctx.acpSequence,
              ...(ctx.activeTurnId ? { activeTurnId: ctx.activeTurnId } : {}),
            },
          };
        }
        return {
          eventId: reserved.eventId,
          createdAt: yield* nowIso,
        };
      });
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process OMP ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Effect.suspend(() => {
        if (offeredEventIds.has(event.eventId)) return Effect.void;
        offeredEventIds.add(event.eventId);
        const ctx = sessions.get(event.threadId);
        const enriched =
          ctx?.session.resumeCursor !== undefined
            ? { ...event, resumeCursor: ctx.session.resumeCursor }
            : event;
        const observe =
          event.type === "turn.started" && event.turnId !== undefined
            ? metrics.recordTurnStarted(event.turnId)
            : event.type === "content.delta" && event.turnId !== undefined
              ? metrics.recordFirstOutput(
                  event.turnId,
                  event.payload.streamKind === "reasoning_text" ? "reasoning" : "text",
                )
              : (event.type === "turn.completed" || event.type === "turn.aborted") &&
                  event.turnId !== undefined
                ? metrics.recordTurnFinished(event.turnId)
                : Effect.void;
        return PubSub.publish(runtimeEventPubSub, enriched).pipe(
          Effect.andThen(observe),
          Effect.asVoid,
        );
      });

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const settlePromptInFlight = (
      threadId: ThreadId,
      turnId: TurnId,
      expectedAcpSessionId: string,
      options?: {
        readonly errorMessage?: string;
        readonly completedStopReason?: EffectAcpSchema.StopReason | null;
        readonly emitTurnCompletion?: boolean;
        /** Interrupt/cancel: drop every outstanding prompt slot and settle once. */
        readonly settleAllPrompts?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const liveCtx = sessions.get(threadId);
        if (!liveCtx) {
          return;
        }
        const settlementBelongsToLiveContext = ompPromptSettlementBelongsToContext({
          liveAcpSessionId: liveCtx.acpSessionId,
          expectedAcpSessionId,
          liveActiveTurnId: liveCtx.activeTurnId,
          liveSessionActiveTurnId: liveCtx.session.activeTurnId,
          turnId,
        });
        if (!settlementBelongsToLiveContext) {
          // interruptTurn already consumed every prompt slot for this turn. A
          // late prompt result must neither emit a second terminal event nor
          // consume a slot belonging to a newer turn on the same ACP session.
          if (
            liveCtx.acpSessionId !== expectedAcpSessionId ||
            liveCtx.interruptedTurnIds.has(turnId)
          ) {
            return;
          }
          if (options?.emitTurnCompletion !== false) {
            if (options?.errorMessage !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp(threadId)),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: options.errorMessage,
                },
              });
            } else if (options?.completedStopReason !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp(threadId)),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: options.completedStopReason ?? null,
                },
              });
            }
          }
          return;
        }
        let settleTurnId = turnId;
        if (options?.settleAllPrompts) {
          liveCtx.promptsInFlight = 0;
          if (liveCtx.activeTurnId !== turnId && liveCtx.session.activeTurnId !== turnId) {
            const fallbackTurnId = liveCtx.activeTurnId ?? liveCtx.session.activeTurnId;
            if (!fallbackTurnId) {
              if (liveCtx.session.status === "running" || liveCtx.session.status === "connecting") {
                const updatedAt = yield* nowIso;
                const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
                liveCtx.activeTurnId = undefined;
                liveCtx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt,
                };
              }
              return;
            }
            settleTurnId = fallbackTurnId;
          }
        } else {
          const remainingPrompts = Math.max(0, liveCtx.promptsInFlight - 1);
          if (
            remainingPrompts > 0 ||
            liveCtx.activeTurnId !== settleTurnId ||
            liveCtx.session.activeTurnId !== settleTurnId
          ) {
            liveCtx.promptsInFlight = remainingPrompts;
            return;
          }
          liveCtx.promptsInFlight = remainingPrompts;
        }
        const updatedAt = yield* nowIso;
        const canEmitTurnCompletion =
          liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
        const shouldEmitFailedTurn = options?.errorMessage !== undefined && canEmitTurnCompletion;
        const shouldEmitCompletedTurn =
          options?.completedStopReason !== undefined && canEmitTurnCompletion;
        const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
        liveCtx.activeTurnId = undefined;
        liveCtx.session = {
          ...readySession,
          status: "ready",
          updatedAt,
        };
        if (options?.emitTurnCompletion === false) {
          return;
        }
        if (shouldEmitFailedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp(threadId)),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: "failed",
              errorMessage: options.errorMessage,
            },
          });
        } else if (shouldEmitCompletedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp(threadId)),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: options.completedStopReason ?? null,
            },
          });
        }
      });

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native OMP notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: OmpSessionContext,
      turnId: TurnId | undefined,
      stamp: { readonly eventId: EventId; readonly createdAt: string },
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const processAcpEvent = (ctx: OmpSessionContext, event: AcpParsedSessionEvent) =>
      Effect.gen(function* () {
        if (
          event._tag === "PlanUpdated" ||
          event._tag === "ToolCallUpdated" ||
          event._tag === "ContentDelta" ||
          event._tag === "TokenUsageUpdated"
        ) {
          yield* logNative(ctx.threadId, "session/update", event.rawPayload);
        }
        if (event._tag === "ModeChanged") return;

        const sourceStamp = (discriminator: string) =>
          makeEventStamp(
            ctx.threadId,
            event.sourceSequence === undefined
              ? undefined
              : { sequence: event.sourceSequence, discriminator },
          );

        if (event._tag === "ConfigOptionsUpdated") {
          const previousModelId = ctx.currentModelId;
          const previousThinkingId = ctx.currentThinkingId;
          const nextModelId = currentOmpModelIdFromSessionSetup(event) ?? previousModelId;
          const nextThinkingId = currentOmpThinkingIdFromSessionSetup(event) ?? previousThinkingId;
          ctx.currentModelId = nextModelId;
          ctx.currentThinkingId = nextThinkingId;
          ctx.currentAdvisorId = currentOmpAdvisorIdFromSessionSetup(event) ?? ctx.currentAdvisorId;
          if (nextModelId) {
            ctx.session = {
              ...ctx.session,
              model: nextModelId,
              updatedAt: yield* nowIso,
            };
          }
          if (
            previousModelId &&
            nextModelId &&
            (previousModelId !== nextModelId || previousThinkingId !== nextThinkingId)
          ) {
            yield* offerRuntimeEvent({
              type: "model.rerouted",
              ...(yield* sourceStamp("model-selection")),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              payload: {
                fromModel: previousModelId,
                toModel: nextModelId,
                reason: "omp.config_option_update",
                ...(nextThinkingId ? { effort: nextThinkingId } : {}),
              },
            });
          }
          return;
        }

        if (event._tag === "TokenUsageUpdated") {
          yield* offerRuntimeEvent(
            makeAcpTokenUsageUpdatedEvent({
              stamp: yield* sourceStamp("usage"),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              usage: event.usage,
              rawPayload: event.rawPayload,
            }),
          );
          return;
        }
        if (event._tag === "SessionInfoUpdated") {
          if (event.title) {
            yield* offerRuntimeEvent(
              makeAcpThreadMetadataUpdatedEvent({
                stamp: yield* sourceStamp("session-info"),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                title: event.title,
                rawPayload: event.rawPayload,
              }),
            );
          }
          return;
        }

        const notificationTurnId = resolveNotificationTurnId(ctx);
        if (notificationTurnId === undefined || ctx.interruptedTurnIds.has(notificationTurnId)) {
          return;
        }
        switch (event._tag) {
          case "AssistantItemStarted":
          case "AssistantItemCompleted": {
            const lifecycle =
              event._tag === "AssistantItemStarted" ? "item.started" : "item.completed";
            yield* offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp: yield* sourceStamp(`${lifecycle}:${event.itemId}`),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: notificationTurnId,
                itemId: event.itemId,
                itemType: event.itemType,
                lifecycle,
              }),
            );
            return;
          }
          case "PlanUpdated":
            yield* emitPlanUpdate(
              ctx,
              notificationTurnId,
              yield* sourceStamp("plan"),
              event.payload,
              event.rawPayload,
              "session/update",
            );
            return;
          case "ToolCallUpdated": {
            yield* metrics.recordToolUpdate(event.toolCall.status);
            yield* offerRuntimeEvent(
              makeAcpToolCallEvent({
                stamp: yield* sourceStamp(`tool:${event.toolCall.toolCallId}`),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: notificationTurnId,
                toolCall: event.toolCall,
                rawPayload: event.rawPayload,
              }),
            );
            for (const snapshot of extractAcpSubagentSnapshots(event.toolCall)) {
              const prior = ctx.subagentTaskStates.get(snapshot.taskId);
              const fingerprint = `${snapshot.status}:${encodeJsonStringForDiagnostics(snapshot) ?? snapshot.taskId}`;
              if (!prior) {
                yield* metrics.recordSubagentEvent("started");
                yield* offerRuntimeEvent(
                  makeAcpSubagentTaskEvent({
                    stamp: yield* sourceStamp(`task-started:${snapshot.taskId}`),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    snapshot,
                    lifecycle: "started",
                    rawPayload: event.rawPayload,
                  }),
                );
              }
              if (snapshot.status === "pending" || snapshot.status === "running") {
                if (prior !== fingerprint) {
                  yield* metrics.recordSubagentEvent("progress");
                  yield* offerRuntimeEvent(
                    makeAcpSubagentTaskEvent({
                      stamp: yield* sourceStamp(`task-progress:${snapshot.taskId}`),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: notificationTurnId,
                      snapshot,
                      lifecycle: "progress",
                      rawPayload: event.rawPayload,
                    }),
                  );
                }
                ctx.subagentTaskStates.set(snapshot.taskId, fingerprint);
              } else if (prior !== fingerprint) {
                yield* metrics.recordSubagentEvent("completed");
                yield* offerRuntimeEvent(
                  makeAcpSubagentTaskEvent({
                    stamp: yield* sourceStamp(`task-completed:${snapshot.taskId}`),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    snapshot,
                    lifecycle: "completed",
                    rawPayload: event.rawPayload,
                  }),
                );
                ctx.subagentTaskStates.set(snapshot.taskId, fingerprint);
              }
            }
            return;
          }
          case "ContentDelta":
            yield* offerRuntimeEvent(
              makeAcpContentDeltaEvent({
                stamp: yield* sourceStamp(`content:${event.itemId ?? event.streamKind}`),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: notificationTurnId,
                ...(event.itemId ? { itemId: event.itemId } : {}),
                streamKind: event.streamKind,
                text: event.text,
                rawPayload: event.rawPayload,
              }),
            );
            return;
        }
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<OmpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (
      ctx: OmpSessionContext,
      exitKind: "graceful" | "error" = "graceful",
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp(ctx.threadId)),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind },
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              sessions.delete(ctx.threadId);
              eventSequences.delete(ctx.threadId);
            }),
          ),
        );
      });

    const startSession: OmpAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const ompModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resume = parseOmpResume(input.resumeCursor);
          const resumeSessionId = resume?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeOmpAcpRuntime({
            ompSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          const started = yield* Effect.gen(function* () {
            yield* acp.handleElicitation((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/elicitation", params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const resolution = yield* Deferred.make<PendingUserInputResolution>();
                  const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                  pendingUserInputs.set(requestId, { resolution });
                  yield* offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* makeEventStamp(input.threadId)),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    payload: { questions: ompQuestionsFromElicitation(params) },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "session/elicitation",
                      payload: params,
                    },
                  });
                  const resolved = yield* Deferred.await(resolution);
                  pendingUserInputs.delete(requestId);
                  const resolvedAnswers = resolved._tag === "answered" ? resolved.answers : {};
                  yield* offerRuntimeEvent({
                    type: "user-input.resolved",
                    ...(yield* makeEventStamp(input.threadId)),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    payload: { answers: resolvedAnswers },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "session/elicitation",
                      payload: params,
                    },
                  });
                  return resolved._tag === "answered"
                    ? {
                        action: {
                          action: "accept" as const,
                          content: ompElicitationContentFromAnswers(resolved.answers),
                        },
                      }
                    : { action: { action: "cancel" as const } };
                }),
              ),
            );
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  if (input.runtimeMode === "full-access") {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                  pendingApprovals.set(requestId, { decision });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(input.threadId),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(input.threadId),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId =
                    resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: "selected" as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const requestedStartModelId = ompModelSelection?.model?.trim() || undefined;
          const requestedStartThinkingId = resolveOmpThinkingSelection(ompModelSelection?.options);
          const currentStartModelId = currentOmpModelIdFromSessionSetup(started.sessionSetupResult);
          yield* validateManagedModelSelection(
            "startSession/model-policy",
            requestedStartModelId ?? currentStartModelId,
          );
          const availableModelSlugs = filterManagedScaffoldOmpModelSlugs(
            options?.environment ?? process.env,
            ompModelSlugsFromSessionSetup(started.sessionSetupResult),
          );
          if (
            requestedStartModelId !== undefined &&
            !availableModelSlugs.includes(requestedStartModelId)
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession/selected-provider-unavailable",
              issue: unavailableOmpModelIssue(requestedStartModelId),
            });
          }
          const boundModelId = yield* applyOmpAcpSelection({
            runtime: acp,
            currentModelId: currentStartModelId,
            requestedModelId: requestedStartModelId,
            thinking: requestedStartThinkingId,
            mapError: ({ cause, configId }) =>
              mapAcpToAdapterError(
                PROVIDER,
                input.threadId,
                `session/set_config_option/${configId}`,
                cause,
              ),
          });
          const boundAdvisorId = yield* applyOmpAdvisorSelection({
            runtime: acp,
            currentAdvisorId: currentOmpAdvisorIdFromSessionSetup(started.sessionSetupResult),
            requestedAdvisorId: advisorConfigForPrimary(boundModelId, availableModelSlugs),
            mapError: ({ cause, configId }) =>
              mapAcpToAdapterError(
                PROVIDER,
                input.threadId,
                `session/set_config_option/${configId}`,
                cause,
              ),
          });

          const resumedCursor = resumedOmpCursorForSession(started.sessionId, resume);
          eventSequences.set(input.threadId, {
            sessionId: started.sessionId,
            sequence: resumedCursor?.eventSequence ?? 0,
          });

          const now = yield* nowIso;
          const resumedActiveTurnId = resumedCursor?.activeTurnId;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: resumedActiveTurnId ? "running" : "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(boundModelId ? { model: boundModelId } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: OMP_RESUME_VERSION,
              sessionId: started.sessionId,
              eventSequence: resumedCursor?.eventSequence ?? 0,
              acpSequence: resumedCursor?.acpSequence ?? 0,
              ...(resumedActiveTurnId ? { activeTurnId: resumedActiveTurnId } : {}),
            },
            ...(resumedActiveTurnId ? { activeTurnId: resumedActiveTurnId } : {}),
            createdAt: now,
            updatedAt: now,
          };

          const ctx: OmpSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: resumedActiveTurnId,
            interruptedTurnIds: new Set(),
            promptsInFlight: 0,
            currentModelId: boundModelId,
            currentThinkingId:
              requestedStartThinkingId ??
              currentOmpThinkingIdFromSessionSetup(started.sessionSetupResult),
            currentAdvisorId: boundAdvisorId,
            subagentTaskStates: new Map(),
            availableModelSlugs,
            acpSequence: resumedCursor?.acpSequence ?? 0,
            stopped: false,
          };

          sessions.set(input.threadId, ctx);
          const replayNotifications = yield* acp.getReplayNotifications;
          for (const replay of replayNotifications) {
            if (replay.sourceSequence <= ctx.acpSequence) {
              yield* metrics.recordReplay("duplicate");
              continue;
            }
            if (replay.sourceSequence > ctx.acpSequence + 1) {
              yield* metrics.recordReplay("gap");
            }
            yield* metrics.recordReplay("replayed");
            const parsed = parseSessionUpdateEvent(replay.notification);
            for (const event of parsed.events) {
              yield* processAcpEvent(ctx, {
                ...event,
                sourceSequence: replay.sourceSequence,
              });
            }
            ctx.acpSequence = replay.sourceSequence;
          }

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                yield* processAcpEvent(ctx, event);
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process OMP runtime notification.", { cause }),
            ),
            Effect.forkChild,
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp(input.threadId)),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          // A restored active turn remains canonical execution authority until
          // its terminal event or an explicit interrupt clears it.
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp(input.threadId)),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {
              state: resumedActiveTurnId ? "running" : "ready",
              reason: resumedActiveTurnId
                ? "OMP ACP session resumed with an active turn"
                : "OMP ACP session ready",
            },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp(input.threadId)),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return ctx.session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: OmpAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        let prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            // An active turn is canonical even when its prompt RPC belonged to
            // a prior adapter process. Fold the new input into that turn via
            // steering instead of replacing its restored id with a new turn.
            const steeringTurnId = ctx.activeTurnId;
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
            // Count this prompt immediately so a superseded in-flight prompt
            // resolving from here on does not settle the turn; decremented on
            // preparation failure here, and after the prompt below otherwise.
            ctx.promptsInFlight += 1;
            // Bind the turn id before cooperative yields so interruptTurn can
            // settle this prompt even if stop arrives during preparation.
            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              status: steeringTurnId === undefined ? "connecting" : "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

            return yield* Effect.gen(function* () {
              const turnModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;
              const requestedTurnModelId = turnModelSelection?.model?.trim() || undefined;
              if (requestedTurnModelId !== undefined) {
                yield* validateManagedModelSelection("sendTurn/model-policy", requestedTurnModelId);
              }
              const requestedTurnThinkingId = resolveOmpThinkingSelection(
                turnModelSelection?.options,
              );
              const currentModelId = yield* applyOmpAcpSelection({
                runtime: ctx.acp,
                currentModelId: ctx.currentModelId,
                requestedModelId: requestedTurnModelId,
                thinking: requestedTurnThinkingId,
                mapError: ({ cause, configId }) =>
                  mapAcpToAdapterError(
                    PROVIDER,
                    input.threadId,
                    `session/set_config_option/${configId}`,
                    cause,
                  ),
              });
              const currentAdvisorId = yield* applyOmpAdvisorSelection({
                runtime: ctx.acp,
                currentAdvisorId: ctx.currentAdvisorId,
                requestedAdvisorId: advisorConfigForPrimary(
                  currentModelId,
                  ctx.availableModelSlugs,
                ),
                mapError: ({ cause, configId }) =>
                  mapAcpToAdapterError(
                    PROVIDER,
                    input.threadId,
                    `session/set_config_option/${configId}`,
                    cause,
                  ),
              });

              const text = input.input ? expandOmpSkillReferences(input.input).trim() : undefined;
              const attachmentPromptParts = yield* Effect.forEach(
                input.attachments ?? [],
                (attachment) =>
                  Effect.gen(function* () {
                    const attachmentPath = resolveAttachmentPath({
                      attachmentsDir: serverConfig.attachmentsDir,
                      attachment,
                    });
                    if (!attachmentPath) {
                      return yield* new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: `Invalid attachment id '${attachment.id}'.`,
                      });
                    }
                    if (attachment.type === "file") {
                      return {
                        type: "resource_link",
                        name: attachment.name,
                        mimeType: attachment.mimeType,
                        size: attachment.sizeBytes,
                        uri: NodeURL.pathToFileURL(attachmentPath).href,
                      } satisfies EffectAcpSchema.ContentBlock;
                    }
                    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapterRequestError({
                            provider: PROVIDER,
                            method: "session/prompt",
                            detail: cause.message,
                            cause,
                          }),
                      ),
                    );
                    return {
                      type: "image",
                      data: Buffer.from(bytes).toString("base64"),
                      mimeType: attachment.mimeType,
                    } satisfies EffectAcpSchema.ContentBlock;
                  }),
              );
              const promptParts: Array<EffectAcpSchema.ContentBlock> = [
                ...(text ? [{ type: "text" as const, text }] : []),
                ...attachmentPromptParts,
              ];

              if (promptParts.length === 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text or attachments.",
                });
              }

              ctx.currentModelId = currentModelId;
              ctx.currentThinkingId = requestedTurnThinkingId ?? ctx.currentThinkingId;
              ctx.currentAdvisorId = currentAdvisorId;
              const displayModel = currentModelId;
              const displayEffort = ctx.currentThinkingId;
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              if (ctx.interruptedTurnIds.has(turnId)) {
                yield* settlePromptInFlight(input.threadId, turnId, ctx.acpSessionId, {
                  completedStopReason: "cancelled",
                  emitTurnCompletion: false,
                  settleAllPrompts: true,
                });
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "OMP prompt was interrupted during preparation.",
                });
              }
              if (steeringTurnId === undefined) {
                ctx.lastPlanFingerprint = undefined;
              }
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              };

              if (
                steeringTurnId !== undefined &&
                promptParts.length === 1 &&
                promptParts[0]?.type === "text"
              ) {
                // Do not hold the thread lock while waiting for the extension
                // response. Some ACP agents serialize extension dispatch behind
                // prompt completion; holding the lock here would deadlock that
                // completion against the steering request.
                ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
                return {
                  kind: "steer" as const,
                  acp: ctx.acp,
                  acpSessionId: ctx.acpSessionId,
                  displayModel,
                  displayEffort,
                  promptParts,
                  turnId,
                  text: promptParts[0].text,
                };
              }

              return {
                kind: "prompt" as const,
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                displayEffort,
                promptParts,
                turnId,
                emitTurnStarted: steeringTurnId === undefined,
              };
            }).pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  const liveCtx = sessions.get(input.threadId);
                  if (!liveCtx) {
                    return;
                  }
                  yield* settlePromptInFlight(input.threadId, turnId, liveCtx.acpSessionId, {
                    errorMessage: "OMP prompt preparation failed.",
                    emitTurnCompletion: false,
                  });
                }),
              ),
            );
          }),
        );
        if (prepared.kind === "steer") {
          const steerRequest = buildOmpSteerRequest(prepared.acpSessionId, prepared.text);
          const steerRaw = yield* prepared.acp
            .request(steerRequest.method, steerRequest.payload)
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "_omp/session/steer", error),
              ),
            );
          const steer = parseOmpSteerResult(steerRaw);
          if (!steer) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "_omp/session/steer",
              detail: "OMP returned an invalid steering response.",
            });
          }
          if (steer.accepted) {
            // A native steer keeps the same provider turn, so OMP does not
            // emit another turn.started boundary. Re-assert the running
            // session state after the steer is accepted so orchestration can
            // consume the pending turn-start request that carried the steer.
            // Without this acknowledgement, the read model retains a stale
            // pending turn after the original turn completes and treats the
            // otherwise-idle thread as permanently busy.
            yield* offerRuntimeEvent({
              type: "session.state.changed",
              ...(yield* makeEventStamp(input.threadId)),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: {
                state: "running",
                reason: "OMP native steer accepted into the active turn",
              },
            });
            return {
              threadId: input.threadId,
              turnId: prepared.turnId,
              resumeCursor: (yield* requireSession(input.threadId)).session.resumeCursor,
            };
          }

          prepared = yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              if (ctx.acpSessionId !== prepared.acpSessionId) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "OMP session changed before the idle steering fallback.",
                });
              }
              const liveTurnId = ctx.activeTurnId;
              const fallbackTurnId = liveTurnId ?? TurnId.make(yield* randomUUIDv4);
              ctx.promptsInFlight += 1;
              ctx.activeTurnId = fallbackTurnId;
              if (liveTurnId === undefined) ctx.lastPlanFingerprint = undefined;
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: fallbackTurnId,
                updatedAt: yield* nowIso,
                ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
              };
              return {
                kind: "prompt" as const,
                acp: prepared.acp,
                acpSessionId: prepared.acpSessionId,
                displayModel: prepared.displayModel,
                displayEffort: prepared.displayEffort,
                promptParts: prepared.promptParts,
                turnId: fallbackTurnId,
                emitTurnStarted: liveTurnId === undefined,
              };
            }),
          );
        }
        const promptSettled = yield* Ref.make(false);
        const promptRpcSucceeded = yield* Ref.make(false);
        const promptResultRef = yield* Ref.make<EffectAcpSchema.PromptResponse | undefined>(
          undefined,
        );

        const promptFailureMessageRef = yield* Ref.make<string | undefined>(undefined);

        return yield* Effect.gen(function* () {
          const result = yield* prepared.acp
            .prompt(
              {
                prompt: prepared.promptParts,
              },
              prepared.emitTurnStarted
                ? {
                    onRegistered: Effect.gen(function* () {
                      yield* offerRuntimeEvent({
                        type: "turn.started",
                        ...(yield* makeEventStamp(input.threadId)),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId: prepared.turnId,
                        payload: {
                          ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
                          ...(prepared.displayEffort ? { effort: prepared.displayEffort } : {}),
                        },
                      });
                    }),
                  }
                : undefined,
            )
            .pipe(
              Effect.tap((promptResult) =>
                Effect.all([
                  Ref.set(promptRpcSucceeded, true),
                  Ref.set(promptResultRef, promptResult),
                ]),
              ),
              Effect.tapError((error) =>
                Ref.set(
                  promptFailureMessageRef,
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error).message,
                ).pipe(Effect.andThen(prepared.acp.drainEvents)),
              ),
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
            );

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              if (ctx.acpSessionId !== prepared.acpSessionId) {
                yield* settlePromptInFlight(
                  input.threadId,
                  prepared.turnId,
                  prepared.acpSessionId,
                  {
                    errorMessage: "OMP session changed before the turn completed.",
                    settleAllPrompts: true,
                  },
                );
                yield* Ref.set(promptSettled, true);
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "OMP session changed before the turn completed.",
                });
              }
              // Keep prompt settlement atomic with respect to Stop and steering.
              // interruptTurn marks its target before waiting for this lock, so
              // cancellation can still win while queued ACP events are drained.
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              yield* prepared.acp.drainEvents;
              if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              if (
                ctx.promptsInFlight <= 0 ||
                ctx.activeTurnId !== prepared.turnId ||
                ctx.session.activeTurnId !== prepared.turnId
              ) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              appendPromptResultToTurn(ctx, prepared.turnId, prepared.promptParts, result);
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: prepared.turnId,
                updatedAt: yield* nowIso,
              };
              const remainingPrompts = Math.max(0, ctx.promptsInFlight - 1);
              ctx.promptsInFlight = remainingPrompts;

              // Only the last remaining prompt settles the turn. A steer-
              // superseded prompt resolving while another is in flight or
              // pending must leave the merged turn running.
              if (
                remainingPrompts === 0 &&
                ctx.activeTurnId === prepared.turnId &&
                ctx.session.activeTurnId === prepared.turnId
              ) {
                if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                  yield* Ref.set(promptSettled, true);
                  return {
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    resumeCursor: ctx.session.resumeCursor,
                  };
                }
                const completedAt = yield* nowIso;
                const { activeTurnId: _completedTurnId, ...readySession } = ctx.session;
                ctx.activeTurnId = undefined;
                ctx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt: completedAt,
                };
                const completedStopReason = completedStopReasonFromPromptResponse(result);
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp(input.threadId)),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  payload: {
                    state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                    stopReason: completedStopReason,
                  },
                });
                ctx.interruptedTurnIds.delete(prepared.turnId);
                yield* Ref.set(promptSettled, true);
              } else if (remainingPrompts > 0) {
                yield* Ref.set(promptSettled, true);
              }

              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (yield* Ref.get(promptSettled)) {
                return;
              }

              if (yield* Ref.get(promptRpcSucceeded)) {
                const promptResult = yield* Ref.get(promptResultRef);
                if (promptResult === undefined) {
                  return;
                }
                yield* withThreadLock(
                  input.threadId,
                  Effect.gen(function* () {
                    const ctx = yield* requireSession(input.threadId);
                    if (ctx.acpSessionId !== prepared.acpSessionId) {
                      yield* settlePromptInFlight(
                        input.threadId,
                        prepared.turnId,
                        prepared.acpSessionId,
                        {
                          errorMessage: "OMP session changed before the turn completed.",
                          settleAllPrompts: true,
                        },
                      );
                      return;
                    }
                    if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                      return;
                    }
                    if (
                      ctx.promptsInFlight <= 0 ||
                      ctx.activeTurnId !== prepared.turnId ||
                      ctx.session.activeTurnId !== prepared.turnId
                    ) {
                      return;
                    }
                    appendPromptResultToTurn(
                      ctx,
                      prepared.turnId,
                      prepared.promptParts,
                      promptResult,
                    );
                    yield* settlePromptInFlight(
                      input.threadId,
                      prepared.turnId,
                      prepared.acpSessionId,
                      {
                        completedStopReason: completedStopReasonFromPromptResponse(promptResult),
                      },
                    );
                  }),
                );
                return;
              }

              const errorMessage = yield* Ref.get(promptFailureMessageRef);
              yield* withThreadLock(
                input.threadId,
                settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                  errorMessage: errorMessage ?? "OMP prompt request failed.",
                }),
              );
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      });

    const interruptTurn: OmpAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const observed = yield* Effect.sync(() => {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) {
            return {
              _tag: "Proceed" as const,
              acpSessionId: undefined,
              interruptedTurnId: turnId,
            };
          }
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return { _tag: "Ignore" as const };
          }
          const interruptedTurnId = turnId ?? activeTurnId;
          if (interruptedTurnId !== undefined) {
            ctx.interruptedTurnIds.add(interruptedTurnId);
          }
          return {
            _tag: "Proceed" as const,
            acpSessionId: ctx.acpSessionId,
            interruptedTurnId,
          };
        });
        if (observed._tag === "Ignore") {
          yield* metrics.recordInterrupt("ignored");
          return;
        }

        yield* metrics.recordInterrupt("requested");

        yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            if (observed.acpSessionId !== undefined && ctx.acpSessionId !== observed.acpSessionId) {
              return;
            }
            const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
            if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
              return;
            }
            if (
              observed.interruptedTurnId !== undefined &&
              activeTurnId !== undefined &&
              activeTurnId !== observed.interruptedTurnId
            ) {
              return;
            }
            const interruptedTurnId =
              observed.interruptedTurnId ?? turnId ?? activeTurnId ?? ctx.session.activeTurnId;
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
            const cancellationFailure = yield* ctx.acp.cancel.pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
              ),
              Effect.match({
                onFailure: Option.some,
                onSuccess: () => Option.none(),
              }),
            );
            if (Option.isSome(cancellationFailure)) {
              const error = cancellationFailure.value;
              if (interruptedTurnId) {
                ctx.interruptedTurnIds.add(interruptedTurnId);
                yield* settlePromptInFlight(threadId, interruptedTurnId, ctx.acpSessionId, {
                  errorMessage: error.message,
                  settleAllPrompts: true,
                });
              }
              yield* stopSessionInternal(ctx, "error");
              return yield* error;
            }
            if (interruptedTurnId) {
              ctx.interruptedTurnIds.add(interruptedTurnId);
              yield* settlePromptInFlight(threadId, interruptedTurnId, ctx.acpSessionId, {
                completedStopReason: "cancelled",
                settleAllPrompts: true,
              });
            } else if (
              ctx.promptsInFlight > 0 ||
              ctx.session.status === "running" ||
              ctx.session.status === "connecting"
            ) {
              const updatedAt = yield* nowIso;
              ctx.promptsInFlight = 0;
              ctx.activeTurnId = undefined;
              const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
              ctx.session = {
                ...readySession,
                status: "ready",
                updatedAt,
              };
            }
          }),
        );
      });

    const respondToRequest: OmpAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: OmpAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
      });

    const readThread: OmpAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: OmpAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "OMP ACP sessions do not support provider-side rollback yet.",
        });
      });

    const stopSession: OmpAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: OmpAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: OmpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: OmpAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
        discard: true,
      });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies OmpAdapterShape;
  });
}
