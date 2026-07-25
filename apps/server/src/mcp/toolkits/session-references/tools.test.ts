import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SessionReferenceAuthority from "./authority.ts";

const environmentId = EnvironmentId.make("environment-tools");
const sourceThreadId = ThreadId.make("thread-source");
const targetThreadId = ThreadId.make("thread-target");
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId: sourceThreadId,
  providerSessionId: "provider-session-tools",
  providerInstanceId: ProviderInstanceId.make("omp-primary"),
  capabilities: new Set(["session_reference_read"]),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const authority = SessionReferenceAuthority.SessionReferenceAuthority.of({
  resolve: (_scope, threadId) =>
    Effect.succeed({
      environmentId,
      threadId,
      projectId: ProjectId.make("project-1"),
      title: "Target",
      rootPath: "/authoritative/root",
      branch: null,
    }),
  send: (_scope, threadId) =>
    Effect.succeed({
      environmentId,
      sourceThreadId,
      targetThreadId: threadId,
      sequence: 1,
    }),
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "session-reference-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.SessionReferenceToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(Layer.succeed(SessionReferenceAuthority.SessionReferenceAuthority, authority)),
);

it.effect("registers independently authorized read and send session tools", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const resolveTool = server.tools.find(({ tool }) => tool.name === "session_reference_resolve");
    const sendTool = server.tools.find(({ tool }) => tool.name === "session_message_send");

    expect(resolveTool?.tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(sendTool?.tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });

    const resolved = yield* server
      .callTool({
        name: "session_reference_resolve",
        arguments: { threadId: targetThreadId },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(resolved.isError).toBe(false);
    expect(resolved.structuredContent).toMatchObject({
      threadId: targetThreadId,
      rootPath: "/authoritative/root",
    });

    const rejectedSend = yield* server
      .callTool({
        name: "session_message_send",
        arguments: { threadId: targetThreadId, message: "hello" },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(rejectedSend.isError).toBe(true);
    expect(rejectedSend.content).toEqual([
      { type: "text", text: "Session reference send failed: capability_denied." },
    ]);
    expect(rejectedSend.structuredContent).toEqual({
      error: {
        _tag: "SessionReferenceToolError",
        operation: "send",
        reason: "capability_denied",
      },
    });
  }).pipe(Effect.provide(TestLayer)),
);
