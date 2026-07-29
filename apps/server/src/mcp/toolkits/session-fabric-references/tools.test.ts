import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  SessionFabricSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SessionFabricReferenceAuthority from "./authority.ts";
import { TEST_SESSION_CONTEXT, TEST_SESSION_RECORD } from "./testFixtures.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-tools"),
  threadId: ThreadId.make("thread-source"),
  providerSessionId: "provider-session-tools",
  providerInstanceId: ProviderInstanceId.make("omp-primary"),
  capabilities: new Set(["session_fabric_read"]),
  issuedAt: 1,
};
const authority = SessionFabricReferenceAuthority.SessionFabricReferenceAuthority.of({
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
  send: (_scope, sessionId) =>
    Effect.succeed({
      sessionId,
      targetEnvironmentId: TEST_SESSION_RECORD.location.environmentId,
      targetThreadId: TEST_SESSION_RECORD.location.threadId,
      resultSequence: 1,
    }),
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "session-fabric-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.SessionFabricReferenceToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    Layer.succeed(SessionFabricReferenceAuthority.SessionFabricReferenceAuthority, authority),
  ),
);

it.effect("registers distinct global search/context/send tools with independent capabilities", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const sendTool = server.tools.find(({ tool }) => tool.name === "session_fabric_message_send");
    expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
      "session_fabric_context",
      "session_fabric_message_send",
      "session_fabric_search",
    ]);
    expect(sendTool?.tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(sendTool?.tool.description).toContain("executes as a new user turn on the remote");

    const search = yield* server
      .callTool({
        name: "session_fabric_search",
        arguments: { query: "oauth callback", limit: 5 },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(search.isError).toBe(false);
    expect(search.structuredContent).toMatchObject({
      results: [{ session: { sessionId: TEST_SESSION_RECORD.sessionId } }],
    });

    const context = yield* server
      .callTool({
        name: "session_fabric_context",
        arguments: {
          sessionId: TEST_SESSION_RECORD.sessionId,
          includeCodeDiff: true,
          includeContinuation: true,
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(context.isError).toBe(false);
    expect(context.structuredContent).toMatchObject({
      continuationRef: `session-fabric:${TEST_SESSION_RECORD.sessionId}`,
    });

    const deniedSend = yield* server
      .callTool({
        name: "session_fabric_message_send",
        arguments: {
          sessionId: SessionFabricSessionId.make("global-session-1"),
          message: "continue",
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(deniedSend.isError).toBe(true);
    expect(deniedSend.structuredContent).toEqual({
      error: {
        _tag: "SessionFabricReferenceToolError",
        operation: "send",
        reason: "capability_denied",
      },
    });
  }).pipe(Effect.provide(TestLayer)),
);
