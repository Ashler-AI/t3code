import { EnvironmentId, SessionFabricSessionId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeScaffoldControlPlaneClient,
  parseScaffoldSessionObservation,
  requestScaffoldRunnerCapability,
} from "./ScaffoldControlPlaneClient.ts";

const target = {
  deployment: "staging" as const,
  baseUrl: "https://scaffold-staging.example.com/",
  authMode: "iap" as const,
  collectionPath: "/api/sessions" as const,
  authorization: "Bearer server-only",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("ScaffoldControlPlaneClient", () => {
  it("probes the authenticated session collection without creating a sandbox", async () => {
    let request: { readonly url: string; readonly init?: RequestInit } | undefined;
    const client = makeScaffoldControlPlaneClient({
      target: {
        ...target,
        authMode: "oauth",
        collectionPath: "/api/code-sandboxes/agent-sessions",
      },
      fetch: async (input, init) => {
        request = { url: String(input), ...(init ? { init } : {}) };
        return json({ sessions: [] });
      },
    });

    await expect(client.probeSessionCollection()).resolves.toBeUndefined();
    expect(request?.url).toBe(
      "https://scaffold-staging.example.com/api/code-sandboxes/agent-sessions?limit=1&offset=0&showStopped=true",
    );
    expect(request?.init?.method).toBeUndefined();
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer server-only");
  });

  it("rejects a successful response that is not a session collection", async () => {
    const client = makeScaffoldControlPlaneClient({
      target,
      fetch: async () => new Response("<html>Sign in</html>", { status: 200 }),
    });

    await expect(client.probeSessionCollection()).rejects.toMatchObject({
      reason: "invalid_response",
      status: 502,
      code: "scaffold_invalid_session_collection",
    });
  });

  it("parses the real Scaffold id field and rejects the prototype sessionId field", () => {
    expect(
      parseScaffoldSessionObservation({
        session: { id: "ses_1", status: "ready", lifecycleEpoch: 3 },
      }),
    ).toMatchObject({ sessionId: "ses_1", status: "ready", lifecycleEpoch: 3 });
    expect(
      parseScaffoldSessionObservation({ sessionId: "ses_1", status: "ready", lifecycleEpoch: 3 }),
    ).toBeUndefined();
  });

  it("renames through the authenticated collection route with a stable idempotency key", async () => {
    let request: { readonly url: string; readonly init?: RequestInit } | undefined;
    const client = makeScaffoldControlPlaneClient({
      target: {
        ...target,
        authMode: "oauth",
        collectionPath: "/api/code-sandboxes/agent-sessions",
      },
      fetch: async (input, init) => {
        request = { url: String(input), ...(init ? { init } : {}) };
        return json({
          sandbox: {
            id: "ses_1",
            status: "ready",
            lifecycleEpoch: 3,
            name: "Fix Scaffold resume failures",
          },
        });
      },
    });

    await expect(
      client.renameSession({
        sessionId: "ses_1",
        operationId: "scaffold-title-sync:ses_1:thread_1",
        name: "Fix Scaffold resume failures",
      }),
    ).resolves.toMatchObject({
      sessionId: "ses_1",
      name: "Fix Scaffold resume failures",
    });
    expect(request?.url).toBe(
      "https://scaffold-staging.example.com/api/code-sandboxes/agent-sessions/ses_1/name",
    );
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer server-only");
    expect(new Headers(request?.init?.headers).get("idempotency-key")).toBe(
      "scaffold-title-sync:ses_1:thread_1",
    );
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      name: "Fix Scaffold resume failures",
    });
  });

  it("creates agent_t3_omp sessions server-side and never places auth in the body", async () => {
    let request: { readonly url: string; readonly init?: RequestInit } | undefined;
    const client = makeScaffoldControlPlaneClient({
      target,
      fetch: async (input, init) => {
        request = { url: String(input), ...(init ? { init } : {}) };
        return json({ session: { id: "ses_1", status: "starting", lifecycleEpoch: 1 } }, 202);
      },
    });
    await expect(
      client.createSession({
        sessionId: "ses_1",
        operationId: "op_1",
        sourceRef: "main",
        modelRouteId: "scaffold-openai/gpt-5.6-sol",
        agentEffort: "high",
      }),
    ).resolves.toMatchObject({ sessionId: "ses_1" });
    expect(request?.url).toBe("https://scaffold-staging.example.com/api/sessions");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer server-only");
    const body = JSON.parse(String(request?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: "ses_1",
      runtimeProfile: "agent_t3_omp",
      sourceRef: "main",
      modelRouteId: "scaffold-openai/gpt-5.6-sol",
      agentEffort: "high",
    });
    expect(JSON.stringify(body)).not.toContain("server-only");
  });

  it("uses the exact OAuth agent create contract and accepts a server-minted sandbox id", async () => {
    let request: { readonly url: string; readonly init?: RequestInit } | undefined;
    const client = makeScaffoldControlPlaneClient({
      target: {
        ...target,
        authMode: "oauth",
        collectionPath: "/api/code-sandboxes/agent-sessions",
      },
      fetch: async (input, init) => {
        request = { url: String(input), ...(init ? { init } : {}) };
        return json({ sandbox: { id: "ses_server_minted", status: "starting" } }, 202);
      },
    });
    await expect(
      client.createSession({
        sessionId: "ses_client_proposed",
        operationId: "op_1",
        sourceRef: "main",
        snapshotId: "snapshot_1",
        name: "OAuth T3 session",
        modelRouteId: "scaffold-openai/gpt-5.6-sol",
        agentEffort: "high",
      }),
    ).resolves.toMatchObject({ sessionId: "ses_server_minted" });
    expect(request?.url).toBe(
      "https://scaffold-staging.example.com/api/code-sandboxes/agent-sessions",
    );
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      harness: "t3_omp",
      name: "OAuth T3 session",
      modelRouteId: "scaffold-openai/gpt-5.6-sol",
      agentEffort: "high",
    });
    expect(String(request?.init?.body)).not.toContain("ses_client_proposed");
    expect(String(request?.init?.body)).not.toContain("runtimeProfile");
    expect(String(request?.init?.body)).not.toContain("origin");
    expect(String(request?.init?.body)).not.toContain("sourceRef");
    expect(String(request?.init?.body)).not.toContain("snapshotId");
  });

  it("replays an ambiguous OAuth create with the same idempotency key", async () => {
    const requests: RequestInit[] = [];
    const client = makeScaffoldControlPlaneClient({
      target: {
        ...target,
        authMode: "oauth",
        collectionPath: "/api/code-sandboxes/agent-sessions",
      },
      fetch: async (_input, init) => {
        requests.push(init ?? {});
        if (requests.length === 1) throw new TypeError("response lost");
        return json({ sandbox: { id: "ses_server_minted", status: "starting" } }, 202);
      },
    });

    await expect(
      client.createSession({ operationId: "op_stable", name: "OAuth T3 session" }),
    ).resolves.toMatchObject({ sessionId: "ses_server_minted" });
    expect(requests).toHaveLength(2);
    expect(new Headers(requests[0]?.headers).get("idempotency-key")).toBe("op_stable");
    expect(new Headers(requests[1]?.headers).get("idempotency-key")).toBe("op_stable");
    expect(requests[1]?.body).toBe(requests[0]?.body);
  });

  it("aborts a hung lifecycle request at the configured deadline", async () => {
    const client = makeScaffoldControlPlaneClient({
      target,
      timeoutMs: 5,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    });

    await expect(client.getSession("ses_hung")).rejects.toMatchObject({
      reason: "network",
      code: "scaffold_network_error",
    });
  });

  it("validates a future one-time bootstrap without reflecting it in errors", async () => {
    const environmentId = EnvironmentId.make("env_scaffold_1");
    const valid = {
      id: "pairing-t3-transport",
      environmentId,
      lifecycleEpoch: 2,
      transport: {
        httpBaseUrl: "https://sandbox.example.com/",
        wsBaseUrl: "wss://sandbox.example.com/",
        bootstrapCredential: "one-time-secret",
        attachCredential: "attach-secret",
        expiresAt: "2026-07-24T21:00:00.000Z",
      },
    };
    const client = makeScaffoldControlPlaneClient({
      target,
      now: () => Date.parse("2026-07-24T20:00:00.000Z"),
      fetch: async () => json(valid),
    });
    await expect(
      client.issueT3Transport({ environmentId, sessionId: "ses_1", lifecycleEpoch: 2 }),
    ).resolves.toMatchObject({
      pairingId: "pairing-t3-transport",
      bootstrapCredential: "one-time-secret",
      attachCredential: "attach-secret",
    });

    for (const attachCredential of [undefined, "   ", "bad credential", "bad,credential"]) {
      const invalidAttach = makeScaffoldControlPlaneClient({
        target,
        now: () => Date.parse("2026-07-24T20:00:00.000Z"),
        fetch: async () =>
          json({
            ...valid,
            transport: { ...valid.transport, attachCredential },
          }),
      });
      await expect(
        invalidAttach.issueT3Transport({
          environmentId,
          sessionId: "ses_1",
          lifecycleEpoch: 2,
        }),
      ).rejects.toMatchObject({ code: "scaffold_invalid_transport" });
    }

    const missingPairing = makeScaffoldControlPlaneClient({
      target,
      now: () => Date.parse("2026-07-24T20:00:00.000Z"),
      fetch: async () => json({ ...valid, id: undefined }),
    });
    const error = await missingPairing
      .issueT3Transport({ environmentId, sessionId: "ses_1", lifecycleEpoch: 2 })
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "scaffold_invalid_transport" });
    expect(String(error)).not.toContain("one-time-secret");

    const missingEnvironment = makeScaffoldControlPlaneClient({
      target,
      now: () => Date.parse("2026-07-24T20:00:00.000Z"),
      fetch: async () => json({ ...valid, environmentId: undefined }),
    });
    await expect(
      missingEnvironment.issueT3Transport({ sessionId: "ses_1", lifecycleEpoch: 2 }),
    ).rejects.toMatchObject({ code: "scaffold_invalid_transport" });
  });

  it("forwards viewer capability requests with server auth and never puts auth in the body", async () => {
    let request: { readonly url: string; readonly init?: RequestInit } | undefined;
    const client = makeScaffoldControlPlaneClient({
      target,
      now: () => Date.parse("2026-07-24T20:00:00.000Z"),
      fetch: async (input, init) => {
        request = { url: String(input), ...(init ? { init } : {}) };
        return json({
          capability: "header.payload.signature",
          tokenType: "Bearer",
          role: "viewer",
          scopes: ["directory:read", "session:read"],
          expiresAt: "2026-07-24T20:05:00.000Z",
          issuer: "scaffold",
          audience: "session-fabric",
          keyId: "proof-1",
          bindings: {},
        });
      },
    });
    await expect(client.issueSessionFabricCapability({ role: "viewer" })).resolves.toMatchObject({
      role: "viewer",
      bindings: {},
    });
    expect(request?.url).toBe(
      "https://scaffold-staging.example.com/api/session-fabric/capabilities",
    );
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer server-only");
    expect(String(request?.init?.body)).toBe('{"role":"viewer"}');
    expect(String(request?.init?.body)).not.toContain("server-only");
  });

  it("forwards the canonical controller lifecycle binding without an alias", async () => {
    let request: { readonly init?: RequestInit } | undefined;
    const fabricSessionId = SessionFabricSessionId.make("global-session-1");
    const client = makeScaffoldControlPlaneClient({
      target,
      now: () => Date.parse("2026-07-24T20:00:00.000Z"),
      fetch: async (_input, init) => {
        request = init ? { init } : {};
        return json({
          capability: "header.payload.signature",
          tokenType: "Bearer",
          role: "controller",
          scopes: ["session:read", "session:command"],
          expiresAt: "2026-07-24T20:01:00.000Z",
          issuer: "scaffold",
          audience: "session-fabric",
          keyId: "proof-1",
          bindings: {
            fabricSessionId,
            environmentKind: "scaffold",
            environmentId: "environment-1",
            threadId: "thread-1",
            scaffoldSessionId: "ses_1",
            scaffoldLifecycleEpoch: 7,
          },
        });
      },
    });
    await expect(
      client.issueSessionFabricCapability({
        role: "controller",
        fabricSessionId,
        environmentKind: "scaffold",
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
        scaffoldSessionId: "ses_1",
        scaffoldLifecycleEpoch: 7,
      }),
    ).resolves.toMatchObject({ role: "controller" });
    expect(String(request?.init?.body)).toBe(
      JSON.stringify({
        role: "controller",
        fabricSessionId,
        environmentKind: "scaffold",
        environmentId: "environment-1",
        threadId: "thread-1",
        scaffoldSessionId: "ses_1",
        scaffoldLifecycleEpoch: 7,
      }),
    );
    expect(String(request?.init?.body)).not.toContain('"lifecycleEpoch"');
  });

  it("forwards and validates the canonical local controller binding", async () => {
    let request: { readonly init?: RequestInit } | undefined;
    const fabricSessionId = SessionFabricSessionId.make("sf:env_1:thread_1");
    const client = makeScaffoldControlPlaneClient({
      target,
      now: () => Date.parse("2026-07-24T20:00:00.000Z"),
      fetch: async (_input, init) => {
        request = init ? { init } : {};
        return json({
          capability: "header.payload.signature",
          tokenType: "Bearer",
          role: "controller",
          scopes: ["session:read", "session:command"],
          expiresAt: "2026-07-24T20:01:00.000Z",
          issuer: "scaffold",
          audience: "session-fabric",
          keyId: "proof-1",
          bindings: {
            fabricSessionId,
            environmentKind: "local",
            environmentId: "env_1",
            threadId: "thread_1",
          },
        });
      },
    });
    await expect(
      client.issueSessionFabricCapability({
        role: "controller",
        fabricSessionId,
        environmentKind: "local",
        environmentId: EnvironmentId.make("env_1"),
        threadId: ThreadId.make("thread_1"),
      }),
    ).resolves.toMatchObject({
      role: "controller",
      bindings: { environmentKind: "local", environmentId: "env_1", threadId: "thread_1" },
    });
    expect(String(request?.init?.body)).toBe(
      JSON.stringify({
        role: "controller",
        fabricSessionId,
        environmentKind: "local",
        environmentId: "env_1",
        threadId: "thread_1",
      }),
    );
  });

  it("rejects a local controller grant with a different authority binding", async () => {
    const fabricSessionId = SessionFabricSessionId.make("sf:env_1:thread_1");
    const client = makeScaffoldControlPlaneClient({
      target,
      now: () => Date.parse("2026-07-24T20:00:00.000Z"),
      fetch: async () =>
        json({
          capability: "header.payload.signature",
          tokenType: "Bearer",
          role: "controller",
          scopes: ["session:read", "session:command"],
          expiresAt: "2026-07-24T20:01:00.000Z",
          issuer: "scaffold",
          audience: "session-fabric",
          keyId: "proof-1",
          bindings: {
            fabricSessionId,
            environmentKind: "local",
            environmentId: "env_other",
            threadId: "thread_1",
            actorId: "actor_1",
          },
        }),
    });
    await expect(
      client.issueSessionFabricCapability({
        role: "controller",
        fabricSessionId,
        environmentKind: "local",
        environmentId: EnvironmentId.make("env_1"),
        threadId: ThreadId.make("thread_1"),
      }),
    ).rejects.toMatchObject({ code: "scaffold_invalid_session_fabric_capability" });
  });

  it("issues an exact epoch-bound runner capability with only the runtime token header", async () => {
    let request: { readonly url: string; readonly init?: RequestInit } | undefined;
    const capability = "header.payload.signature";
    await expect(
      requestScaffoldRunnerCapability({
        baseUrl: "https://scaffold-staging.example.com/",
        runtimeApiToken: "runtime-secret",
        scaffoldSessionId: "ses_1",
        lifecycleEpoch: 7,
        now: () => Date.parse("2026-07-24T20:00:00.000Z"),
        fetch: async (input, init) => {
          request = { url: String(input), ...(init ? { init } : {}) };
          return json({
            capability,
            tokenType: "Bearer",
            role: "runner",
            scopes: ["session:publish", "session:execute"],
            expiresAt: "2026-07-24T20:15:00.000Z",
            issuer: "scaffold",
            audience: "session-fabric",
            keyId: "proof-1",
            bindings: { scaffoldSessionId: "ses_1", scaffoldLifecycleEpoch: 7 },
          });
        },
      }),
    ).resolves.toMatchObject({ role: "runner", capability });
    expect(request?.url).toBe(
      "https://scaffold-staging.example.com/api/sessions/ses_1/session-fabric/runner-capability",
    );
    expect(new Headers(request?.init?.headers).get("x-scaffold-runtime-api-token")).toBe(
      "runtime-secret",
    );
    expect(String(request?.init?.body)).toBe('{"lifecycleEpoch":7}');
    expect(String(request?.init?.body)).not.toContain("runtime-secret");
  });

  it("rejects mismatched runner bindings without reflecting either secret", async () => {
    const error = await requestScaffoldRunnerCapability({
      baseUrl: "https://scaffold-staging.example.com/",
      runtimeApiToken: "runtime-secret",
      scaffoldSessionId: "ses_1",
      lifecycleEpoch: 7,
      now: () => Date.parse("2026-07-24T20:00:00.000Z"),
      fetch: async () =>
        json({
          capability: "header.payload.signature",
          tokenType: "Bearer",
          role: "runner",
          scopes: ["session:publish", "session:execute"],
          expiresAt: "2026-07-24T20:15:00.000Z",
          issuer: "scaffold",
          audience: "session-fabric",
          keyId: "proof-1",
          bindings: { scaffoldSessionId: "ses_other", scaffoldLifecycleEpoch: 7 },
        }),
    }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "scaffold_invalid_session_fabric_capability" });
    expect(String(error)).not.toContain("runtime-secret");
    expect(String(error)).not.toContain("header.payload.signature");
  });

  it("bounds runner capability issuance and reports a non-secret network error", async () => {
    const error = await requestScaffoldRunnerCapability({
      baseUrl: "https://scaffold-staging.example.com/",
      runtimeApiToken: "runtime-secret",
      scaffoldSessionId: "ses_1",
      lifecycleEpoch: 7,
      timeoutMs: 5,
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "scaffold_session_fabric_capability_network_error",
      status: 0,
    });
    expect(String(error)).not.toContain("runtime-secret");
  });
});
