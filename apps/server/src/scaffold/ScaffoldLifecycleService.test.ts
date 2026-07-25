import {
  EnvironmentId,
  ScaffoldCreateAndPrepareInput,
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
const observation = (status: "starting" | "ready" | "paused" | "stopped", epoch = 1) =>
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
    createSession: async () => observation("starting"),
    getSession: async () => observation("ready"),
    resumeSession: async () => observation("ready"),
    pauseSession: async () => observation("paused", 2),
    issueT3Transport: async () => ({
      environmentId: ENVIRONMENT_ID,
      sessionId: "ses_1",
      lifecycleEpoch: 1,
      httpBaseUrl: "https://sandbox.example.com/",
      wsBaseUrl: "wss://sandbox.example.com/",
      bootstrapCredential: "one-time-secret",
      expiresAt: "2026-07-24T21:00:00.000Z",
    }),
    ...overrides,
  };
}

describe("ScaffoldLifecycleService", () => {
  it("preserves global session, thread, and environment identity while lifecycle and transport authority rotate", async () => {
    const issueT3Transport = vi
      .fn<ScaffoldControlPlaneClient["issueT3Transport"]>()
      .mockResolvedValueOnce({
        environmentId: ENVIRONMENT_ID,
        sessionId: "ses_1",
        lifecycleEpoch: 1,
        httpBaseUrl: "https://sandbox-generation-1.example.com/",
        wsBaseUrl: "wss://sandbox-generation-1.example.com/",
        bootstrapCredential: "bootstrap-generation-1",
        expiresAt: "2026-07-24T21:00:00.000Z",
      })
      .mockResolvedValueOnce({
        environmentId: ENVIRONMENT_ID,
        sessionId: "ses_1",
        lifecycleEpoch: 3,
        httpBaseUrl: "https://sandbox-generation-2.example.com/",
        wsBaseUrl: "wss://sandbox-generation-2.example.com/",
        bootstrapCredential: "bootstrap-generation-2",
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
      sleep: async () => {},
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
      sleep: async () => {},
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
            sessionId: "ses_1",
            lifecycleEpoch: 2,
            httpBaseUrl: "https://sandbox.example.com/",
            wsBaseUrl: "wss://sandbox.example.com/",
            bootstrapCredential: "one-time-secret",
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
          create: {},
        }),
      ),
    ).resolves.toMatchObject({ binding: { sessionId: "ses_1", status: "ready" } });
    expect(createSession).toHaveBeenCalledWith({
      operationId: "op_stable",
      sessionId: "ses_1",
    });
  });

  it("treats pause 409 with paused or stopped state as converged", async () => {
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
});
