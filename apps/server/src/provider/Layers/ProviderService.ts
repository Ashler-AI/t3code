/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  EnvironmentId,
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderRuntimeResumeCursor,
  RuntimeSessionId,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderRuntimeEventEnvelope,
  type ProviderSession,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  type ProviderAdapterError,
  type ProviderServiceError,
  ProviderValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
const isModelSelection = Schema.is(ModelSelection);
const isProviderRuntimeResumeCursor = Schema.is(ProviderRuntimeResumeCursor);

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
  readonly environmentId?: EnvironmentId;
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPersistedCanonicalSourceSequence(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): number | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw =
    "canonicalSourceSequence" in runtimePayload
      ? runtimePayload.canonicalSourceSequence
      : undefined;
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
}

function deliveryRejectionDetail(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.trim().length > 0) {
    return cause;
  }
  return "Unknown permanent delivery rejection";
}

type TerminalDeliveryFailure = {
  readonly eventId: string;
  readonly sourceSequence: number;
  readonly detail: string;
};

function readPersistedTerminalDeliveryFailure(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): TerminalDeliveryFailure | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw =
    "canonicalDeliveryFailure" in runtimePayload
      ? runtimePayload.canonicalDeliveryFailure
      : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  return typeof candidate.eventId === "string" &&
    typeof candidate.sourceSequence === "number" &&
    Number.isSafeInteger(candidate.sourceSequence) &&
    candidate.sourceSequence >= 0 &&
    typeof candidate.detail === "string" &&
    candidate.detail.trim().length > 0
    ? {
        eventId: candidate.eventId,
        sourceSequence: candidate.sourceSequence,
        detail: candidate.detail,
      }
    : undefined;
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

function canonicalResumeCursor(
  event: ProviderRuntimeEvent,
): ProviderRuntimeEventEnvelope["resumeCursor"] {
  if (event.resumeCursor === undefined) {
    return null;
  }
  if (
    event.provider === "omp" &&
    typeof event.resumeCursor === "object" &&
    event.resumeCursor !== null &&
    !Array.isArray(event.resumeCursor)
  ) {
    const raw = event.resumeCursor as Record<string, unknown>;
    const candidate = {
      kind: "omp" as const,
      schemaVersion: raw.schemaVersion,
      sessionId:
        typeof raw.sessionId === "string" ? RuntimeSessionId.make(raw.sessionId) : raw.sessionId,
      eventSequence: raw.eventSequence,
      acpSequence: raw.acpSequence,
      ...(typeof raw.activeTurnId === "string" ? { activeTurnId: raw.activeTurnId } : {}),
    };
    if (isProviderRuntimeResumeCursor(candidate)) {
      return candidate;
    }
  }
  return { kind: "opaque", value: event.resumeCursor };
}

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService);
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const canonicalRuntimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEventEnvelope>();
  const canonicalRuntimeDeliveryQueue =
    yield* Queue.unbounded<ProviderService.ProviderRuntimeEventDelivery>();
  yield* Effect.addFinalizer(() => Queue.shutdown(canonicalRuntimeDeliveryQueue));
  const environmentId = options?.environmentId ?? EnvironmentId.make("local");
  const sourceSequences = new Map<ThreadId, number>();
  const terminalDeliveryFailures = new Map<ThreadId, TerminalDeliveryFailure>();
  const pendingRuntimeBindings = new Map<
    ThreadId,
    {
      readonly expectedInstanceId: ProviderInstanceId;
      readonly events: Array<{
        readonly source: {
          readonly instanceId: ProviderInstanceId;
          readonly provider: ProviderDriverKind;
        };
        readonly event: ProviderRuntimeEvent;
      }>;
    }
  >();
  let durableDeliveryConsumerEnabled = false;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const prepareMcpSession = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
    McpSessionRegistry.issueActiveMcpCredential({ threadId, providerInstanceId }).pipe(
      Effect.tap((credential) =>
        credential
          ? Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config))
          : Effect.void,
      ),
    );
  const clearMcpSession = (threadId: ThreadId) =>
    McpSessionRegistry.revokeActiveMcpThread(threadId).pipe(
      Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );

  const getTerminalDeliveryFailure = Effect.fn("ProviderService.getTerminalDeliveryFailure")(
    function* (threadId: ThreadId) {
      const localFailure = terminalDeliveryFailures.get(threadId);
      if (localFailure !== undefined) {
        return localFailure;
      }
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const persistedFailure = readPersistedTerminalDeliveryFailure(binding?.runtimePayload);
      if (persistedFailure !== undefined) {
        terminalDeliveryFailures.set(threadId, persistedFailure);
      }
      return persistedFailure;
    },
  );

  const resolveSourceSequence = Effect.fn("ProviderService.resolveSourceSequence")(function* (
    event: ProviderRuntimeEvent,
  ) {
    const resumeCursor = canonicalResumeCursor(event);
    if (resumeCursor?.kind === "omp") {
      sourceSequences.set(
        event.threadId,
        Math.max(sourceSequences.get(event.threadId) ?? 0, resumeCursor.eventSequence),
      );
      return resumeCursor.eventSequence;
    }

    let previousSourceSequence = sourceSequences.get(event.threadId);
    if (previousSourceSequence === undefined) {
      const binding = Option.getOrUndefined(yield* directory.getBinding(event.threadId));
      previousSourceSequence = readPersistedCanonicalSourceSequence(binding?.runtimePayload) ?? 0;
    }
    const sourceSequence = previousSourceSequence + 1;
    sourceSequences.set(event.threadId, sourceSequence);
    return sourceSequence;
  });

  const checkpointRuntimeEvent = (
    source: { readonly instanceId: ProviderInstanceId; readonly provider: ProviderDriverKind },
    envelope: ProviderRuntimeEventEnvelope,
  ) =>
    directory.upsert({
      threadId: envelope.threadId,
      provider: envelope.event.provider,
      providerInstanceId: source.instanceId,
      ...(envelope.event.resumeCursor !== undefined
        ? { resumeCursor: envelope.event.resumeCursor }
        : {}),
      runtimePayload: {
        canonicalSourceSequence: envelope.sourceSequence,
        canonicalEventId: envelope.eventId,
        lastRuntimeEvent: envelope.event.type,
        lastRuntimeEventAt: envelope.event.createdAt,
        ...(envelope.event.turnId !== undefined ? { activeTurnId: envelope.event.turnId } : {}),
      },
      ...(envelope.resumeCursor?.kind === "omp"
        ? {
            canonicalSourceCursor: {
              environmentId: envelope.environmentId,
              threadId: envelope.threadId,
              providerInstanceId: envelope.providerInstanceId,
              runtimeSessionId: envelope.resumeCursor.sessionId,
              sourceSequence: envelope.sourceSequence,
              eventId: envelope.eventId,
            },
          }
        : {}),
    });

  const awaitDurableIngestion = Effect.fn("ProviderService.awaitDurableIngestion")(function* (
    source: { readonly instanceId: ProviderInstanceId; readonly provider: ProviderDriverKind },
    envelope: ProviderRuntimeEventEnvelope,
  ) {
    while (true) {
      const receipt = yield* Deferred.make<
        | { readonly _tag: "Acknowledged" }
        | { readonly _tag: "Retry"; readonly cause?: unknown }
        | { readonly _tag: "Rejected"; readonly cause: unknown }
      >();
      const receiptSemaphore = yield* Semaphore.make(1);
      const acknowledge = receiptSemaphore.withPermits(1)(
        Effect.gen(function* () {
          if (yield* Deferred.isDone(receipt)) return;
          yield* checkpointRuntimeEvent(source, envelope);
          yield* Deferred.succeed(receipt, { _tag: "Acknowledged" }).pipe(Effect.asVoid);
        }),
      );
      const retry = (cause?: unknown) =>
        receiptSemaphore.withPermits(1)(
          Deferred.isDone(receipt).pipe(
            Effect.flatMap((done) =>
              done
                ? Effect.void
                : Deferred.succeed(receipt, {
                    _tag: "Retry" as const,
                    ...(cause === undefined ? {} : { cause }),
                  }).pipe(Effect.asVoid),
            ),
          ),
        );
      const reject = (cause: unknown) =>
        receiptSemaphore.withPermits(1)(
          Deferred.isDone(receipt).pipe(
            Effect.flatMap((done) =>
              done
                ? Effect.void
                : Effect.sync(() => {
                    terminalDeliveryFailures.set(envelope.threadId, {
                      eventId: envelope.eventId,
                      sourceSequence: envelope.sourceSequence,
                      detail: deliveryRejectionDetail(cause),
                    });
                  }).pipe(
                    Effect.andThen(
                      Deferred.succeed(receipt, {
                        _tag: "Rejected" as const,
                        cause,
                      }),
                    ),
                    Effect.asVoid,
                  ),
            ),
          ),
        );
      yield* Queue.offer(canonicalRuntimeDeliveryQueue, {
        envelope,
        acknowledge,
        retry,
        reject,
      });
      const resolution = yield* Deferred.await(receipt);
      if (resolution._tag === "Acknowledged") return;
      if (resolution._tag === "Rejected") {
        const detail = deliveryRejectionDetail(resolution.cause);
        yield* directory
          .upsert({
            threadId: envelope.threadId,
            provider: envelope.event.provider,
            providerInstanceId: source.instanceId,
            status: "error",
            runtimePayload: {
              activeTurnId: null,
              lastError: `Canonical provider delivery was permanently rejected: ${detail}`,
              lastRuntimeEvent: "provider.runtime-delivery.rejected",
              lastRuntimeEventAt: envelope.event.createdAt,
              canonicalDeliveryFailure: {
                eventId: envelope.eventId,
                sourceSequence: envelope.sourceSequence,
                detail,
              },
            },
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("failed to persist provider runtime delivery rejection", {
                threadId: envelope.threadId,
                eventId: envelope.eventId,
                cause,
              }),
            ),
          );
        yield* registry.getByInstance(source.instanceId).pipe(
          Effect.flatMap((adapter) => adapter.stopSession(envelope.threadId)),
          Effect.catchCause((cause) =>
            Effect.logError("failed to stop permanently rejected provider session", {
              threadId: envelope.threadId,
              eventId: envelope.eventId,
              cause,
            }),
          ),
        );
        yield* clearMcpSession(envelope.threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("failed to clear permanently rejected provider MCP session", {
              threadId: envelope.threadId,
              eventId: envelope.eventId,
              cause,
            }),
          ),
        );
        yield* Effect.logError("provider runtime delivery permanently rejected", {
          threadId: envelope.threadId,
          eventId: envelope.eventId,
          sourceSequence: envelope.sourceSequence,
          cause: resolution.cause,
        });
        return;
      }
      yield* Effect.logWarning("provider runtime delivery requested retry", {
        threadId: envelope.threadId,
        eventId: envelope.eventId,
        sourceSequence: envelope.sourceSequence,
        ...(resolution.cause === undefined ? {} : { cause: resolution.cause }),
      });
      yield* Effect.yieldNow;
    }
  });

  const publishRuntimeEvent = Effect.fn("ProviderService.publishRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
    source: { readonly instanceId: ProviderInstanceId },
  ) {
    const terminalFailure = yield* getTerminalDeliveryFailure(event.threadId);
    if (terminalFailure !== undefined) {
      yield* Effect.logError("provider runtime event blocked by permanent delivery rejection", {
        threadId: event.threadId,
        eventId: event.eventId,
        rejectedEventId: terminalFailure.eventId,
        rejectedSourceSequence: terminalFailure.sourceSequence,
        cause: terminalFailure.detail,
      });
      return;
    }
    const resumeCursor = canonicalResumeCursor(event);
    const sourceSequence = yield* resolveSourceSequence(event);
    const envelope: ProviderRuntimeEventEnvelope = {
      protocolVersion: 1,
      eventId: event.eventId,
      environmentId,
      threadId: event.threadId,
      sourceSequence,
      resumeCursor,
      providerInstanceId: source.instanceId,
      ...(resumeCursor?.kind === "omp" ? { runtimeSessionId: resumeCursor.sessionId } : {}),
      event,
    };
    if (canonicalEventLogger) {
      yield* canonicalEventLogger.write(event, event.threadId);
    }
    yield* PubSub.publish(runtimeEventPubSub, event);
    yield* PubSub.publish(canonicalRuntimeEventPubSub, envelope);
    if (durableDeliveryConsumerEnabled) {
      yield* awaitDurableIngestion(
        { instanceId: source.instanceId, provider: event.provider },
        envelope,
      );
    }
  });

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  const processBoundRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void, ProviderServiceError> =>
    Effect.sync(() => correlateRuntimeEventWithInstance(source, event)).pipe(
      Effect.flatMap((canonicalEvent) =>
        increment(providerRuntimeEventsTotal, {
          provider: canonicalEvent.provider,
          eventType: canonicalEvent.type,
        }).pipe(Effect.andThen(publishRuntimeEvent(canonicalEvent, source))),
      ),
    );

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void, ProviderServiceError> =>
    Effect.suspend(() => {
      const pending = pendingRuntimeBindings.get(event.threadId);
      if (pending?.expectedInstanceId === source.instanceId) {
        pending.events.push({ source, event });
        return Effect.void;
      }
      return processBoundRuntimeEvent(source, event);
    });

  const beginRuntimeBinding = (
    operation: string,
    threadId: ThreadId,
    expectedInstanceId: ProviderInstanceId,
  ) =>
    Effect.suspend(() => {
      if (pendingRuntimeBindings.has(threadId)) {
        return Effect.fail(
          toValidationError(
            operation,
            `Cannot start thread '${threadId}' while another provider runtime binding is in progress.`,
          ),
        );
      }
      pendingRuntimeBindings.set(threadId, { expectedInstanceId, events: [] });
      return Effect.void;
    });

  const discardPendingRuntimeEvents = (threadId: ThreadId) =>
    Effect.sync(() => {
      pendingRuntimeBindings.delete(threadId);
    });

  const compensateFailedRuntimeBinding = Effect.fn(
    "ProviderService.compensateFailedRuntimeBinding",
  )(function* (threadId: ThreadId, adapter: ProviderAdapterShape<ProviderAdapterError>) {
    yield* adapter.stopSession(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.stop-unbound-failed", {
          threadId,
          provider: adapter.provider,
          cause,
        }),
      ),
    );
    // OMP stop emits session.exited synchronously. Keep the binding gate in
    // place through stop so the failed runtime cannot escape as an unbound
    // canonical event, then discard that runtime's entire buffered segment.
    yield* discardPendingRuntimeEvents(threadId);
    yield* clearMcpSession(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.clear-unbound-mcp-failed", {
          threadId,
          provider: adapter.provider,
          cause,
        }),
      ),
    );
  });

  const releaseRuntimeBinding = Effect.fn("ProviderService.releaseRuntimeBinding")(function* (
    threadId: ThreadId,
  ) {
    while (true) {
      const pending = pendingRuntimeBindings.get(threadId);
      if (pending === undefined) return;
      const batch = pending.events.splice(0, pending.events.length);
      if (batch.length === 0) {
        pendingRuntimeBindings.delete(threadId);
        return;
      }
      yield* Effect.forEach(batch, ({ source, event }) => processBoundRuntimeEvent(source, event), {
        discard: true,
      });
    }
  });

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
            },
            event,
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          yield* upsertSessionBinding(
            { ...existing, providerInstanceId: bindingInstanceId },
            input.binding.threadId,
          );
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);

      yield* beginRuntimeBinding(input.operation, input.binding.threadId, bindingInstanceId);
      yield* prepareMcpSession(input.binding.threadId, bindingInstanceId).pipe(
        Effect.onError(() => discardPendingRuntimeEvents(input.binding.threadId)),
      );
      const resumed = yield* adapter
        .startSession({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          providerInstanceId: bindingInstanceId,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
          runtimeMode: input.binding.runtimeMode ?? "full-access",
        })
        .pipe(
          Effect.onError(() =>
            discardPendingRuntimeEvents(input.binding.threadId).pipe(
              Effect.andThen(clearMcpSession(input.binding.threadId)),
            ),
          ),
        );
      if (resumed.provider !== adapter.provider) {
        yield* compensateFailedRuntimeBinding(input.binding.threadId, adapter);
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      yield* Effect.gen(function* () {
        yield* upsertSessionBinding(
          { ...resumed, providerInstanceId: bindingInstanceId },
          input.binding.threadId,
        );
        yield* releaseRuntimeBinding(input.binding.threadId);
      }).pipe(
        Effect.onError(() => compensateFailedRuntimeBinding(input.binding.threadId, adapter)),
      );
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const terminalFailure = yield* getTerminalDeliveryFailure(input.threadId);
    if (terminalFailure !== undefined) {
      return yield* toValidationError(
        input.operation,
        `Cannot continue thread '${input.threadId}' because canonical provider delivery '${terminalFailure.eventId}' was permanently rejected: ${terminalFailure.detail}`,
      );
    }
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: true,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: false,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
    });
    return {
      adapter: recovered.adapter,
      instanceId,
      threadId: input.threadId,
      isActive: true,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.tap(() =>
                  analytics.record("provider.session.stopped", {
                    provider: adapter.provider,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      const terminalFailure = yield* getTerminalDeliveryFailure(threadId);
      if (terminalFailure !== undefined) {
        return yield* toValidationError(
          "ProviderService.startSession",
          `Cannot continue thread '${threadId}' because canonical provider delivery '${terminalFailure.eventId}' was permanently rejected: ${terminalFailure.detail}`,
        );
      }
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
        const resolvedProvider = instanceInfo.driverKind;
        metricProvider = resolvedProvider;
        if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
          );
        }
        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
        };
        if (!instanceInfo.enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' is disabled in T3 Code settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const effectiveResumeCursor =
          input.resumeCursor ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? persistedBinding.resumeCursor
            : undefined);
        const effectiveCwd =
          input.cwd ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? readPersistedCwd(persistedBinding.runtimePayload)
            : undefined);
        yield* Effect.annotateCurrentSpan({
          "provider.kind": resolvedProvider,
          "provider.resume_cursor.source":
            input.resumeCursor !== undefined
              ? "request"
              : effectiveResumeCursor !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.source":
            input.cwd !== undefined
              ? "request"
              : effectiveCwd !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.cwd.effective": effectiveCwd ?? "",
        });
        const adapter = yield* registry.getByInstance(resolvedInstanceId);
        yield* beginRuntimeBinding("ProviderService.startSession", threadId, resolvedInstanceId);
        yield* prepareMcpSession(threadId, resolvedInstanceId).pipe(
          Effect.onError(() => discardPendingRuntimeEvents(threadId)),
        );
        const session = yield* adapter
          .startSession({
            ...input,
            providerInstanceId: resolvedInstanceId,
            ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
            ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
          })
          .pipe(
            Effect.onError(() =>
              discardPendingRuntimeEvents(threadId).pipe(Effect.andThen(clearMcpSession(threadId))),
            ),
          );

        if (session.provider !== adapter.provider) {
          yield* compensateFailedRuntimeBinding(threadId, adapter);
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }
        const sessionWithInstance = {
          ...session,
          providerInstanceId: resolvedInstanceId,
        };

        yield* Effect.gen(function* () {
          yield* stopStaleSessionsForThread({
            threadId,
            currentInstanceId: resolvedInstanceId,
          });
          yield* upsertSessionBinding(sessionWithInstance, threadId, {
            modelSelection: input.modelSelection,
          });
          yield* releaseRuntimeBinding(threadId);
        }).pipe(Effect.onError(() => compensateFailedRuntimeBinding(threadId, adapter)));
        yield* analytics.record("provider.session.started", {
          provider: sessionWithInstance.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
          hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
          hasModel:
            typeof input.modelSelection?.model === "string" &&
            input.modelSelection.model.trim().length > 0,
        });

        return sessionWithInstance;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "start",
            }),
        }),
      );
    },
  );

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      const turn = yield* routed.adapter.sendTurn(input);
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          activeTurnId: turn.turnId,
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: yield* nowIso,
        },
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* clearMcpSession(input.threadId);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
          },
        });
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(
                  Effect.orElseSucceed(() =>
                    Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
                  ),
                ),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
        upsertSessionBinding(session, session.threadId, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt,
        }),
      ),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll()).pipe(Effect.asVoid);
    yield* McpSessionRegistry.revokeAllActiveMcpCredentials();
    McpProviderSession.clearAllMcpProviderSessions();
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        return yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
      }),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  return {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getCapabilities,
    getInstanceInfo,
    rollbackConversation,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
    get streamCanonicalEvents(): NonNullable<ProviderServiceMethod<"streamCanonicalEvents">> {
      return Stream.fromPubSub(canonicalRuntimeEventPubSub);
    },
    get streamCanonicalDeliveries(): NonNullable<
      ProviderServiceMethod<"streamCanonicalDeliveries">
    > {
      durableDeliveryConsumerEnabled = true;
      return Stream.fromQueue(canonicalRuntimeDeliveryQueue);
    },
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  Effect.gen(function* () {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    return yield* makeProviderService({ environmentId });
  }),
);

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options));
}
