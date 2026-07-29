#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as EffectAcpAgent from "effect-acp/agent";
import * as EffectAcpErrors from "effect-acp/errors";

const childId = process.env.T3_OMP_ACCOUNT_FIXTURE_CHILD_ID;
const statePath = process.env.T3_OMP_ACCOUNT_FIXTURE_STATE_PATH;
const requestLogPath = process.env.T3_OMP_ACCOUNT_FIXTURE_REQUEST_LOG_PATH;

if (!childId || !statePath || !requestLogPath) {
  throw new Error("OMP account fixture environment is incomplete");
}

const fixtureChildId = childId;
const fixtureStatePath = statePath;
const fixtureRequestLogPath = requestLogPath;

const flowId = "fixture-oauth-flow";
const account = {
  accountRef: "acct_fixture_openai",
  provider: "openai-codex",
  type: "oauth",
  email: "fixture@example.test",
  state: "available",
};

function record(method: string): void {
  NodeFS.appendFileSync(
    fixtureRequestLogPath,
    `${JSON.stringify({ childId: fixtureChildId, method })}\n`,
    "utf8",
  );
}

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;

  yield* agent.handleInitialize(() =>
    Effect.succeed({ protocolVersion: 1, agentCapabilities: {} }),
  );
  yield* agent.handleAuthenticate(() => Effect.succeed({}));
  yield* agent.handleCreateSession(() => Effect.succeed({ sessionId: "fixture-session" }));
  yield* agent.handleUnknownExtRequest((method, params) => {
    record(method);
    switch (method) {
      case "_omp/accounts/list":
        return Effect.succeed({
          accounts: NodeFS.existsSync(fixtureStatePath) ? [account] : [],
        });
      case "_omp/accounts/login":
        return Effect.succeed({
          flowId,
          kind: "browser",
          url: "https://accounts.example.test/oauth",
        });
      case "_omp/accounts/login/respond": {
        const requestedFlowId =
          typeof params === "object" && params !== null && "flowId" in params
            ? params.flowId
            : undefined;
        if (requestedFlowId !== flowId) {
          return Effect.fail(EffectAcpErrors.AcpRequestError.invalidParams("unknown flow"));
        }
        NodeFS.writeFileSync(fixtureStatePath, JSON.stringify(account), "utf8");
        return Effect.succeed({ flowId, kind: "complete", outcome: "success" });
      }
      case "_omp/accounts/login/cancel":
        return NodeFS.existsSync(fixtureStatePath)
          ? Effect.fail(EffectAcpErrors.AcpRequestError.invalidParams("flow already completed"))
          : Effect.succeed({});
      default:
        return Effect.fail(EffectAcpErrors.AcpRequestError.methodNotFound(method));
    }
  });

  return yield* Effect.never;
}).pipe(
  Effect.provide(EffectAcpAgent.layerStdio()),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program);
