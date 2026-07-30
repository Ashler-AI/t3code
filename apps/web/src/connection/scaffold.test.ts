import {
  EnvironmentId,
  ScaffoldCreateAndPrepareInput,
  ScaffoldEnvironmentBinding,
  ScaffoldObserveInput,
  ScaffoldPreparedConnection,
  ScaffoldResumeAndPrepareInput,
  ScaffoldSessionLinks,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_LOCAL_LIFECYCLE_TIMEOUT_MS,
  requestScaffoldDeploymentCapabilities,
  requestScaffoldPreparedConnection,
  requestScaffoldSessionObservation,
} from "./scaffold";

const prepared = new ScaffoldPreparedConnection({
  binding: new ScaffoldEnvironmentBinding({
    deployment: "staging",
    environmentId: EnvironmentId.make("environment-scaffold"),
    sessionId: "session-1",
    lifecycleEpoch: 4,
    status: "ready",
    links: new ScaffoldSessionLinks({
      session: "https://scaffold.example.test/?q=session-1",
      web: "https://scaffold.example.test/sessions/session-1/web",
      tilt: "https://scaffold.example.test/sessions/session-1/tilt",
    }),
    lastKnownAt: "2026-07-24T20:00:00.000Z",
  }),
  httpBaseUrl: "https://sandbox.example.test/",
  wsBaseUrl: "wss://sandbox.example.test/",
  bootstrapCredential: "one-time-bootstrap",
  attachCredential: "attach-secret",
  expiresAt: "2026-07-24T20:05:00.000Z",
});

describe("Scaffold connection lifecycle client", () => {
  it("observes a session through the authenticated no-store local route", async () => {
    const calls: Array<readonly [RequestInfo | URL, RequestInit | undefined]> = [];
    const observation = await requestScaffoldSessionObservation(
      new ScaffoldObserveInput({ deployment: "staging", sessionId: "ses_stopped" }),
      async (request, init) => {
        calls.push([request, init]);
        return Response.json({
          sessionId: "ses_stopped",
          status: "stopped",
          lifecycleEpoch: 4,
        });
      },
      "http://127.0.0.1:3773/api/scaffold/observation",
    );

    expect(observation).toMatchObject({
      sessionId: "ses_stopped",
      status: "stopped",
      lifecycleEpoch: 4,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "include",
      cache: "no-store",
    });
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
      deployment: "staging",
      sessionId: "ses_stopped",
    });
  });

  it("loads the server-probed deployment capability projection", async () => {
    const calls: Array<readonly [RequestInfo | URL, RequestInit | undefined]> = [];
    const capabilities = await requestScaffoldDeploymentCapabilities(async (request, init) => {
      calls.push([request, init]);
      return Response.json({
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
    }, "http://127.0.0.1:3773/api/scaffold/deployments");

    expect(capabilities.deployments.map(({ deployment, status }) => [deployment, status])).toEqual([
      ["staging", "available"],
      ["production", "unsupported"],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({ method: "GET", credentials: "include" });
  });

  it("keeps the browser deadline above the server readiness window", () => {
    expect(DEFAULT_LOCAL_LIFECYCLE_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  it("uses only the local lifecycle route and returns ephemeral authority in memory", async () => {
    const calls: Array<readonly [RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchMock = async (request: RequestInfo | URL, init?: RequestInit) => {
      calls.push([request, init]);
      return new Response(JSON.stringify(prepared), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const input = new ScaffoldCreateAndPrepareInput({
      deployment: "staging",
      operationId: "operation-1",
      create: {},
    });

    const result = await requestScaffoldPreparedConnection(
      input,
      fetchMock,
      "http://127.0.0.1:3773/api/scaffold/connection",
    );

    expect(result.bootstrapCredential).toBe("one-time-bootstrap");
    expect(result.attachCredential).toBe("attach-secret");
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(String(url)).toContain("/api/scaffold/connection");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(String(init?.body)).toContain('"operationId":"operation-1"');
    expect(String(init?.body)).not.toContain("one-time-bootstrap");
  });

  it("coalesces concurrent resume prepares for the same exact target", async () => {
    let fetchCalls = 0;
    let releaseResponse: (() => void) | undefined;
    const responseReady = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const fetchMock = async () => {
      fetchCalls += 1;
      await responseReady;
      return Response.json(prepared);
    };
    const makeInput = (operationId: string) =>
      new ScaffoldResumeAndPrepareInput({
        deployment: "staging",
        operationId,
        environmentId: prepared.binding.environmentId,
        sessionId: prepared.binding.sessionId,
        expectedLifecycleEpoch: prepared.binding.lifecycleEpoch,
      });

    const first = requestScaffoldPreparedConnection(
      makeInput("resume-1"),
      fetchMock,
      "http://127.0.0.1:3773/api/scaffold/connection",
    );
    const second = requestScaffoldPreparedConnection(
      makeInput("resume-2"),
      fetchMock,
      "http://127.0.0.1:3773/api/scaffold/connection",
    );
    releaseResponse?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(fetchCalls).toBe(1);

    await requestScaffoldPreparedConnection(
      makeInput("resume-3"),
      fetchMock,
      "http://127.0.0.1:3773/api/scaffold/connection",
    );
    expect(fetchCalls).toBe(2);
  });

  it("aborts a hung local lifecycle request at the configured deadline", async () => {
    const input = new ScaffoldCreateAndPrepareInput({
      deployment: "staging",
      operationId: "operation-hung",
      create: {},
    });
    const hangingFetch = async (_request: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });

    await expect(
      requestScaffoldPreparedConnection(
        input,
        hangingFetch,
        "http://127.0.0.1:3773/api/scaffold/connection",
        5,
      ),
    ).rejects.toMatchObject({
      reason: "network",
      code: "scaffold_local_network_error",
    });
  });
});
