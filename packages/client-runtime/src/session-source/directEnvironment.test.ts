import {
  EnvironmentId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { ShellSnapshotLoader } from "../state/shellSnapshotHttp.ts";
import { ThreadSnapshotLoader } from "../state/threadSnapshotHttp.ts";
import { makeDirectEnvironmentUiSessionSource } from "./directEnvironment.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

describe("direct environment UI session source", () => {
  it.effect("lists threads and sessions from the authoritative shell snapshot", () =>
    Effect.gen(function* () {
      const activeThread = {
        id: "active-thread",
        session: { id: "session-1" },
      } as unknown as OrchestrationThreadShell;
      const inactiveThread = {
        id: "inactive-thread",
        session: null,
      } as unknown as OrchestrationThreadShell;
      const snapshot = {
        snapshotSequence: 7,
        projects: [],
        threads: [activeThread, inactiveThread],
        updatedAt: "2026-06-06T00:00:00.000Z",
      } satisfies OrchestrationShellSnapshot;
      const loader = ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.some(snapshot)),
      });
      const source = makeDirectEnvironmentUiSessionSource({
        shellSnapshotLoader: loader,
        threadSnapshotLoader: ThreadSnapshotLoader.of({
          load: () => Effect.succeed(Option.none()),
        }),
      });

      const threads = yield* source.listThreads(PREPARED);
      const sessions = yield* source.listSessions(PREPARED);

      expect(Option.getOrThrow(threads)).toEqual([activeThread, inactiveThread]);
      expect(Option.getOrThrow(sessions)).toEqual([
        { thread: activeThread, session: activeThread.session },
      ]);
    }),
  );

  it.effect("preserves a missing authoritative snapshot in listing results", () =>
    Effect.gen(function* () {
      const loader = ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.none()),
      });
      const source = makeDirectEnvironmentUiSessionSource({
        shellSnapshotLoader: loader,
        threadSnapshotLoader: ThreadSnapshotLoader.of({
          load: () => Effect.succeed(Option.none()),
        }),
      });

      const threads = yield* source.listThreads(PREPARED);
      const sessions = yield* source.listSessions(PREPARED);

      expect(Option.isNone(threads)).toBe(true);
      expect(Option.isNone(sessions)).toBe(true);
    }),
  );
});
