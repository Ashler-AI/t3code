import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ScaffoldLifecycleAction,
  normalizeScaffoldControlPlaneBaseUrl,
  scaffoldCreateParametersForModelSelection,
} from "./model.ts";
import { makeScaffoldLifecycleAction } from "./outbox.ts";

const decodeScaffoldLifecycleAction = Schema.decodeUnknownSync(ScaffoldLifecycleAction);

describe("Scaffold lifecycle model", () => {
  it("binds an OMP OpenAI selection to the logical Scaffold route and effort", () => {
    expect(
      scaffoldCreateParametersForModelSelection({
        instanceId: ProviderInstanceId.make("omp"),
        model: "openai/gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
    ).toEqual({
      modelRouteId: "scaffold-openai/gpt-5.6-sol",
      agentEffort: "high",
    });
    expect(
      scaffoldCreateParametersForModelSelection({
        instanceId: ProviderInstanceId.make("omp"),
        model: "openai-codex/gpt-5.6-sol",
      }),
    ).toEqual({ modelRouteId: "scaffold-openai/gpt-5.6-sol" });
    expect(
      scaffoldCreateParametersForModelSelection({
        instanceId: ProviderInstanceId.make("omp"),
        model: "anthropic/claude-sonnet-5",
      }),
    ).toEqual({ modelRouteId: "anthropic/claude-sonnet-5" });
    expect(
      scaffoldCreateParametersForModelSelection({
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      }),
    ).toBeNull();
  });

  it("normalizes only credential-free HTTPS origins without echoing rejected input", () => {
    expect(normalizeScaffoldControlPlaneBaseUrl(" https://scaffold.example.com ")).toBe(
      "https://scaffold.example.com/",
    );
    const secretUrl = "https://user:secret@scaffold.example.com/path?token=private#fragment";
    expect(() => normalizeScaffoldControlPlaneBaseUrl(secretUrl)).toThrow(
      "Invalid Scaffold control-plane URL.",
    );
    try {
      normalizeScaffoldControlPlaneBaseUrl(secretUrl);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
      expect(String(error)).not.toContain("private");
    }
  });

  it("persists create parameters only on create actions and strips credentials", () => {
    const action = decodeScaffoldLifecycleAction({
      ...makeScaffoldLifecycleAction({
        actionId: "operation-1",
        kind: "create",
        deployment: "production",
        draftId: "draft-operation-1",
        sourceEnvironmentId: EnvironmentId.make("source-environment-1"),
        sourceProjectId: ProjectId.make("source-project-1"),
        environmentId: EnvironmentId.make("env-1"),
        connectionId: "connection-1",
        sessionId: "session-1",
        expectedLifecycleEpoch: 0,
        createdAt: "2026-07-24T19:00:00.000Z",
        create: {
          sourceRef: "main",
          snapshotId: "snapshot-1",
          name: "Agent",
          modelRouteId: "scaffold-openai/gpt-5.6-sol",
          agentEffort: "high",
        },
      }),
      token: "must-not-persist",
    });

    expect(action.kind).toBe("create");
    if (action.kind !== "create") throw new Error("expected create action");
    expect(action.create).toEqual({
      sourceRef: "main",
      snapshotId: "snapshot-1",
      name: "Agent",
      modelRouteId: "scaffold-openai/gpt-5.6-sol",
      agentEffort: "high",
    });
    expect(action.deployment).toBe("production");
    expect(action).toMatchObject({
      draftId: "draft-operation-1",
      sourceEnvironmentId: "source-environment-1",
      sourceProjectId: "source-project-1",
    });
    expect(action).not.toHaveProperty("token");
  });

  it("rejects create actions without their discriminated create payload", () => {
    expect(() =>
      decodeScaffoldLifecycleAction({
        ...makeScaffoldLifecycleAction({
          actionId: "operation-2",
          kind: "resume",
          environmentId: EnvironmentId.make("env-1"),
          connectionId: "connection-1",
          sessionId: "session-1",
          expectedLifecycleEpoch: 1,
          createdAt: "2026-07-24T19:00:00.000Z",
        }),
        kind: "create",
      }),
    ).toThrow();
  });

  it("requires the native source thread on durable pause intents", () => {
    const pause = makeScaffoldLifecycleAction({
      actionId: "pause-operation-1",
      kind: "pause",
      sourceThreadId: ThreadId.make("thread-1"),
      environmentId: EnvironmentId.make("env-1"),
      connectionId: "connection-1",
      sessionId: "session-1",
      expectedLifecycleEpoch: 1,
      createdAt: "2026-07-29T19:00:00.000Z",
    });

    expect(decodeScaffoldLifecycleAction(pause)).toMatchObject({
      kind: "pause",
      sourceThreadId: "thread-1",
    });
    const legacyPause = structuredClone(pause);
    Reflect.deleteProperty(legacyPause, "sourceThreadId");
    expect(() => decodeScaffoldLifecycleAction(legacyPause)).toThrow();
  });
});
