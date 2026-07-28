import {
  EnvironmentId,
  ScaffoldCreateAndPrepareInput,
  ScaffoldEnvironmentBinding,
  ScaffoldPreparedConnection,
  ScaffoldSessionLinks,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_LOCAL_LIFECYCLE_TIMEOUT_MS, requestScaffoldPreparedConnection } from "./scaffold";

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
