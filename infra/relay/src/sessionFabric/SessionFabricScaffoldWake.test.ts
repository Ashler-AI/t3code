import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  scaffoldWakeFailureIsDefinitive,
  SessionFabricScaffoldWakeError,
  resolveSessionFabricScaffoldWakeConfig,
  SESSION_FABRIC_SCAFFOLD_WAKE_SIGNATURE_HEADER,
  SESSION_FABRIC_SCAFFOLD_WAKE_TIMESTAMP_HEADER,
  wakeScaffoldSession,
} from "./SessionFabricScaffoldWake.ts";

const config = resolveSessionFabricScaffoldWakeConfig({
  url: "https://scaffold.example.test/api/internal/session-fabric/wake",
  secret: "wake-secret",
  timeoutMs: "1000",
});
if (config === null) throw new Error("expected wake config");

const request = {
  fabricSessionId: "sf:environment-a:thread-a",
  commandId: "command-a",
  environmentId: "environment-a",
  threadId: "thread-a",
  scaffoldSessionId: "ses_scaffold_a",
  expectedLifecycleEpoch: 7,
  actorId: "actor-a",
} as const;

describe("SessionFabricScaffoldWake", () => {
  it("keeps the integration disabled only when all configuration is absent", () => {
    expect(
      resolveSessionFabricScaffoldWakeConfig({
        url: undefined,
        secret: undefined,
        timeoutMs: undefined,
      }),
    ).toBeNull();
    expect(() =>
      resolveSessionFabricScaffoldWakeConfig({
        url: "https://scaffold.example.test/wake",
        secret: undefined,
        timeoutMs: "1000",
      }),
    ).toThrow();
    expect(() =>
      resolveSessionFabricScaffoldWakeConfig({
        url: "http://scaffold.example.test/wake",
        secret: "secret",
        timeoutMs: "1000",
      }),
    ).toThrow();
  });

  it.effect("signs the exact body and accepts the fenced next lifecycle epoch", () =>
    Effect.gen(function* () {
      let capturedRequest: Request | undefined;
      let capturedSignal: AbortSignal | undefined;
      const response = yield* wakeScaffoldSession(config, request, {
        now: () => 1_785_000_000_000,
        fetch: async (input, init) => {
          capturedSignal = init?.signal ?? undefined;
          capturedRequest = new Request(input, init);
          return Response.json(
            {
              ok: true,
              version: "scaffold.session_fabric.wake_result.v1",
              fabricSessionId: request.fabricSessionId,
              commandId: request.commandId,
              environmentId: request.environmentId,
              threadId: request.threadId,
              scaffoldSessionId: request.scaffoldSessionId,
              expectedLifecycleEpoch: request.expectedLifecycleEpoch,
              targetLifecycleEpoch: 8,
              status: "resuming",
              deduplicated: false,
            },
            { status: 202 },
          );
        },
      });

      expect(response.targetLifecycleEpoch).toBe(8);
      expect(capturedRequest).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);
      const timestamp = capturedRequest?.headers.get(SESSION_FABRIC_SCAFFOLD_WAKE_TIMESTAMP_HEADER);
      const signature = capturedRequest?.headers.get(SESSION_FABRIC_SCAFFOLD_WAKE_SIGNATURE_HEADER);
      expect(timestamp).toBe("1785000000000");
      expect(signature).toMatch(/^[0-9a-f]{64}$/u);
      const capturedBody = yield* Effect.promise(
        () => capturedRequest?.json() ?? Promise.resolve(),
      );
      expect(capturedBody).toEqual({
        version: "scaffold.session_fabric.wake.v1",
        ...request,
      });
    }),
  );

  it.effect("rejects mismatched lifecycle evidence", () =>
    Effect.gen(function* () {
      const error = yield* wakeScaffoldSession(config, request, {
        fetch: async () =>
          Response.json({
            ok: true,
            version: "scaffold.session_fabric.wake_result.v1",
            fabricSessionId: request.fabricSessionId,
            commandId: request.commandId,
            environmentId: request.environmentId,
            threadId: request.threadId,
            scaffoldSessionId: request.scaffoldSessionId,
            expectedLifecycleEpoch: request.expectedLifecycleEpoch,
            targetLifecycleEpoch: 9,
            status: "ready",
            deduplicated: false,
          }),
      }).pipe(Effect.flip);

      expect(error.reason).toBe("response");
    }),
  );

  it("keeps ambiguous wake failures queued and rejects only definitive failures", () => {
    const failure = (
      reason: "configuration" | "timeout" | "transport" | "response",
      status: number | null,
    ) => new SessionFabricScaffoldWakeError({ reason, status });

    for (const ambiguous of [
      failure("timeout", null),
      failure("transport", null),
      failure("response", null),
      failure("response", 408),
      failure("response", 425),
      failure("response", 429),
      failure("response", 500),
      failure("response", 503),
    ]) {
      expect(scaffoldWakeFailureIsDefinitive(ambiguous)).toBe(false);
    }
    for (const definitive of [
      failure("configuration", null),
      failure("response", 400),
      failure("response", 401),
      failure("response", 403),
      failure("response", 404),
      failure("response", 409),
      failure("response", 422),
    ]) {
      expect(scaffoldWakeFailureIsDefinitive(definitive)).toBe(true);
    }
  });

  it.effect("bounds a transport that never settles", () =>
    Effect.gen(function* () {
      const bounded = { ...config, timeoutMs: 5 };
      const error = yield* wakeScaffoldSession(bounded, request, {
        fetch: () => new Promise<Response>(() => undefined),
      }).pipe(Effect.flip);

      expect(error.reason).toBe("timeout");
    }),
  );
});
