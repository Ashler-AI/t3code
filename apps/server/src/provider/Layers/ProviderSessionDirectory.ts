import {
  defaultInstanceIdForDriver,
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryPersistenceError, ProviderValidationError } from "../Errors.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderRuntimeBindingWithMetadata,
  type ProviderCanonicalSourceCursor,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";
const decodeProviderDriverKindValue = Schema.decodeUnknownEffect(ProviderDriverKind);

export class MalformedProviderCanonicalCursorError extends Error {
  override readonly name = "MalformedProviderCanonicalCursorError";
}

function readCanonicalSourceCursor(value: unknown): ProviderCanonicalSourceCursor | undefined {
  if (!isRecord(value)) return undefined;
  if (!("canonicalSourceCursor" in value)) return undefined;
  const raw = value.canonicalSourceCursor;
  if (!isRecord(raw)) {
    throw new MalformedProviderCanonicalCursorError(
      "Persisted canonical provider source cursor is not an object.",
    );
  }
  if (
    typeof raw.environmentId !== "string" ||
    raw.environmentId.length === 0 ||
    typeof raw.threadId !== "string" ||
    raw.threadId.length === 0 ||
    typeof raw.providerInstanceId !== "string" ||
    raw.providerInstanceId.length === 0 ||
    typeof raw.runtimeSessionId !== "string" ||
    raw.runtimeSessionId.length === 0 ||
    typeof raw.sourceSequence !== "number" ||
    !Number.isSafeInteger(raw.sourceSequence) ||
    raw.sourceSequence < 1 ||
    typeof raw.eventId !== "string" ||
    raw.eventId.length === 0
  ) {
    throw new MalformedProviderCanonicalCursorError(
      "Persisted canonical provider source cursor has invalid fields.",
    );
  }
  return {
    environmentId: EnvironmentId.make(raw.environmentId),
    threadId: ThreadId.make(raw.threadId),
    providerInstanceId: ProviderInstanceId.make(raw.providerInstanceId),
    runtimeSessionId: RuntimeSessionId.make(raw.runtimeSessionId),
    sourceSequence: raw.sourceSequence,
    eventId: EventId.make(raw.eventId),
  };
}

function sameCanonicalIdentity(
  left: ProviderCanonicalSourceCursor,
  right: ProviderCanonicalSourceCursor,
): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId &&
    left.providerInstanceId === right.providerInstanceId &&
    left.runtimeSessionId === right.runtimeSessionId
  );
}

function decodeCanonicalSourceCursor(
  value: unknown,
  operation: string,
): Effect.Effect<
  ProviderCanonicalSourceCursor | undefined,
  ProviderSessionDirectoryPersistenceError
> {
  return Effect.try({
    try: () => readCanonicalSourceCursor(value),
    catch: (cause) =>
      new ProviderSessionDirectoryPersistenceError({
        operation,
        detail: "Persisted canonical provider source cursor is malformed.",
        cause,
      }),
  });
}

function readOmpRuntimeSessionId(value: unknown): RuntimeSessionId | undefined {
  if (!isRecord(value) || typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    return undefined;
  }
  return RuntimeSessionId.make(value.sessionId);
}

function toPersistenceError(operation: string) {
  return (cause: unknown) =>
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Failed to execute ${operation}.`,
      cause,
    });
}

function decodeProviderDriverKind(
  providerName: string,
  operation: string,
): Effect.Effect<ProviderDriverKind, ProviderSessionDirectoryPersistenceError> {
  return decodeProviderDriverKindValue(providerName).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderSessionDirectoryPersistenceError({
          operation,
          detail: `Unknown persisted provider '${providerName}'.`,
          cause,
        }),
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRuntimePayload(
  existing: unknown | null,
  next: unknown | null | undefined,
): unknown | null {
  if (next === undefined) {
    return existing ?? null;
  }
  if (isRecord(existing) && isRecord(next)) {
    return { ...existing, ...next };
  }
  return next;
}

function toRuntimeBinding(
  runtime: ProviderSessionRuntime.ProviderSessionRuntime,
  operation: string,
): Effect.Effect<ProviderRuntimeBindingWithMetadata, ProviderSessionDirectoryPersistenceError> {
  return Effect.all({
    provider: decodeProviderDriverKind(runtime.providerName, operation),
    canonicalSourceCursor: decodeCanonicalSourceCursor(runtime.runtimePayload, operation),
  }).pipe(
    Effect.map(({ provider, canonicalSourceCursor }) => {
      return {
        threadId: runtime.threadId,
        provider,
        // Migration boundary only: rows written before the instance split
        // have a null provider_instance_id. Promote them as they leave
        // persistence so hot routing code never has to infer an instance
        // from a driver kind.
        providerInstanceId: runtime.providerInstanceId ?? defaultInstanceIdForDriver(provider),
        adapterKey: runtime.adapterKey,
        runtimeMode: runtime.runtimeMode,
        status: runtime.status,
        resumeCursor: runtime.resumeCursor,
        runtimePayload: runtime.runtimePayload,
        ...(canonicalSourceCursor !== undefined ? { canonicalSourceCursor } : {}),
        lastSeenAt: runtime.lastSeenAt,
      } satisfies ProviderRuntimeBindingWithMetadata;
    }),
  );
}

const makeProviderSessionDirectory = Effect.gen(function* () {
  const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const upsertSemaphore = yield* Semaphore.make(1);

  const getBinding = (threadId: ThreadId) =>
    repository.getByThreadId({ threadId }).pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.getBinding:getByThreadId")),
      Effect.flatMap((runtime) =>
        Option.match(runtime, {
          onNone: () => Effect.succeed(Option.none<ProviderRuntimeBinding>()),
          onSome: (value) =>
            toRuntimeBinding(value, "ProviderSessionDirectory.getBinding").pipe(
              Effect.map((binding) => Option.some(binding)),
            ),
        }),
      ),
    );

  const upsertUnlocked = Effect.fn(function* (binding: ProviderRuntimeBinding) {
    const existing = yield* repository
      .getByThreadId({ threadId: binding.threadId })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:getByThreadId")));

    const existingRuntime = Option.getOrUndefined(existing);
    const resolvedThreadId = binding.threadId ?? existingRuntime?.threadId;
    if (!resolvedThreadId) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "threadId must be a non-empty string.",
      });
    }

    const now = DateTime.formatIso(yield* DateTime.now);
    const providerChanged =
      existingRuntime !== undefined && existingRuntime.providerName !== binding.provider;
    const providerInstanceId =
      binding.providerInstanceId ?? (!providerChanged ? existingRuntime?.providerInstanceId : null);
    if (providerInstanceId === null || providerInstanceId === undefined) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "providerInstanceId is required for provider session runtime bindings.",
      });
    }
    const existingCanonicalSourceCursor = yield* decodeCanonicalSourceCursor(
      existingRuntime?.runtimePayload,
      "ProviderSessionDirectory.upsert:canonicalSourceCursor",
    );
    if (binding.canonicalSourceCursor !== undefined) {
      if (
        binding.canonicalSourceCursor.threadId !== binding.threadId ||
        binding.canonicalSourceCursor.providerInstanceId !== binding.providerInstanceId
      ) {
        return yield* new ProviderValidationError({
          operation: "ProviderSessionDirectory.upsert",
          issue: "canonical provider source cursor must match its thread and provider instance.",
        });
      }
    }
    if (
      existingCanonicalSourceCursor !== undefined &&
      existingCanonicalSourceCursor.providerInstanceId !== binding.providerInstanceId
    ) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "canonical provider source cursor provider instance cannot change.",
      });
    }
    if (
      binding.canonicalSourceCursor !== undefined &&
      existingCanonicalSourceCursor === undefined &&
      binding.canonicalSourceCursor.sourceSequence !== 1
    ) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "a fresh canonical provider source cursor must start at sequence 1.",
      });
    }
    if (
      binding.canonicalSourceCursor !== undefined &&
      existingCanonicalSourceCursor !== undefined
    ) {
      const next = binding.canonicalSourceCursor;
      if (!sameCanonicalIdentity(existingCanonicalSourceCursor, next)) {
        const persistedRuntimeSessionId = readOmpRuntimeSessionId(existingRuntime?.resumeCursor);
        const isDurablyBoundSessionTransition =
          existingCanonicalSourceCursor.environmentId === next.environmentId &&
          existingCanonicalSourceCursor.threadId === next.threadId &&
          existingCanonicalSourceCursor.providerInstanceId === next.providerInstanceId &&
          existingCanonicalSourceCursor.runtimeSessionId !== next.runtimeSessionId &&
          persistedRuntimeSessionId === next.runtimeSessionId;
        if (!isDurablyBoundSessionTransition) {
          return yield* new ProviderValidationError({
            operation: "ProviderSessionDirectory.upsert",
            issue: "canonical provider source cursor identity cannot change for a bound thread.",
          });
        }
        if (next.sourceSequence !== 1) {
          return yield* new ProviderValidationError({
            operation: "ProviderSessionDirectory.upsert",
            issue: "a newly bound canonical runtime session must start at sequence 1.",
          });
        }
      }
      if (
        sameCanonicalIdentity(existingCanonicalSourceCursor, next) &&
        (next.sourceSequence < existingCanonicalSourceCursor.sourceSequence ||
          (next.sourceSequence === existingCanonicalSourceCursor.sourceSequence &&
            next.eventId !== existingCanonicalSourceCursor.eventId))
      ) {
        return yield* new ProviderValidationError({
          operation: "ProviderSessionDirectory.upsert",
          issue: "canonical provider source cursor cannot regress or collide.",
        });
      }
      if (
        sameCanonicalIdentity(existingCanonicalSourceCursor, next) &&
        next.sourceSequence > existingCanonicalSourceCursor.sourceSequence + 1
      ) {
        return yield* new ProviderValidationError({
          operation: "ProviderSessionDirectory.upsert",
          issue: "canonical provider source cursor cannot advance across a gap.",
        });
      }
    }
    const runtimePayload = mergeRuntimePayload(
      existingRuntime?.runtimePayload ?? null,
      binding.runtimePayload,
    );
    const runtimePayloadWithCanonicalCursor =
      binding.canonicalSourceCursor === undefined
        ? runtimePayload
        : {
            ...(isRecord(runtimePayload) ? runtimePayload : {}),
            canonicalSourceCursor: binding.canonicalSourceCursor,
          };
    yield* repository
      .upsert({
        threadId: resolvedThreadId,
        providerName: binding.provider,
        providerInstanceId,
        adapterKey:
          binding.adapterKey ??
          (providerChanged ? binding.provider : (existingRuntime?.adapterKey ?? binding.provider)),
        runtimeMode: binding.runtimeMode ?? existingRuntime?.runtimeMode ?? "full-access",
        status: binding.status ?? existingRuntime?.status ?? "running",
        lastSeenAt: now,
        resumeCursor:
          binding.resumeCursor !== undefined
            ? binding.resumeCursor
            : (existingRuntime?.resumeCursor ?? null),
        runtimePayload: runtimePayloadWithCanonicalCursor,
      })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:upsert")));
  });
  const upsert: ProviderSessionDirectoryShape["upsert"] = (binding) =>
    upsertSemaphore.withPermits(1)(upsertUnlocked(binding));

  const getProvider: ProviderSessionDirectoryShape["getProvider"] = (threadId) =>
    getBinding(threadId).pipe(
      Effect.flatMap((binding) =>
        Option.match(binding, {
          onSome: (value) => Effect.succeed(value.provider),
          onNone: () =>
            Effect.fail(
              new ProviderSessionDirectoryPersistenceError({
                operation: "ProviderSessionDirectory.getProvider",
                detail: `No persisted provider binding found for thread '${threadId}'.`,
              }),
            ),
        }),
      ),
    );

  const listThreadIds: ProviderSessionDirectoryShape["listThreadIds"] = () =>
    repository.list().pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listThreadIds:list")),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  const listBindings: ProviderSessionDirectoryShape["listBindings"] = () =>
    repository.list().pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listBindings:list")),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) => toRuntimeBinding(row, "ProviderSessionDirectory.listBindings"),
          { concurrency: "unbounded" },
        ),
      ),
    );

  return {
    upsert,
    getProvider,
    getBinding,
    listThreadIds,
    listBindings,
  } satisfies ProviderSessionDirectoryShape;
});

export const ProviderSessionDirectoryLive = Layer.effect(
  ProviderSessionDirectory,
  makeProviderSessionDirectory,
);

export function makeProviderSessionDirectoryLive() {
  return Layer.effect(ProviderSessionDirectory, makeProviderSessionDirectory);
}
