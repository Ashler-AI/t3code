import { EnvironmentId, SessionFabricSessionId } from "@t3tools/contracts";
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
      client.createSession({ sessionId: "ses_1", operationId: "op_1", sourceRef: "main" }),
    ).resolves.toMatchObject({ sessionId: "ses_1" });
    expect(request?.url).toBe("https://scaffold-staging.example.com/api/sessions");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer server-only");
    const body = JSON.parse(String(request?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: "ses_1",
      runtimeProfile: "agent_t3_omp",
      sourceRef: "main",
    });
    expect(JSON.stringify(body)).not.toContain("server-only");
  });

  it("uses the OAuth agent collection and accepts a server-minted sandbox id", async () => {
    let requestUrl: string | undefined;
    const client = makeScaffoldControlPlaneClient({
      target: {
        ...target,
        authMode: "oauth",
        collectionPath: "/api/code-sandboxes/agent-sessions",
      },
      fetch: async (input) => {
        requestUrl = String(input);
        return json({ sandbox: { id: "ses_server_minted", status: "starting" } }, 202);
      },
    });
    await expect(client.createSession({ operationId: "op_1" })).resolves.toMatchObject({
      sessionId: "ses_server_minted",
    });
    expect(requestUrl).toBe(
      "https://scaffold-staging.example.com/api/code-sandboxes/agent-sessions",
    );
  });

  it("validates a future one-time bootstrap without reflecting it in errors", async () => {
    const environmentId = EnvironmentId.make("env_scaffold_1");
    const valid = {
      id: "ses_1",
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

    const invalid = makeScaffoldControlPlaneClient({
      target,
      now: () => Date.parse("2026-07-24T20:00:00.000Z"),
      fetch: async () => json({ ...valid, id: "ses_other" }),
    });
    const error = await invalid
      .issueT3Transport({ environmentId, sessionId: "ses_1", lifecycleEpoch: 2 })
      .catch((cause: unknown) => cause);
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
        scaffoldSessionId: "ses_1",
        scaffoldLifecycleEpoch: 7,
      }),
    ).resolves.toMatchObject({ role: "controller" });
    expect(String(request?.init?.body)).toBe(
      JSON.stringify({
        role: "controller",
        fabricSessionId,
        scaffoldSessionId: "ses_1",
        scaffoldLifecycleEpoch: 7,
      }),
    );
    expect(String(request?.init?.body)).not.toContain('"lifecycleEpoch"');
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
