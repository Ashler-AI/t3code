import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ScaffoldControlPlaneError,
  makeScaffoldControlPlaneClient,
  parseScaffoldSessionObservation,
} from "./client.ts";

const NOW = Date.parse("2026-07-24T19:00:00.000Z");
const ENVIRONMENT_ID = EnvironmentId.make("env-1");

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Scaffold control-plane client", () => {
  it("strictly parses sessionId, known status, and a safe non-negative epoch", () => {
    expect(
      parseScaffoldSessionObservation({
        sessionId: "session-1",
        status: "ready",
        lifecycleEpoch: 2,
      }),
    ).toEqual({ sessionId: "session-1", status: "ready", lifecycleEpoch: 2 });
    expect(
      parseScaffoldSessionObservation({ id: "session-1", status: "ready", lifecycleEpoch: 2 }),
    ).toBeUndefined();
    expect(
      parseScaffoldSessionObservation({
        sessionId: "session-1",
        status: "unknown",
        lifecycleEpoch: 2,
      }),
    ).toBeUndefined();
    expect(
      parseScaffoldSessionObservation({
        sessionId: "session-1",
        status: "ready",
        lifecycleEpoch: -1,
      }),
    ).toBeUndefined();
    expect(
      parseScaffoldSessionObservation({
        sessionId: "session-1",
        status: "ready",
        lifecycleEpoch: 1.5,
      }),
    ).toBeUndefined();
  });

  it("uses generic bounded errors without reflecting server details", async () => {
    const client = makeScaffoldControlPlaneClient({
      deployment: "staging",
      baseUrl: "https://scaffold.example.com",
      fetch: async () =>
        jsonResponse(
          {
            error: "x".repeat(200),
            message: "database password is hunter2",
          },
          503,
        ),
    });
    const error = await client.getSession("session-1").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ScaffoldControlPlaneError);
    expect(error).toMatchObject({
      message: "Scaffold request failed.",
      status: 503,
    });
    expect((error as ScaffoldControlPlaneError).code).toBe("x".repeat(96));
    expect(String(error)).not.toContain("hunter2");
  });

  it("accepts only matching, future, credential-free HTTPS/WSS transport grants", async () => {
    const validGrant = {
      environmentId: ENVIRONMENT_ID,
      sessionId: "session-1",
      lifecycleEpoch: 3,
      transport: {
        httpBaseUrl: "https://agent.example.com/api/",
        wsBaseUrl: "wss://agent.example.com/ws/",
        token: "ephemeral",
        expiresAt: "2026-07-24T20:00:00.000Z",
      },
    };
    const makeClient = (body: unknown) =>
      makeScaffoldControlPlaneClient({
        deployment: "staging",
        baseUrl: "https://scaffold.example.com",
        now: () => NOW,
        fetch: async () => jsonResponse(body),
      });
    const input = {
      environmentId: ENVIRONMENT_ID,
      sessionId: "session-1",
      expectedLifecycleEpoch: 3,
    };

    await expect(makeClient(validGrant).issueT3Transport(input)).resolves.toMatchObject({
      sessionId: "session-1",
      lifecycleEpoch: 3,
    });
    await expect(
      makeClient({ ...validGrant, sessionId: "other" }).issueT3Transport(input),
    ).rejects.toThrow("invalid T3 transport grant");
    await expect(
      makeClient({ ...validGrant, lifecycleEpoch: 4 }).issueT3Transport(input),
    ).rejects.toThrow("invalid T3 transport grant");
    await expect(
      makeClient({
        ...validGrant,
        transport: { ...validGrant.transport, httpBaseUrl: "https://agent.example.com/?token=x" },
      }).issueT3Transport(input),
    ).rejects.toThrow("invalid T3 transport grant");
    await expect(
      makeClient({
        ...validGrant,
        transport: { ...validGrant.transport, wsBaseUrl: "wss://user:pass@agent.example.com/ws" },
      }).issueT3Transport(input),
    ).rejects.toThrow("invalid T3 transport grant");
    await expect(
      makeClient({
        ...validGrant,
        transport: { ...validGrant.transport, expiresAt: "2026-07-24T18:59:59.000Z" },
      }).issueT3Transport(input),
    ).rejects.toThrow("invalid T3 transport grant");
  });
});
