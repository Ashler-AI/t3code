import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { causeErrorTag, errorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

function structuralMethod(value: string): string {
  return value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:/-]*$/.test(value) ? value : "unknown";
}

function summarizePayload(payload: unknown): Readonly<Record<string, unknown>> {
  if (payload === null) return { valueType: "null" };
  if (typeof payload === "string") {
    return { valueType: "string", byteLength: new TextEncoder().encode(payload).byteLength };
  }
  if (payload instanceof Uint8Array) {
    return { valueType: "bytes", byteLength: payload.byteLength };
  }
  if (Array.isArray(payload)) {
    return { valueType: "array", itemCount: payload.length };
  }
  if (typeof payload !== "object") {
    return { valueType: typeof payload };
  }

  try {
    const record = payload as Record<string, unknown>;
    return {
      valueType: "object",
      fieldCount: Object.keys(record).length,
      ...(typeof record._tag === "string" ? { messageTag: errorTag(record) } : {}),
      ...(typeof record.tag === "string" ? { method: structuralMethod(record.tag) } : {}),
    };
  } catch {
    return { valueType: "object" };
  }
}

const MAX_RPC_ERROR_TEXT_LENGTH = 1_024;

function redactRpcErrorText(value: string): string {
  return value
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;\])}]+/gi, "Authorization: Bearer <redacted>")
    .replace(/\bBearer\s+(?!<redacted>)[A-Za-z0-9._~+/-]+=*/gi, "Bearer <redacted>")
    .replace(/\b(access[_-]?token|api[_-]?key|token)\b(\s*[:=]\s*)[^\s,;]+/gi, "$1$2<redacted>")
    .slice(0, MAX_RPC_ERROR_TEXT_LENGTH);
}

const STANDARD_JSON_RPC_ERROR_MESSAGES = new Map<number, string>([
  [-32700, "Parse error"],
  [-32600, "Invalid Request"],
  [-32601, "Method not found"],
  [-32602, "Invalid params"],
  [-32603, "Internal error"],
]);

function structuralRpcErrorMessage(code: number | undefined, value: unknown): string | undefined {
  if (code === undefined || typeof value !== "string") return undefined;
  const expected = STANDARD_JSON_RPC_ERROR_MESSAGES.get(code);
  return value === expected ? expected : undefined;
}

function rpcErrorDiagnostic(cause: Cause.Cause<unknown>) {
  for (const reason of cause.reasons) {
    if (reason._tag !== "Fail") continue;
    const error = reason.error;
    if (
      typeof error !== "object" ||
      error === null ||
      !("_tag" in error) ||
      error._tag !== "AcpRequestError"
    ) {
      continue;
    }
    const code = "code" in error && typeof error.code === "number" ? error.code : undefined;
    const message = structuralRpcErrorMessage(
      code,
      "errorMessage" in error ? error.errorMessage : undefined,
    );
    const data =
      "data" in error && typeof error.data === "object" && error.data !== null
        ? error.data
        : undefined;
    const details =
      data && "details" in data && typeof data.details === "string"
        ? redactRpcErrorText(data.details)
        : undefined;
    return {
      ...(code !== undefined ? { code } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(details !== undefined ? { details } : {}),
    };
  }
  return undefined;
}

function formatRequestLogPayload(event: AcpSessionRuntime.AcpSessionRequestLogEvent) {
  const rpcError = event.cause === undefined ? undefined : rpcErrorDiagnostic(event.cause);
  return {
    method: structuralMethod(event.method),
    status: event.status,
    request: summarizePayload(event.payload),
    ...(event.result !== undefined ? { result: summarizePayload(event.result) } : {}),
    ...(event.cause !== undefined
      ? {
          errorTag: causeErrorTag(event.cause),
          reasonCount: event.cause.reasons.length,
          ...(rpcError === undefined ? {} : { rpcError }),
        }
      : {}),
  };
}

function formatProtocolLogPayload(event: EffectAcpProtocol.AcpProtocolLogEvent) {
  return {
    direction: event.direction,
    stage: event.stage,
    payload: summarizePayload(event.payload),
  };
}

export const makeAcpNativeLoggerFactory = Effect.fn("makeAcpNativeLoggerFactory")(function* () {
  const crypto = yield* Crypto.Crypto;
  return (input: {
    readonly nativeEventLogger: EventNdjsonLogger | undefined;
    readonly provider: ProviderDriverKind;
    readonly threadId: ThreadId;
  }): Pick<AcpSessionRuntime.AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging"> => {
    const writeNativeAcpLog = (logInput: {
      readonly kind: "request" | "protocol";
      readonly payload: unknown;
    }) =>
      Effect.gen(function* () {
        if (!input.nativeEventLogger) return;
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        yield* input.nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* crypto.randomUUIDv4,
              kind: logInput.kind,
              provider: input.provider,
              createdAt: observedAt,
              threadId: input.threadId,
              payload: logInput.payload,
            },
          },
          input.threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Failed to write native ACP event log.", {
                errorTag: causeErrorTag(cause),
                reasonCount: cause.reasons.length,
                provider: input.provider,
                threadId: input.threadId,
              }),
        ),
      );

    return {
      requestLogger: (event: AcpSessionRuntime.AcpSessionRequestLogEvent) =>
        writeNativeAcpLog({
          kind: "request",
          payload: formatRequestLogPayload(event),
        }),
      ...(input.nativeEventLogger
        ? {
            protocolLogging: {
              logIncoming: true,
              logOutgoing: true,
              logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
                writeNativeAcpLog({
                  kind: "protocol",
                  payload: formatProtocolLogPayload(event),
                }),
            } satisfies NonNullable<AcpSessionRuntime.AcpSessionRuntimeOptions["protocolLogging"]>,
          }
        : {}),
    };
  };
});
