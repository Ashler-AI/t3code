import {
  EnvironmentId,
  ScaffoldCreateAndPrepareInput,
  ScaffoldObserveInput,
  ScaffoldPauseInput,
  ScaffoldResumeAndPrepareInput,
  ScaffoldSessionObservation,
  SessionFabricSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { ScaffoldLifecycleError } from "@t3tools/contracts";
import type { ScaffoldControlPlaneClient } from "./ScaffoldControlPlaneClient.ts";
import { makeScaffoldLifecycleService } from "./ScaffoldLifecycleService.ts";

const ENVIRONMENT_ID = EnvironmentId.make("env_scaffold_1");
const GLOBAL_SESSION_ID = SessionFabricSessionId.make("session_global_scaffold_1");
const THREAD_ID = ThreadId.make("thread_scaffold_1");
const observation = (status: "starting" | "ready" | "paused" | "stopped" | "failed", epoch = 1) =>
  new ScaffoldSessionObservation({ sessionId: "ses_1", status, lifecycleEpoch: epoch });

const executionIdentity = (binding: {
  readonly environmentId: typeof ENVIRONMENT_ID;
  readonly sessionId: string;
}) => ({
  globalSessionId: GLOBAL_SESSION_ID,
  threadId: THREAD_ID,
  environmentId: binding.environmentId,
  scaffoldSessionId: binding.sessionId,
});

function fakeClient(
  overrides: Partial<ScaffoldControlPlaneClient> = {},
): ScaffoldControlPlaneClient {
  return {
    deployment: "staging",
    baseUrl: "https://scaffold-staging.example.com/",
    probeSessionCollection: async () => {},
    createSession: async () => observation("starting"),
    getSession: async () => observation("ready"),
    resumeSession: async () => observation("ready"),
    pauseSession: async () => observation("paused", 2),
    issueT3Transport: async () => ({
      environmentId: ENVIRONMENT_ID,
      pairingId: "pairing_1",
      lifecycleEpoch: 1,
      httpBaseUrl: "https://sandbox.example.com/",
      wsBaseUrl: "wss://sandbox.example.com/",
      bootstrapCredential: "one-time-secret",
      attachCredential: "attach-secret",
      expiresAt: "2026-07-24T21:00:00.000Z",
    }),
    issueSessionFabricCapability: async () => ({
      capability: "header.payload.signature",
      tokenType: "Bearer",
      role: "viewer",
      scopes: ["directory:read", "session:read"],
      expiresAt: "2026-07-24T21:00:00.000Z",
      issuer: "scaffold",
      audience: "session-fabric",
      keyId: "proof-1",
      bindings: {},
    }),
    ...overrides,
  };
}

describe("ScaffoldLifecycleService", () => {
  it("observes a session with one read and no lifecycle or transport mutation", async () => {
    const current = observation("stopped", 4);
    const getSession = vi.fn(async () => current);
    const createSession = vi.fn(async () => observation("starting"));
    const resumeSession = vi.fn(async () => observation("ready"));
    const pauseSession = vi.fn(async () => observation("paused"));
    const issueT3Transport = vi.fn(async () => {
      throw new Error("transport must not be issued while observing");
    });
    const service = makeScaffoldLifecycleService({
      client: () =>
        fakeClient({ getSession, createSession, resumeSession, pauseSession, issueT3Transport }),
    });

    await expect(
      service.observe(new ScaffoldObserveInput({ deployment: "staging", sessionId: "ses_1" })),
    ).resolves.toBe(current);
    expect(getSession).toHaveBeenCalledExactlyOnceWith("ses_1");
    expect(createSession).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
    expect(pauseSession).not.toHaveBeenCalled();
    expect(issueT3Transport).not.toHaveBeenCalled();
  });

  it("projects collection support per deployment without exposing control-plane responses", async () => {
    const stagingProbe = vi.fn(async () => {});
    const productionProbe = vi.fn(async () => {
      throw new ScaffoldLifecycleError({
        reason: "not_found",
        message: "Scaffold lifecycle request failed.",
        status: 404,
        code: "remote_code_sandbox_not_found",
      });
    });
    const service = makeScaffoldLifecycleService({
      client: (deployment) =>
        fakeClient({
          deployment,
          probeSessionCollection: deployment === "staging" ? stagingProbe : productionProbe,
        }),
    });

    await expect(service.deploymentCapabilities()).resolves.toEqual({
      deployments: [
        {
          deployment: "staging",
          status: "available",
          description: "New Scaffold sandbox",
        },
        {
          deployment: "production",
          status: "unsupported",
          description: "Agent sessions are not available in this deployment",
        },
      ],
    });
    expect(stagingProbe).toHaveBeenCalledOnce();
    expect(productionProbe).toHaveBeenCalledOnce();
  });

  it("reports missing deployment configuration without probing the network", async () => {
    const service = makeScaffoldLifecycleService({ environment: {} });

    await expect(service.deploymentCapabilities()).resolves.toEqual({
      deployments: [
        {
          deployment: "staging",
          status: "unavailable",
          description: "Scaffold is not configured",
        },
        {
          deployment: "production",
          status: "unavailable",
          description: "Scaffold is not configured",
        },
      ],
    });
  });

  it("uses the sole configured deployment and propagates viewer/controller policy", async () => {
    const issueSessionFabricCapability = vi.fn(async (input) => ({
      capability: "header.payload.signature",
      tokenType: "Bearer" as const,
      role: input.role,
      scopes:
        input.role === "viewer"
          ? (["directory:read", "session:read"] as const)
          : (["session:read", "session:command"] as const),
      expiresAt: "2026-07-24T21:00:00.000Z",
      issuer: "scaffold",
      audience: "session-fabric",
      keyId: "proof-1",
      bindings:
        input.role === "viewer"
          ? {}
          : {
              fabricSessionId: input.fabricSessionId,
              scaffoldSessionId: input.scaffoldSessionId,
              scaffoldLifecycleEpoch: input.scaffoldLifecycleEpoch,
            },
    }));
    const client = fakeClient({ issueSessionFabricCapability });
    const service = makeScaffoldLifecycleService({
      environment: { T3CODE_SCAFFOLD_STAGING_URL: "https://scaffold-staging.example.com/" },
      client: (deployment) => {
        expect(deployment).toBe("staging");
        return client;
      },
    });
    await expect(
      service.issueSessionFabricCapability({ capability: { role: "viewer" } }),
    ).resolves.toMatchObject({ role: "viewer" });
    await expect(
      service.issueSessionFabricCapability({
        capability: {
          role: "controller",
          fabricSessionId: GLOBAL_SESSION_ID,
          scaffoldSessionId: "ses_1",
          scaffoldLifecycleEpoch: 3,
        },
      }),
    ).resolves.toMatchObject({
      role: "controller",
      bindings: { scaffoldSessionId: "ses_1", scaffoldLifecycleEpoch: 3 },
    });
    expect(issueSessionFabricCapability).toHaveBeenNthCalledWith(1, { role: "viewer" });
    expect(issueSessionFabricCapability).toHaveBeenNthCalledWith(2, {
      role: "controller",
      fabricSessionId: GLOBAL_SESSION_ID,
      scaffoldSessionId: "ses_1",
      scaffoldLifecycleEpoch: 3,
    });
  });

  it("fails closed when local capability routing has two configured deployments and no default", async () => {
    const service = makeScaffoldLifecycleService({
      environment: {
        T3CODE_SCAFFOLD_STAGING_URL: "https://scaffold-staging.example.com/",
        T3CODE_SCAFFOLD_PRODUCTION_URL: "https://scaffold.example.com/",
      },
      client: () => fakeClient(),
    });
    await expect(
      service.issueSessionFabricCapability({ capability: { role: "viewer" } }),
    ).rejects.toMatchObject({ code: "scaffold_not_configured" });
  });

  it("preserves global session, thread, and environment identity while lifecycle and transport authority rotate", async () => {
    const issueT3Transport = vi
      .fn<ScaffoldControlPlaneClient["issueT3Transport"]>()
      .mockResolvedValueOnce({
        environmentId: ENVIRONMENT_ID,
        pairingId: "pairing_generation_1",
        lifecycleEpoch: 1,
        httpBaseUrl: "https://sandbox-generation-1.example.com/",
        wsBaseUrl: "wss://sandbox-generation-1.example.com/",
        bootstrapCredential: "bootstrap-generation-1",
        attachCredential: "attach-generation-1",
        expiresAt: "2026-07-24T21:00:00.000Z",
      })
      .mockResolvedValueOnce({
        environmentId: ENVIRONMENT_ID,
        pairingId: "pairing_generation_2",
        lifecycleEpoch: 3,
        httpBaseUrl: "https://sandbox-generation-2.example.com/",
        wsBaseUrl: "wss://sandbox-generation-2.example.com/",
        bootstrapCredential: "bootstrap-generation-2",
        attachCredential: "attach-generation-2",
        expiresAt: "2026-07-24T22:00:00.000Z",
      });
    const client = fakeClient({
      createSession: async () => observation("ready", 1),
      pauseSession: async () => observation("paused", 2),
      resumeSession: async () => observation("ready", 3),
      issueT3Transport,
    });
    const service = makeScaffoldLifecycleService({
      client: () => client,
      now: () => Date.parse("2026-07-24T20:00:00.000Z"),
    });

    const created = await service.prepare(
      new ScaffoldCreateAndPrepareInput({
        deployment: "staging",
        operationId: "op_create",
        sessionId: "ses_1",
        create: {},
      }),
    );
    const paused = await service.pause(
      new ScaffoldPauseInput({
        deployment: "staging",
        operationId: "op_pause",
        environmentId: created.binding.environmentId,
        sessionId: created.binding.sessionId,
        expectedLifecycleEpoch: created.binding.lifecycleEpoch,
      }),
    );
    const resumed = await service.prepare(
      new ScaffoldResumeAndPrepareInput({
        deployment: "staging",
        operationId: "op_resume",
        environmentId: paused.environmentId,
        sessionId: paused.sessionId,
        expectedLifecycleEpoch: paused.lifecycleEpoch,
      }),
    );

    expect([
      executionIdentity(created.binding),
      executionIdentity(paused),
      executionIdentity(resumed.binding),
    ]).toEqual([
      {
        globalSessionId: GLOBAL_SESSION_ID,
        threadId: THREAD_ID,
        environmentId: ENVIRONMENT_ID,
        scaffoldSessionId: "ses_1",
      },
      {
        globalSessionId: GLOBAL_SESSION_ID,
        threadId: THREAD_ID,
        environmentId: ENVIRONMENT_ID,
        scaffoldSessionId: "ses_1",
      },
      {
        globalSessionId: GLOBAL_SESSION_ID,
        threadId: THREAD_ID,
        environmentId: ENVIRONMENT_ID,
        scaffoldSessionId: "ses_1",
      },
    ]);
    expect([
      created.binding.lifecycleEpoch,
      paused.lifecycleEpoch,
      resumed.binding.lifecycleEpoch,
    ]).toEqual([1, 2, 3]);
    expect(resumed.httpBaseUrl).not.toBe(created.httpBaseUrl);
    expect(resumed.wsBaseUrl).not.toBe(created.wsBaseUrl);
    expect(resumed.bootstrapCredential).not.toBe(created.bootstrapCredential);
    expect(issueT3Transport).toHaveBeenNthCalledWith(1, {
      sessionId: "ses_1",
      lifecycleEpoch: 1,
    });
    expect(issueT3Transport).toHaveBeenNthCalledWith(2, {
      environmentId: ENVIRONMENT_ID,
      sessionId: "ses_1",
      lifecycleEpoch: 3,
    });
  });

  it("prepares asynchronously and returns a credential-free durable binding beside ephemeral authority", async () => {
    const service = makeScaffoldLifecycleService({
      client: () => fakeClient(),
      now: () => Date.parse("2026-07-24T20:00:00.000Z"),
    });
    const result = await service.prepare(
      new ScaffoldCreateAndPrepareInput({
        deployment: "staging",
        operationId: "op_1",
        sessionId: "ses_1",
        create: {},
      }),
    );
    expect(result.binding).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      sessionId: "ses_1",
      status: "ready",
      links: {
        session: "https://scaffold-staging.example.com/?q=ses_1",
        web: "https://scaffold-staging.example.com/sessions/ses_1/web",
        tilt: "https://scaffold-staging.example.com/sessions/ses_1/tilt",
      },
    });
    expect(result.bootstrapCredential).toBe("one-time-secret");
    expect(JSON.stringify(result.binding)).not.toContain("one-time-secret");
  });

  it("reconciles a resume 409 against current ready state", async () => {
    const conflict = new ScaffoldLifecycleError({
      reason: "conflict",
      message: "changed",
      status: 409,
      code: "sandbox_lifecycle_changed",
    });
    const service = makeScaffoldLifecycleService({
      client: () =>
        fakeClient({
          resumeSession: async () => Promise.reject(conflict),
          getSession: async () => observation("ready", 2),
          issueT3Transport: async () => ({
            environmentId: ENVIRONMENT_ID,
            pairingId: "pairing_2",
            lifecycleEpoch: 2,
            httpBaseUrl: "https://sandbox.example.com/",
            wsBaseUrl: "wss://sandbox.example.com/",
            bootstrapCredential: "one-time-secret",
            attachCredential: "attach-secret",
            expiresAt: "2026-07-24T21:00:00.000Z",
          }),
        }),
    });
    await expect(
      service.prepare(
        new ScaffoldResumeAndPrepareInput({
          deployment: "staging",
          operationId: "op_2",
          environmentId: ENVIRONMENT_ID,
          sessionId: "ses_1",
          expectedLifecycleEpoch: 2,
        }),
      ),
    ).resolves.toMatchObject({ binding: { lifecycleEpoch: 2, status: "ready" } });
  });

  it.each(["stopped", "failed"] as const)(
    "reports the current %s observation when a resume conflicts with an external stop",
    async (status) => {
      const conflict = new ScaffoldLifecycleError({
        reason: "conflict",
        message: "changed",
        status: 409,
        code: "sandbox_lifecycle_changed",
      });
      const current = observation(status, 3);
      const service = makeScaffoldLifecycleService({
        client: () =>
          fakeClient({
            resumeSession: async () => Promise.reject(conflict),
            getSession: async () => current,
          }),
      });

      await expect(
        service.prepare(
          new ScaffoldResumeAndPrepareInput({
            deployment: "staging",
            operationId: `op_resume_${status}`,
            environmentId: ENVIRONMENT_ID,
            sessionId: "ses_1",
            expectedLifecycleEpoch: 2,
          }),
        ),
      ).rejects.toMatchObject({
        reason: "terminal",
        status: 409,
        code: `scaffold_session_${status}`,
        observation: current,
      });
    },
  );

  it("reconciles an ambiguous create response by reading the preallocated session", async () => {
    const unavailable = new ScaffoldLifecycleError({
      reason: "network",
      message: "response lost",
      status: 0,
      code: "scaffold_network_error",
    });
    const createSession = vi.fn(async () => Promise.reject(unavailable));
    const service = makeScaffoldLifecycleService({
      client: () =>
        fakeClient({
          createSession,
          getSession: async () => observation("ready"),
        }),
    });

    await expect(
      service.prepare(
        new ScaffoldCreateAndPrepareInput({
          deployment: "staging",
          operationId: "op_stable",
          sessionId: "ses_1",
          create: {
            modelRouteId: "scaffold-openai/gpt-5.6-sol",
            agentEffort: "high",
          },
        }),
      ),
    ).resolves.toMatchObject({ binding: { sessionId: "ses_1", status: "ready" } });
    expect(createSession).toHaveBeenCalledWith({
      operationId: "op_stable",
      sessionId: "ses_1",
      modelRouteId: "scaffold-openai/gpt-5.6-sol",
      agentEffort: "high",
    });
  });

  it("returns pending after one readiness observation instead of polling inside the server", async () => {
    const createSession = vi.fn(async () => observation("starting"));
    const getSession = vi.fn(async () => observation("starting"));
    const issueT3Transport = vi.fn<ScaffoldControlPlaneClient["issueT3Transport"]>();
    const sleep = vi.fn(async () => {});
    const service = makeScaffoldLifecycleService({
      client: () => fakeClient({ createSession, getSession, issueT3Transport }),
      sleep,
      readinessTimeoutMs: 60_000,
      readinessIntervalMs: 2_500,
    });

    const preparation = service.prepare(
      new ScaffoldCreateAndPrepareInput({
        deployment: "staging",
        operationId: "op_single_observation",
        sessionId: "ses_1",
        create: {},
      }),
    );

    await expect(preparation).rejects.toMatchObject({
      reason: "unavailable",
      status: 202,
      code: "scaffold_preparation_pending",
      retryAfterMs: 2_500,
      observation: { sessionId: "ses_1", status: "starting", lifecycleEpoch: 1 },
    });
    expect(createSession).toHaveBeenCalledOnce();
    expect(getSession).toHaveBeenCalledExactlyOnceWith("ses_1");
    expect(sleep).not.toHaveBeenCalled();
    expect(issueT3Transport).not.toHaveBeenCalled();
  });

  it("reuses the stable operation on the next outbox attempt and prepares once ready", async () => {
    const createSession = vi.fn(async () => observation("starting"));
    const getSession = vi
      .fn<ScaffoldControlPlaneClient["getSession"]>()
      .mockResolvedValueOnce(observation("starting"))
      .mockResolvedValueOnce(observation("ready"));
    const issueT3Transport = vi.fn(fakeClient().issueT3Transport);
    const service = makeScaffoldLifecycleService({
      client: () => fakeClient({ createSession, getSession, issueT3Transport }),
    });
    const input = new ScaffoldCreateAndPrepareInput({
      deployment: "staging",
      operationId: "op_stable_retry",
      sessionId: "ses_1",
      create: {},
    });

    await expect(service.prepare(input)).rejects.toMatchObject({
      status: 202,
      code: "scaffold_preparation_pending",
    });
    await expect(service.prepare(input)).resolves.toMatchObject({
      binding: { sessionId: "ses_1", status: "ready" },
    });

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenNthCalledWith(1, {
      operationId: "op_stable_retry",
      sessionId: "ses_1",
    });
    expect(createSession).toHaveBeenNthCalledWith(2, {
      operationId: "op_stable_retry",
      sessionId: "ses_1",
    });
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(issueT3Transport).toHaveBeenCalledOnce();
  });

  it("reports a terminal state from the single readiness observation", async () => {
    const getSession = vi.fn(async () => observation("stopped", 2));
    const service = makeScaffoldLifecycleService({
      client: () => fakeClient({ getSession }),
    });

    await expect(
      service.prepare(
        new ScaffoldCreateAndPrepareInput({
          deployment: "staging",
          operationId: "op_terminal_observation",
          sessionId: "ses_1",
          create: {},
        }),
      ),
    ).rejects.toMatchObject({
      reason: "terminal",
      status: 409,
      code: "scaffold_session_stopped",
      observation: { sessionId: "ses_1", status: "stopped", lifecycleEpoch: 2 },
    });
    expect(getSession).toHaveBeenCalledExactlyOnceWith("ses_1");
  });

  it("treats pause 409 with stopped state as converged", async () => {
    const conflict = new ScaffoldLifecycleError({
      reason: "conflict",
      message: "changed",
      status: 409,
      code: "sandbox_lifecycle_changed",
    });
    const service = makeScaffoldLifecycleService({
      client: () =>
        fakeClient({
          pauseSession: async () => Promise.reject(conflict),
          getSession: async () => observation("stopped", 3),
        }),
    });
    await expect(
      service.pause(
        new ScaffoldPauseInput({
          deployment: "staging",
          operationId: "op_3",
          environmentId: ENVIRONMENT_ID,
          sessionId: "ses_1",
          expectedLifecycleEpoch: 2,
        }),
      ),
    ).resolves.toMatchObject({ environmentId: ENVIRONMENT_ID, status: "stopped" });
  });

  it("treats pause 409 with paused state as converged", async () => {
    const conflict = new ScaffoldLifecycleError({
      reason: "conflict",
      message: "changed",
      status: 409,
      code: "sandbox_lifecycle_changed",
    });
    const service = makeScaffoldLifecycleService({
      client: () =>
        fakeClient({
          pauseSession: async () => Promise.reject(conflict),
          getSession: async () => observation("paused", 3),
        }),
    });

    await expect(
      service.pause(
        new ScaffoldPauseInput({
          deployment: "staging",
          operationId: "op_pause_converged",
          environmentId: ENVIRONMENT_ID,
          sessionId: "ses_1",
          expectedLifecycleEpoch: 2,
        }),
      ),
    ).resolves.toMatchObject({ environmentId: ENVIRONMENT_ID, status: "paused" });
  });
});
