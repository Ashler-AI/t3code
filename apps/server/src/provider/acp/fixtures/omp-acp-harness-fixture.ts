#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

const sessionId = "omp-compat-session";
const fixtureMode = process.env.T3_OMP_ACP_FIXTURE_MODE ?? "success";

const configOptions: ReadonlyArray<AcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "openai/gpt-5.6",
    options: [{ value: "openai/gpt-5.6", name: "GPT-5.6" }],
  },
  {
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [{ value: "high", name: "High" }],
  },
  {
    id: "advisor",
    name: "Advisor",
    category: "model",
    type: "select",
    currentValue: "off",
    options: [{ value: "off", name: "Off" }],
  },
];

function setupResponse() {
  return { sessionId, configOptions };
}

function writeReplayUpdate(
  requestedSessionId: string,
  update: AcpSchema.SessionNotification["update"],
): void {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        _meta: { isReplay: true },
        sessionId: requestedSessionId,
        update,
      },
    })}\n`,
  );
}

/**
 * OMP currently exposes shell execution as an ACP tool-call lifecycle. This is
 * the supported terminal-equivalent fixture boundary: `tool_call` / update,
 * `kind="execute"`, `title="Terminal"`, and raw input/output. Native ACP
 * terminal create/output/wait/release events are intentionally not assumed
 * until OMP exposes that lifecycle.
 */
function emitCanonicalReplay(requestedSessionId: string): void {
  writeReplayUpdate(requestedSessionId, {
    sessionUpdate: "agent_thought_chunk",
    messageId: "fixture-reasoning",
    content: { type: "text", text: "fixture reasoning" },
  });
  writeReplayUpdate(requestedSessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "fixture-command",
    title: "Terminal",
    kind: "execute",
    status: "pending",
    rawInput: { command: ["printf", "fixture-output"] },
  });
  writeReplayUpdate(requestedSessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "fixture-command",
    status: "in_progress",
  });
  writeReplayUpdate(requestedSessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "fixture-command",
    status: "completed",
    rawOutput: { exitCode: 0, stdout: "fixture-output", stderr: "" },
  });
  writeReplayUpdate(requestedSessionId, {
    sessionUpdate: "agent_message_chunk",
    messageId: "fixture-assistant",
    content: { type: "text", text: "fixture assistant output" },
  });
}

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;

  yield* agent.handleInitialize(() =>
    Effect.succeed({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    }),
  );
  yield* agent.handleAuthenticate(() => Effect.succeed({}));
  yield* agent.handleCreateSession(() => Effect.succeed(setupResponse()));
  yield* agent.handleLoadSession((request) =>
    Effect.sync(() => {
      emitCanonicalReplay(String(request.sessionId ?? sessionId));
      return { configOptions };
    }),
  );
  yield* agent.handleSetSessionConfigOption(() => Effect.succeed({ configOptions }));
  yield* agent.handleCancel(() => Effect.void);

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      if (fixtureMode === "error") {
        return yield* AcpError.AcpRequestError.internalError(
          "Deterministic OMP compatibility fixture failure",
        );
      }

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: "fixture-reasoning",
          content: { type: "text", text: "fixture reasoning" },
        },
      });
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "fixture-command",
          title: "Terminal",
          kind: "execute",
          status: "pending",
          rawInput: { command: ["printf", "fixture-output"] },
        },
      });
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "fixture-command",
          status: "in_progress",
        },
      });
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "fixture-command",
          status: "completed",
          rawOutput: { exitCode: 0, stdout: "fixture-output", stderr: "" },
        },
      });

      yield* agent.client.elicit({
        mode: "form",
        sessionId: requestedSessionId,
        message: "Choose the fixture scope.",
        requestedSchema: {
          type: "object",
          title: "Fixture input",
          properties: {
            scope: {
              type: "string",
              description: "Which scope should the fixture use?",
              enum: ["workspace", "session"],
            },
          },
          required: ["scope"],
        },
      });

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "fixture-assistant",
          content: { type: "text", text: "fixture assistant output" },
        },
      });
      return { stopReason: "end_turn" as const };
    }),
  );

  return yield* Effect.never;
});

program.pipe(
  Effect.provide(Layer.provide(EffectAcpAgent.layerStdio(), NodeServices.layer)),
  NodeRuntime.runMain,
);
