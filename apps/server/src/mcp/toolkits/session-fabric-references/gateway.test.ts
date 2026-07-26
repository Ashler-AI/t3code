import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  SessionFabricClientFrame,
  SessionFabricClientId,
  SessionFabricSessionId,
  SessionFabricServerFrame,
  type SessionFabricCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import {
  makeSessionFabricGateway,
  type SessionFabricWebSocketLike,
  sessionFabricGatewayWebSocketUrl,
} from "./gateway.ts";
import { TEST_NOW, TEST_SESSION_CONTEXT, TEST_SESSION_RECORD } from "./testFixtures.ts";

const decodeClientFrame = Schema.decodeUnknownSync(Schema.fromJsonString(SessionFabricClientFrame));
const encodeServerFrame = Schema.encodeSync(Schema.fromJsonString(SessionFabricServerFrame));

class TestWebSocket implements SessionFabricWebSocketLike {
  static last: TestWebSocket | null = null;
  readonly url: string;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    TestWebSocket.last = this;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {}

  open() {
    this.onopen?.();
  }

  receive(data: string) {
    this.onmessage?.({ data });
  }
}

describe("SessionFabricGateway", () => {
  it.effect("searches and loads context through the configured Relay base path", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly body: string }> = [];
      const signals: AbortSignal[] = [];
      const gateway = makeSessionFabricGateway({
        relayBaseUrl: new URL("https://relay.example/base/"),
        fetch: async (input, init) => {
          calls.push({ url: String(input), body: String(init?.body) });
          if (init?.signal) signals.push(init.signal);
          return String(input).endsWith("/search")
            ? Response.json({
                results: [
                  {
                    session: TEST_SESSION_RECORD,
                    score: 0.91,
                    matchText: TEST_SESSION_RECORD.searchableText,
                  },
                ],
              })
            : Response.json(TEST_SESSION_CONTEXT);
        },
      });

      const search = yield* gateway.search({ query: "oauth callback", limit: 5 });
      const context = yield* gateway.context({
        sessionId: TEST_SESSION_RECORD.sessionId,
        includeCodeDiff: true,
        includeContinuation: true,
      });

      expect(search.results[0]?.session.sessionId).toBe(TEST_SESSION_RECORD.sessionId);
      expect(context.codeDiff).toContain("auth.ts");
      expect(calls.map((call) => call.url)).toEqual([
        "https://relay.example/base/v1/session-fabric/search",
        "https://relay.example/base/v1/session-fabric/context",
      ]);
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    }),
  );

  it.effect("aborts an HTTP request when its bounded timeout expires", () =>
    Effect.gen(function* () {
      let signal: AbortSignal | undefined;
      const gateway = makeSessionFabricGateway({
        relayBaseUrl: new URL("https://relay.example/base/"),
        requestTimeoutMs: 10,
        fetch: (_input, init) => {
          signal = init?.signal ?? undefined;
          return new Promise<Response>(() => undefined);
        },
      });

      const error = yield* gateway.search({ query: "oauth callback", limit: 5 }).pipe(Effect.flip);

      expect(error.detail).toBe("Session fabric request timed out.");
      expect(signal?.aborted).toBe(true);
    }),
  );

  it.effect("submits a global-session command and preserves the accepted result sequence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = makeSessionFabricGateway({
          relayBaseUrl: new URL("https://relay.example/base/"),
          webSocketConstructor: TestWebSocket,
          now: () => TEST_NOW,
        });
        const command = {
          sessionId: TEST_SESSION_RECORD.sessionId,
          commandId: CommandId.make("command-1"),
          clientId: SessionFabricClientId.make("client-1"),
          command: {
            type: "thread.archive",
            commandId: CommandId.make("command-1"),
            threadId: TEST_SESSION_RECORD.location.threadId,
          },
          submittedAt: TEST_NOW,
        } satisfies SessionFabricCommand;

        const fiber = yield* gateway
          .submit({
            sessionId: TEST_SESSION_RECORD.sessionId,
            clientId: command.clientId,
            command,
          })
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        const socket = TestWebSocket.last;
        expect(socket).not.toBeNull();
        expect(socket?.url).toBe(
          "wss://relay.example/base/v1/session-fabric/sessions/global-session-1/connect",
        );
        socket?.open();
        expect(socket?.sent.map((frame) => decodeClientFrame(frame))).toMatchObject([
          { type: "client.hello", hello: { sessionId: TEST_SESSION_RECORD.sessionId } },
          { type: "command.submit", command: { commandId: command.commandId } },
        ]);
        socket?.receive(
          encodeServerFrame({
            type: "command.receipt",
            receipt: {
              sessionId: TEST_SESSION_RECORD.sessionId,
              commandId: command.commandId,
              status: "accepted",
              resultSequence: 23,
              detail: null,
              updatedAt: TEST_NOW,
            },
          }),
        );
        expect((yield* Fiber.join(fiber)).resultSequence).toBe(23);
      }),
    ),
  );

  it.effect("rejects a command receipt for another session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = makeSessionFabricGateway({
          relayBaseUrl: new URL("https://relay.example/base/"),
          webSocketConstructor: TestWebSocket,
          now: () => TEST_NOW,
        });
        const command = {
          sessionId: TEST_SESSION_RECORD.sessionId,
          commandId: CommandId.make("command-mismatched-session"),
          clientId: SessionFabricClientId.make("client-1"),
          command: {
            type: "thread.archive",
            commandId: CommandId.make("command-mismatched-session"),
            threadId: TEST_SESSION_RECORD.location.threadId,
          },
          submittedAt: TEST_NOW,
        } satisfies SessionFabricCommand;

        const fiber = yield* gateway
          .submit({
            sessionId: TEST_SESSION_RECORD.sessionId,
            clientId: command.clientId,
            command,
          })
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        const socket = TestWebSocket.last;
        socket?.open();
        socket?.receive(
          encodeServerFrame({
            type: "command.receipt",
            receipt: {
              sessionId: SessionFabricSessionId.make("global-session-other"),
              commandId: command.commandId,
              status: "accepted",
              resultSequence: 23,
              detail: null,
              updatedAt: TEST_NOW,
            },
          }),
        );

        const error = yield* Fiber.join(fiber).pipe(Effect.flip);
        expect(error.detail).toBe(
          "Session fabric returned a command receipt for a different session.",
        );
      }),
    ),
  );

  it("rejects non-HTTP Relay URLs before opening a socket", () => {
    expect(
      sessionFabricGatewayWebSocketUrl(new URL("file:///tmp/relay"), TEST_SESSION_RECORD.sessionId),
    ).toBeNull();
  });
});
