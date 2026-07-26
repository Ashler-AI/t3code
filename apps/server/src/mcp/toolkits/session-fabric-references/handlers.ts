import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SessionFabricReferenceAuthority from "./authority.ts";
import { SessionFabricReferenceToolkit } from "./tools.ts";

const handlers = {
  session_fabric_search: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (!scope.capabilities.has("session_fabric_read")) {
        return yield* new SessionFabricReferenceAuthority.SessionFabricReferenceToolError({
          operation: "search",
          reason: "capability_denied",
          sourceThreadId: scope.threadId,
          sessionId: null,
          detail: null,
        });
      }
      const authority = yield* SessionFabricReferenceAuthority.SessionFabricReferenceAuthority;
      return yield* authority.search(scope, input.query, input.limit);
    }),
  session_fabric_context: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (!scope.capabilities.has("session_fabric_read")) {
        return yield* new SessionFabricReferenceAuthority.SessionFabricReferenceToolError({
          operation: "context",
          reason: "capability_denied",
          sourceThreadId: scope.threadId,
          sessionId: input.sessionId,
          detail: null,
        });
      }
      const authority = yield* SessionFabricReferenceAuthority.SessionFabricReferenceAuthority;
      return yield* authority.context(
        scope,
        input.sessionId,
        input.includeCodeDiff,
        input.includeContinuation,
      );
    }),
  session_fabric_message_send: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (!scope.capabilities.has("session_fabric_send")) {
        return yield* new SessionFabricReferenceAuthority.SessionFabricReferenceToolError({
          operation: "send",
          reason: "capability_denied",
          sourceThreadId: scope.threadId,
          sessionId: input.sessionId,
          detail: null,
        });
      }
      const authority = yield* SessionFabricReferenceAuthority.SessionFabricReferenceAuthority;
      return yield* authority.send(scope, input.sessionId, input.message);
    }),
} satisfies Parameters<typeof SessionFabricReferenceToolkit.toLayer>[0];

export const SessionFabricReferenceToolkitHandlersLive =
  SessionFabricReferenceToolkit.toLayer(handlers);
