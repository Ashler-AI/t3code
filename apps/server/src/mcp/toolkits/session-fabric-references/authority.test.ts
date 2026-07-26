import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  SessionFabricSessionId,
  ThreadId,
  type SessionFabricCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SESSION_FABRIC_MESSAGE_MAX_CHARS, make } from "./authority.ts";
import * as SessionFabricGateway from "./gateway.ts";
import { TEST_NOW, TEST_SESSION_CONTEXT, TEST_SESSION_RECORD } from "./testFixtures.ts";

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-local"),
  threadId: ThreadId.make("thread-source"),
  providerSessionId: "provider-session-source",
  providerInstanceId: ProviderInstanceId.make("omp-primary"),
  capabilities: new Set(["session_fabric_read", "session_fabric_send"]),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

const makeAuthority = (
  commands: SessionFabricCommand[],
  overrides: Partial<SessionFabricGateway.SessionFabricGatewayShape> = {},
) =>
  make.pipe(
    Effect.provideService(
      SessionFabricGateway.SessionFabricGateway,
      SessionFabricGateway.SessionFabricGateway.of({
        search: () =>
          Effect.succeed({
            results: [
              {
                session: TEST_SESSION_RECORD,
                score: 0.91,
                matchText: TEST_SESSION_RECORD.searchableText,
              },
            ],
          }),
        context: () => Effect.succeed(TEST_SESSION_CONTEXT),
        submit: ({ command }) =>
          Effect.sync(() => {
            commands.push(command);
            return {
              sessionId: command.sessionId,
              commandId: command.commandId,
              status: "accepted" as const,
              resultSequence: 42,
              detail: null,
              updatedAt: TEST_NOW,
            };
          }),
        ...overrides,
      }),
    ),
    Effect.provide(NodeServices.layer),
  );

describe("SessionFabricReferenceAuthority", () => {
  it.effect("searches and reads context by global fabric session id", () =>
    Effect.gen(function* () {
      const authority = yield* makeAuthority([]);
      expect(
        (yield* authority.search(scope, "oauth callback", 5)).results[0]?.session.sessionId,
      ).toBe(TEST_SESSION_RECORD.sessionId);
      expect(
        (yield* authority.context(scope, TEST_SESSION_RECORD.sessionId, true, true))
          .continuationRef,
      ).toBe(`session-fabric:${TEST_SESSION_RECORD.sessionId}`);
    }),
  );

  it.effect("sends to the remote snapshot thread without invoking local thread authority", () =>
    Effect.gen(function* () {
      const commands: SessionFabricCommand[] = [];
      const authority = yield* makeAuthority(commands);
      const result = yield* authority.send(
        scope,
        SessionFabricSessionId.make("global-session-1"),
        "Please continue the fix.",
      );

      expect(result).toEqual({
        sessionId: TEST_SESSION_RECORD.sessionId,
        targetEnvironmentId: TEST_SESSION_RECORD.location.environmentId,
        targetThreadId: TEST_SESSION_RECORD.location.threadId,
        resultSequence: 42,
      });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        sessionId: TEST_SESSION_RECORD.sessionId,
        command: {
          type: "thread.turn.start",
          threadId: TEST_SESSION_RECORD.location.threadId,
          runtimeMode: "full-access",
          interactionMode: "default",
          message: {
            role: "user",
            text: `[Message from agent session ${scope.threadId} through session fabric]\n\nPlease continue the fix.`,
          },
        },
      });
    }),
  );

  it.effect("rejects sending to the invoking environment and thread", () =>
    Effect.gen(function* () {
      const commands: SessionFabricCommand[] = [];
      const selfContext = {
        ...TEST_SESSION_CONTEXT,
        session: {
          ...TEST_SESSION_CONTEXT.session,
          location: {
            ...TEST_SESSION_CONTEXT.session.location,
            environmentId: scope.environmentId,
            threadId: scope.threadId,
          },
        },
        snapshot: {
          ...TEST_SESSION_CONTEXT.snapshot,
          session: {
            ...TEST_SESSION_CONTEXT.snapshot.session,
            location: {
              ...TEST_SESSION_CONTEXT.snapshot.session.location,
              environmentId: scope.environmentId,
              threadId: scope.threadId,
            },
          },
          thread: {
            ...TEST_SESSION_CONTEXT.snapshot.thread,
            thread: {
              ...TEST_SESSION_CONTEXT.snapshot.thread.thread,
              id: scope.threadId,
            },
          },
        },
      };
      const authority = yield* makeAuthority(commands, {
        context: () => Effect.succeed(selfContext),
      });

      const error = yield* authority
        .send(scope, TEST_SESSION_RECORD.sessionId, "Please continue the fix.")
        .pipe(Effect.flip);

      expect(error.reason).toBe("self_reference");
      expect(commands).toEqual([]);
    }),
  );

  it.effect("rejects context whose snapshot location does not match its session location", () =>
    Effect.gen(function* () {
      const mismatchedLocation = {
        ...TEST_SESSION_CONTEXT,
        snapshot: {
          ...TEST_SESSION_CONTEXT.snapshot,
          thread: {
            ...TEST_SESSION_CONTEXT.snapshot.thread,
            thread: {
              ...TEST_SESSION_CONTEXT.snapshot.thread.thread,
              id: ThreadId.make("thread-from-another-location"),
            },
          },
        },
      };
      const authority = yield* makeAuthority([], {
        context: () => Effect.succeed(mismatchedLocation),
      });

      const error = yield* authority
        .context(scope, TEST_SESSION_RECORD.sessionId, true, true)
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        reason: "relay_unavailable",
        sessionId: TEST_SESSION_RECORD.sessionId,
      });
    }),
  );

  it.effect("rejects context whose bundle or snapshot identifies a different session", () =>
    Effect.gen(function* () {
      const otherSessionId = SessionFabricSessionId.make("global-session-other");
      const mismatchedBundle = {
        ...TEST_SESSION_CONTEXT,
        session: { ...TEST_SESSION_CONTEXT.session, sessionId: otherSessionId },
      };
      const mismatchedSnapshot = {
        ...TEST_SESSION_CONTEXT,
        snapshot: {
          ...TEST_SESSION_CONTEXT.snapshot,
          session: { ...TEST_SESSION_CONTEXT.snapshot.session, sessionId: otherSessionId },
        },
      };
      const bundleAuthority = yield* makeAuthority([], {
        context: () => Effect.succeed(mismatchedBundle),
      });
      const snapshotAuthority = yield* makeAuthority([], {
        context: () => Effect.succeed(mismatchedSnapshot),
      });

      const bundleError = yield* bundleAuthority
        .context(scope, TEST_SESSION_RECORD.sessionId, true, true)
        .pipe(Effect.flip);
      const snapshotError = yield* snapshotAuthority
        .context(scope, TEST_SESSION_RECORD.sessionId, true, true)
        .pipe(Effect.flip);

      expect(bundleError).toMatchObject({
        reason: "relay_unavailable",
        sessionId: TEST_SESSION_RECORD.sessionId,
      });
      expect(snapshotError).toMatchObject({
        reason: "relay_unavailable",
        sessionId: TEST_SESSION_RECORD.sessionId,
      });
    }),
  );

  it.effect("rejects a command receipt for a different session", () =>
    Effect.gen(function* () {
      const commands: SessionFabricCommand[] = [];
      const authority = yield* makeAuthority(commands, {
        submit: ({ command }) =>
          Effect.succeed({
            sessionId: SessionFabricSessionId.make("global-session-other"),
            commandId: command.commandId,
            status: "accepted",
            resultSequence: 42,
            detail: null,
            updatedAt: TEST_NOW,
          }),
      });

      const error = yield* authority
        .send(scope, TEST_SESSION_RECORD.sessionId, "Please continue the fix.")
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        reason: "dispatch_rejected",
        sessionId: TEST_SESSION_RECORD.sessionId,
      });
      expect(commands).toEqual([]);
    }),
  );

  it.effect("rejects oversized messages before contacting the runner", () =>
    Effect.gen(function* () {
      const commands: SessionFabricCommand[] = [];
      const authority = yield* makeAuthority(commands);
      const error = yield* authority
        .send(
          scope,
          TEST_SESSION_RECORD.sessionId,
          "x".repeat(SESSION_FABRIC_MESSAGE_MAX_CHARS + 1),
        )
        .pipe(Effect.flip);
      expect(error.reason).toBe("message_too_long");
      expect(commands).toEqual([]);
    }),
  );
});
