import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  type SessionFabricCapabilityGrant,
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
  resolveSessionFabricGatewayRelayUrl,
  type SessionFabricGatewayCapabilityIssuer,
  sessionFabricGatewayWebSocketUrl,
} from "./gateway.ts";
import { TEST_NOW, TEST_SESSION_CONTEXT, TEST_SESSION_RECORD } from "./testFixtures.ts";

const issueCapability: SessionFabricGatewayCapabilityIssuer = async (input) => {
  const bindings =
    input.role === "viewer"
      ? {}
      : "environmentKind" in input
        ? {
            fabricSessionId: input.fabricSessionId,
            environmentKind: input.environmentKind,
            environmentId: input.environmentId,
            threadId: input.threadId,
          }
        : {
            fabricSessionId: input.fabricSessionId,
            scaffoldSessionId: input.scaffoldSessionId,
            scaffoldLifecycleEpoch: input.scaffoldLifecycleEpoch,
          };
  return {
    capability: `${input.role}.capability.signature`,
    tokenType: "Bearer",
    role: input.role,
    scopes:
      input.role === "viewer"
        ? ["directory:read", "session:read"]
        : ["session:read", "session:command"],
    expiresAt: "2026-07-24T20:05:00.000Z",
    issuer: "https://scaffold.example",
    audience: "https://relay.example",
    keyId: "test-key",
    bindings,
  } satisfies SessionFabricCapabilityGrant;
};
const decodeClientFrame = Schema.decodeUnknownSync(Schema.fromJsonString(SessionFabricClientFrame));
const encodeServerFrame = Schema.encodeSync(Schema.fromJsonString(SessionFabricServerFrame));

class TestWebSocket implements SessionFabricWebSocketLike {
  static resolveNext: ((socket: TestWebSocket) => void) | null = null;
  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  static next(): Promise<TestWebSocket> {
    return new Promise((resolve) => {
      TestWebSocket.resolveNext = resolve;
    });
  }

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    TestWebSocket.resolveNext?.(this);
    TestWebSocket.resolveNext = null;
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
  it("prefers the runtime Relay URL and falls back to the published CLI URL", () => {
    expect(
      resolveSessionFabricGatewayRelayUrl(
        new URL("https://runtime-relay.example/base/"),
        "https://build-relay.example/",
      )?.href,
    ).toBe("https://runtime-relay.example/base/");
    expect(
      resolveSessionFabricGatewayRelayUrl(null, "https://build-relay.example/base/")?.href,
    ).toBe("https://build-relay.example/base/");
    expect(resolveSessionFabricGatewayRelayUrl(null, "file:///tmp/relay")).toBeNull();
    expect(
      resolveSessionFabricGatewayRelayUrl(
        new URL("http://relay.example/runtime"),
        "https://build-relay.example/base/",
      )?.href,
    ).toBe("https://build-relay.example/base/");
    expect(
      resolveSessionFabricGatewayRelayUrl(
        new URL("file:///tmp/runtime-relay"),
        "https://build-relay.example/base/",
      )?.href,
    ).toBe("https://build-relay.example/base/");
    expect(
      resolveSessionFabricGatewayRelayUrl(
        new URL("https://user:password@runtime-relay.example/"),
        "https://build-relay.example/base/",
      )?.href,
    ).toBe("https://build-relay.example/base/");
    expect(resolveSessionFabricGatewayRelayUrl(null, "http://relay.example/build/")).toBeNull();
    expect(resolveSessionFabricGatewayRelayUrl(null, "http://localhost:8787/base/")?.href).toBe(
      "http://localhost:8787/base/",
    );
  });

  it.effect("allows disabled authorization only for canonical loopback URLs", () =>
    Effect.gen(function* () {
      let loopbackAuthorization: string | null | undefined;
      const loopbackGateway = makeSessionFabricGateway({
        relayBaseUrl: new URL("http://127.0.0.1:8787/"),
        authMode: "disabled",
        fetch: async (_input, init) => {
          loopbackAuthorization = new Headers(init?.headers).get("authorization");
          return Response.json({ results: [] });
        },
      });
      expect((yield* loopbackGateway.search({ query: "oauth", limit: 1 })).results).toEqual([]);
      expect(loopbackAuthorization).toBeNull();

      for (const relayBaseUrl of [
        new URL("https://relay.example/"),
        new URL("http://127.0.0.2:8787/"),
      ]) {
        let remoteFetchCalled = false;
        const remoteGateway = makeSessionFabricGateway({
          relayBaseUrl,
          authMode: "disabled",
          fetch: async () => {
            remoteFetchCalled = true;
            return Response.json({ results: [] });
          },
        });
        const error = yield* remoteGateway.search({ query: "oauth", limit: 1 }).pipe(Effect.flip);
        expect(error.detail).toBe(
          "Disabled session fabric authorization requires a loopback relay.",
        );
        expect(remoteFetchCalled).toBe(false);
      }
    }),
  );

  it.effect("searches and loads context through the configured Relay base path", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly url: string;
        readonly body: string;
        readonly authorization: string | null;
      }> = [];
      const signals: AbortSignal[] = [];
      const gateway = makeSessionFabricGateway({
        relayBaseUrl: new URL("https://relay.example/base/"),
        issueCapability,
        fetch: async (input, init) => {
          calls.push({
            url: String(input),
            body: String(init?.body),
            authorization: new Headers(init?.headers).get("authorization"),
          });
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
      expect(calls.map((call) => call.authorization)).toEqual([
        "Bearer viewer.capability.signature",
        "Bearer viewer.capability.signature",
      ]);
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    }),
  );

  it.effect("fails closed before a remote request when capability issuance is unavailable", () =>
    Effect.gen(function* () {
      let fetchCalled = false;
      const gateway = makeSessionFabricGateway({
        relayBaseUrl: new URL("https://relay.example/base/"),
        fetch: async () => {
          fetchCalled = true;
          return Response.json({ results: [] });
        },
      });

      const error = yield* gateway.search({ query: "oauth callback", limit: 5 }).pipe(Effect.flip);

      expect(error.detail).toBe("Session fabric capability authorization is not configured.");
      expect(fetchCalled).toBe(false);
    }),
  );

  it.effect("aborts an HTTP request when its bounded timeout expires", () =>
    Effect.gen(function* () {
      let signal: AbortSignal | undefined;
      const gateway = makeSessionFabricGateway({
        relayBaseUrl: new URL("https://relay.example/base/"),
        issueCapability,
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
          issueCapability,
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

        const socketCreated = TestWebSocket.next();
        const fiber = yield* gateway
          .submit({
            sessionId: TEST_SESSION_RECORD.sessionId,
            clientId: command.clientId,
            location: TEST_SESSION_RECORD.location,
            command,
          })
          .pipe(Effect.forkScoped);
        const socket = yield* Effect.promise(() => socketCreated);
        expect(socket.url).toBe(
          "wss://relay.example/base/v1/session-fabric/sessions/global-session-1/connect",
        );
        expect(socket.protocols).toEqual([
          "t3.session-fabric.v1",
          "t3.session-fabric.capability.controller.capability.signature",
        ]);
        socket.open();
        expect(socket.sent.map((frame) => decodeClientFrame(frame))).toMatchObject([
          { type: "client.hello", hello: { sessionId: TEST_SESSION_RECORD.sessionId } },
          { type: "command.submit", command: { commandId: command.commandId } },
        ]);
        socket.receive(
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
        expect(socket.onmessage).toBeNull();
        expect((yield* Fiber.join(fiber)).resultSequence).toBe(23);
      }),
    ),
  );

  it.effect("rejects a command receipt for another session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = makeSessionFabricGateway({
          relayBaseUrl: new URL("https://relay.example/base/"),
          issueCapability,
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

        const socketCreated = TestWebSocket.next();
        const fiber = yield* gateway
          .submit({
            sessionId: TEST_SESSION_RECORD.sessionId,
            clientId: command.clientId,
            location: TEST_SESSION_RECORD.location,
            command,
          })
          .pipe(Effect.forkScoped);
        const socket = yield* Effect.promise(() => socketCreated);
        socket.open();
        socket.receive(
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
        expect(socket.onmessage).toBeNull();

        const error = yield* Fiber.join(fiber).pipe(Effect.flip);
        expect(error.detail).toBe(
          "Session fabric returned a command receipt for a different session.",
        );
      }),
    ),
  );

  it.effect("rejects submit without an exact scaffold controller binding", () =>
    Effect.gen(function* () {
      const command = {
        sessionId: TEST_SESSION_RECORD.sessionId,
        commandId: CommandId.make("command-missing-binding"),
        clientId: SessionFabricClientId.make("client-1"),
        command: {
          type: "thread.archive",
          commandId: CommandId.make("command-missing-binding"),
          threadId: TEST_SESSION_RECORD.location.threadId,
        },
        submittedAt: TEST_NOW,
      } satisfies SessionFabricCommand;
      const gateway = makeSessionFabricGateway({
        relayBaseUrl: new URL("https://relay.example/"),
        issueCapability,
        webSocketConstructor: TestWebSocket,
      });

      const error = yield* gateway
        .submit({
          sessionId: command.sessionId,
          clientId: command.clientId,
          location: {
            ...TEST_SESSION_RECORD.location,
            environmentKind: "scaffold",
            scaffoldSessionId: null,
            scaffoldLifecycleEpoch: null,
          },
          command,
        })
        .pipe(Effect.flip);

      expect(error.detail).toBe(
        "Session fabric target does not have an exact controller capability binding.",
      );
    }),
  );

  it("rejects non-HTTP Relay URLs before opening a socket", () => {
    expect(
      sessionFabricGatewayWebSocketUrl(new URL("file:///tmp/relay"), TEST_SESSION_RECORD.sessionId),
    ).toBeNull();
  });
});
