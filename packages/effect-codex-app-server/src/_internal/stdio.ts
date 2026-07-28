import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CodexError from "../errors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const CODEX_APP_SERVER_STDERR_CAPTURE_LIMIT_BYTES = 16 * 1024;

const SQLITE_CONTENTION_PATTERNS = [
  /\bSQLITE_BUSY\b/i,
  /\bdatabase (?:table )?is locked\b/i,
  /\bdatabase is busy\b/i,
] as const;

export const classifyCodexAppServerStderr = (
  stderr: string,
): CodexError.CodexAppServerProcessExitReason | undefined =>
  SQLITE_CONTENTION_PATTERNS.some((pattern) => pattern.test(stderr))
    ? "sqlite-contention"
    : undefined;

export const captureCodexAppServerStderrReason = <E>(stderr: Stream.Stream<Uint8Array, E>) =>
  Effect.gen(function* () {
    const capture = yield* Ref.make({ bytes: 0, text: "" });
    const drainFiber = yield* Stream.runForEach(stderr, (chunk) =>
      Ref.update(capture, (current) => {
        const remaining = CODEX_APP_SERVER_STDERR_CAPTURE_LIMIT_BYTES - current.bytes;
        if (remaining <= 0) return current;
        const capturedChunk = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        return {
          bytes: current.bytes + capturedChunk.byteLength,
          text: current.text + decoder.decode(capturedChunk),
        };
      }),
    ).pipe(Effect.ignore, Effect.forkScoped);

    return {
      awaitReason: Fiber.join(drainFiber).pipe(
        Effect.andThen(Ref.get(capture)),
        Effect.map(({ text }) => classifyCodexAppServerStderr(text)),
      ),
    };
  });

export const makeChildStdio = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Stdio.make({
    args: Effect.succeed([]),
    stdin: handle.stdout,
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });

export const makeInMemoryStdio = Effect.fn("makeInMemoryStdio")(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();

  return {
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    }),
    input,
    output,
  };
});

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "pid"
>;

export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
  exitReason: Effect.Effect<CodexError.CodexAppServerProcessExitReason | undefined> = Effect.as(
    Effect.void,
    undefined,
  ),
): Effect.Effect<CodexError.CodexAppServerError> =>
  Effect.matchEffect(handle.exitCode, {
    onFailure: (cause) =>
      Effect.succeed(
        new CodexError.CodexAppServerTransportError({
          operation: "read-process-exit-status",
          pid: handle.pid,
          cause,
        }),
      ),
    onSuccess: (code) =>
      Effect.map(
        exitReason,
        (reason) =>
          new CodexError.CodexAppServerProcessExitedError({
            code,
            pid: handle.pid,
            ...(reason ? { reason } : {}),
          }),
      ),
  });
