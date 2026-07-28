import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CodexError from "../errors.ts";
import {
  captureCodexAppServerStderrReason,
  CODEX_APP_SERVER_STDERR_CAPTURE_LIMIT_BYTES,
  makeTerminationError,
} from "./stdio.ts";

describe("Codex App Server child process termination", () => {
  it.effect("retains the process identifier with the exit code", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(51),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9)),
      });

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.pid, 51);
      assert.equal(error.code, 9);
      assert.equal(error.message, "Codex App Server process exited with code 9");
    }),
  );

  it.effect("retains only a classified SQLite contention reason", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const capture = yield* captureCodexAppServerStderrReason(
          Stream.make(new TextEncoder().encode("fatal: database is locked: token=private")),
        );
        const reason = yield* capture.awaitReason;
        const error = yield* makeTerminationError(
          {
            pid: ChildProcessSpawner.ProcessId(53),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          },
          Effect.succeed(reason),
        );

        assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
        assert.equal(error.reason, "sqlite-contention");
        assert.notProperty(error, "stderr");
        assert.notInclude(error.message, "token=private");
      }),
    ),
  );

  it.effect("does not classify non-lock stderr or inspect beyond the bounded window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const prefix = new Uint8Array(CODEX_APP_SERVER_STDERR_CAPTURE_LIMIT_BYTES).fill(120);
        const capture = yield* captureCodexAppServerStderrReason(
          Stream.make(prefix, new TextEncoder().encode("SQLITE_BUSY")),
        );
        const reason = yield* capture.awaitReason;

        assert.isUndefined(reason);
      }),
    ),
  );

  it.effect("retains the process identifier and exact exit-status cause", () =>
    Effect.gen(function* () {
      const rootCause = new Error("private process diagnostics");
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: rootCause,
      });
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(52),
        exitCode: Effect.fail(cause),
      });

      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
      assert.equal(error.pid, 52);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Codex App Server transport operation 'read-process-exit-status' failed.",
      );
      assert.notInclude(error.message, rootCause.message);
    }),
  );
});
