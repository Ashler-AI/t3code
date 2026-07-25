import * as Effect from "effect/Effect";
import type { ThreadId } from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SessionReferenceAuthority from "./authority.ts";
import { SessionReferenceToolkit } from "./tools.ts";

const capabilityFailure = (
  operation: "resolve" | "send",
  scope: McpInvocationContext.McpInvocationScope,
  targetThreadId: ThreadId,
) =>
  new SessionReferenceAuthority.SessionReferenceToolError({
    operation,
    reason: "capability_denied",
    sourceThreadId: scope.threadId,
    targetThreadId,
  });

const handlers = {
  session_reference_resolve: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (!scope.capabilities.has("session_reference_read")) {
        return yield* capabilityFailure("resolve", scope, input.threadId);
      }
      const authority = yield* SessionReferenceAuthority.SessionReferenceAuthority;
      return yield* authority.resolve(scope, input.threadId);
    }),
  session_message_send: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (!scope.capabilities.has("session_message_send")) {
        return yield* capabilityFailure("send", scope, input.threadId);
      }
      const authority = yield* SessionReferenceAuthority.SessionReferenceAuthority;
      return yield* authority.send(scope, input.threadId, input.message);
    }),
} satisfies Parameters<typeof SessionReferenceToolkit.toLayer>[0];

export const SessionReferenceToolkitHandlersLive = SessionReferenceToolkit.toLayer(handlers);
