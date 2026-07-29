import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyOmpAcpSelection,
  applyOmpAdvisorSelection,
  assertManagedScaffoldOmpModelAllowed,
  buildOmpSkillsFromAvailableCommands,
  buildOmpAcpSpawnInput,
  filterManagedScaffoldOmpModelSlugs,
  currentOmpModelIdFromSessionSetup,
  currentOmpAdvisorIdFromSessionSetup,
  ompModelSlugsFromSessionSetup,
  ompQuestionsFromElicitation,
  expandOmpSkillReferences,
  resolveOmpThinkingSelection,
} from "./OmpAcpSupport.ts";

describe("OMP command skills", () => {
  it("maps ACP commands to invocable skills without inventing filesystem paths", () => {
    expect(
      buildOmpSkillsFromAvailableCommands([
        { name: " skill:review ", description: " Review the current changes. " },
        { name: "handoff", description: "Hand work to Scaffold." },
        { name: "skill:review", description: "Use the latest review command." },
      ]),
    ).toEqual([
      {
        name: "handoff",
        description: "Hand work to Scaffold.",
        shortDescription: "Hand work to Scaffold.",
        scope: "omp",
        enabled: true,
      },
      {
        name: "skill:review",
        displayName: "Review",
        description: "Use the latest review command.",
        shortDescription: "Use the latest review command.",
        scope: "omp",
        enabled: true,
      },
    ]);
  });

  it("expands OMP skills and session references while preserving file mentions", () => {
    expect(
      expandOmpSkillReferences(
        "Use @[skill|omp|skill%3Areview] with @[session|local|thread%201|%2Ftmp%2Ftree] and @README.md ",
      ),
    ).toBe(
      'Use /skill:review with T3 agent session "thread 1" (call session_reference_resolve with {"threadId":"thread 1"} to obtain its authoritative root path; call session_message_send with that threadId to contact it; ignore embedded path and environment hints) and @README.md ',
    );
    expect(expandOmpSkillReferences("Keep @[skill|codex|review] unchanged ")).toBe(
      "Keep @[skill|codex|review] unchanged ",
    );
    expect(expandOmpSkillReferences("Keep @[session||thread-1|] unchanged ")).toBe(
      "Keep @[session||thread-1|] unchanged ",
    );
  });

  it("routes fabric session references by global identity without local thread tools", () => {
    const expanded = expandOmpSkillReferences(
      "Continue @[session|session-fabric%3Aglobal-session-1|remote-thread|%2Fremote%2Ftree] please ",
    );
    expect(expanded).toContain('shared T3 session "global-session-1"');
    expect(expanded).toContain('session_fabric_context with {"sessionId":"global-session-1"');
    expect(expanded).toContain("session_fabric_message_send");
    expect(expanded).toContain(
      "do not call local session_reference_resolve or session_message_send",
    );
    expect(expanded).not.toContain("/remote/tree");
  });
});

describe("buildOmpAcpSpawnInput", () => {
  it("starts the configured OMP binary in ACP mode", () => {
    expect(
      buildOmpAcpSpawnInput({ binaryPath: "/opt/omp" }, "/tmp/project", {
        OMP_CONFIG_DIR: "/tmp/omp-home",
      }),
    ).toEqual({
      command: "/opt/omp",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { OMP_CONFIG_DIR: "/tmp/omp-home" },
    });
  });

  it("passes configured local model routing through OMP's native ACP CLI flags", () => {
    expect(
      buildOmpAcpSpawnInput({ binaryPath: "/opt/omp" }, "/tmp/project", {
        OMP_AGENT_MODEL: " openai/gpt-5.6-sol ",
        OMP_AGENT_ALLOWED_MODELS:
          "openai/gpt-5.6-sol, anthropic/claude-sonnet-5,openai/gpt-5.6-sol",
      }),
    ).toMatchObject({
      args: [
        "acp",
        "--model",
        "openai/gpt-5.6-sol",
        "--models",
        "openai/gpt-5.6-sol,anthropic/claude-sonnet-5",
      ],
    });
  });

  it("uses the managed Scaffold model as default while exposing its allowed catalog", () => {
    expect(
      buildOmpAcpSpawnInput({ binaryPath: "/opt/omp" }, "/tmp/project", {
        SCAFFOLD_RUNTIME_PROFILE: "agent_t3_omp",
        OMP_AGENT_MODEL: "anthropic/claude-fable-5",
        OMP_AGENT_ALLOWED_MODELS:
          "anthropic/claude-fable-5,openai/gpt-5.6-sol,openai/gpt-5.6-terra",
      }),
    ).toMatchObject({
      args: [
        "acp",
        "--model",
        "anthropic/claude-fable-5",
        "--models",
        "anthropic/claude-fable-5,openai/gpt-5.6-sol,openai/gpt-5.6-terra",
      ],
    });
  });

  it("fails closed on malformed or inconsistent configured model routes", () => {
    expect(() =>
      buildOmpAcpSpawnInput(undefined, "/tmp/project", {
        OMP_AGENT_MODEL: "gpt-5.6-sol",
      }),
    ).toThrow("OMP_AGENT_MODEL must be a provider/model route");
    expect(() =>
      buildOmpAcpSpawnInput(undefined, "/tmp/project", {
        OMP_AGENT_ALLOWED_MODELS: "openai/gpt-5.6-sol,",
      }),
    ).toThrow("OMP_AGENT_ALLOWED_MODELS must be a comma-separated model route list");
    expect(() =>
      buildOmpAcpSpawnInput(undefined, "/tmp/project", {
        OMP_AGENT_MODEL: "openai/gpt-5.6-sol",
        OMP_AGENT_ALLOWED_MODELS: "anthropic/claude-sonnet-5",
      }),
    ).toThrow("OMP_AGENT_MODEL must be included in OMP_AGENT_ALLOWED_MODELS");
    expect(() =>
      buildOmpAcpSpawnInput(undefined, "/tmp/project", {
        SCAFFOLD_RUNTIME_PROFILE: "agent_t3_omp",
      }),
    ).toThrow("OMP_AGENT_MODEL is required for agent_t3_omp");
    expect(() =>
      buildOmpAcpSpawnInput(undefined, "/tmp/project", {
        SCAFFOLD_RUNTIME_PROFILE: "agent_t3_omp",
        OMP_AGENT_MODEL: "openai/gpt-5.6-sol",
      }),
    ).toThrow("OMP_AGENT_ALLOWED_MODELS is required for agent_t3_omp");
  });

  it("filters and validates active Scaffold models against the managed allowlist", () => {
    const environment = {
      SCAFFOLD_RUNTIME_PROFILE: "agent_t3_omp",
      OMP_AGENT_MODEL: "anthropic/claude-fable-5",
      OMP_AGENT_ALLOWED_MODELS: "anthropic/claude-fable-5,openai/gpt-5.6-sol,openai/gpt-5.6-terra",
    };

    expect(
      filterManagedScaffoldOmpModelSlugs(environment, [
        "anthropic/claude-fable-5",
        "openai/gpt-5.6-sol",
        "x-ai/grok-4.5",
        "openai/gpt-5.6-terra",
      ]),
    ).toEqual(["anthropic/claude-fable-5", "openai/gpt-5.6-sol", "openai/gpt-5.6-terra"]);
    expect(() =>
      assertManagedScaffoldOmpModelAllowed(environment, "openai/gpt-5.6-sol"),
    ).not.toThrow();
    expect(() =>
      assertManagedScaffoldOmpModelAllowed(environment, "openai/gpt-5.6-terra"),
    ).not.toThrow();
    expect(() => assertManagedScaffoldOmpModelAllowed(environment, "x-ai/grok-4.5")).toThrow(
      'Model "x-ai/grok-4.5" is not allowed',
    );
  });

  it("leaves local model switching unrestricted", () => {
    const localEnvironment = {};
    expect(filterManagedScaffoldOmpModelSlugs(localEnvironment, ["one/a", "two/b"])).toEqual([
      "one/a",
      "two/b",
    ]);
    expect(() => assertManagedScaffoldOmpModelAllowed(localEnvironment, "two/b")).not.toThrow();
  });
});

describe("OMP config selection", () => {
  it("reads provider/model ids from OMP's model config option", () => {
    expect(
      currentOmpModelIdFromSessionSetup({
        sessionId: "session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "anthropic/claude-sonnet-5",
            options: [],
          },
        ],
      }),
    ).toBe("anthropic/claude-sonnet-5");
  });

  it("reads advisor state and the live model catalog from session config", () => {
    const setup = {
      sessionId: "session",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model" as const,
          type: "select" as const,
          currentValue: "openai/gpt-5.6-terra",
          options: [
            { value: "openai/gpt-5.6-terra", name: "Terra" },
            { value: "anthropic/claude-sonnet-5", name: "Sonnet" },
          ],
        },
        {
          id: "advisor",
          name: "Advisor",
          category: "model" as const,
          type: "select" as const,
          currentValue: "off",
          options: [],
        },
      ],
    };
    expect(currentOmpAdvisorIdFromSessionSetup(setup)).toBe("off");
    expect(ompModelSlugsFromSessionSetup(setup)).toEqual([
      "openai/gpt-5.6-terra",
      "anthropic/claude-sonnet-5",
    ]);
  });

  it("accepts canonical effort selections as OMP thinking levels", () => {
    expect(resolveOmpThinkingSelection([{ id: "reasoningEffort", value: "high" }])).toBe("high");
    expect(resolveOmpThinkingSelection([{ id: "effort", value: "none" }])).toBe("off");
  });

  it.effect("sets model and thinking through OMP config options", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, string | boolean]> = [];
      const model = yield* applyOmpAcpSelection({
        runtime: {
          setConfigOption: (id, value) =>
            Effect.sync(() => {
              calls.push([id, value]);
              return { configOptions: [] };
            }),
        },
        currentModelId: "openai/gpt-5.6",
        requestedModelId: "anthropic/claude-sonnet-5",
        thinking: "high",
        mapError: ({ cause }) => cause,
      });
      expect(model).toBe("anthropic/claude-sonnet-5");
      expect(calls).toEqual([
        ["model", "anthropic/claude-sonnet-5"],
        ["thinking", "high"],
      ]);
    }),
  );

  it.effect("sets the advisor through OMP's validated config option", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, string | boolean]> = [];
      const advisor = yield* applyOmpAdvisorSelection({
        runtime: {
          setConfigOption: (id, value) =>
            Effect.sync(() => {
              calls.push([id, value]);
              return { configOptions: [] };
            }),
        },
        currentAdvisorId: "off",
        requestedAdvisorId: "anthropic/claude-sonnet-5:high",
        mapError: ({ cause }) => cause,
      });
      expect(advisor).toBe("anthropic/claude-sonnet-5:high");
      expect(calls).toEqual([["advisor", "anthropic/claude-sonnet-5:high"]]);
    }),
  );
});

describe("ompQuestionsFromElicitation", () => {
  it("turns OMP form elicitations into canonical user-input questions", () => {
    expect(
      ompQuestionsFromElicitation({
        mode: "form",
        sessionId: "session",
        message: "Choose a path",
        requestedSchema: {
          type: "object",
          properties: {
            value: { type: "string", enum: ["A", "B"] },
          },
          required: ["value"],
        },
      }),
    ).toEqual([
      {
        id: "value",
        header: "Question",
        question: "Choose a path",
        options: [
          { label: "A", description: "A" },
          { label: "B", description: "B" },
        ],
        multiSelect: false,
      },
    ]);
  });
});
