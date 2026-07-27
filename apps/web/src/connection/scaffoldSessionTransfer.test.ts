import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  type PreparedConnection,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  ProjectId,
  SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1,
  SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1,
  ScaffoldEnvironmentBinding,
  ScaffoldSessionLinks,
  ScaffoldWorkspaceMigrationReceipt,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { desktopLocalConnectionId } from "./desktopLocal";
import {
  copyScaffoldSessionAndRegister,
  requestScaffoldSessionCopy,
  scaffoldSessionTransferOperationId,
  scaffoldSessionTransferSeriesId,
  scaffoldSessionCopyRegistration,
} from "./scaffoldSessionTransfer";

const source = {
  environmentId: EnvironmentId.make("environment-local-secondary"),
  projectId: ProjectId.make("project-source"),
  threadId: ThreadId.make("thread-source"),
};
const operationId = await scaffoldSessionTransferOperationId({
  sourceEnvironmentId: source.environmentId,
  sourceThreadId: source.threadId,
  deployment: "staging",
});
const binding = new ScaffoldEnvironmentBinding({
  deployment: "staging",
  environmentId: EnvironmentId.make("environment-scaffold"),
  sessionId: "session-scaffold",
  lifecycleEpoch: 7,
  status: "ready",
  links: new ScaffoldSessionLinks({
    session: "https://scaffold.example.test/?q=session-scaffold",
    web: "https://scaffold.example.test/sessions/session-scaffold/web",
    tilt: "https://scaffold.example.test/sessions/session-scaffold/tilt",
  }),
  lastKnownAt: "2026-07-26T12:00:00.000Z",
});
const receipt = new ScaffoldWorkspaceMigrationReceipt({
  ok: true,
  version: "scaffold.workspace_migration.receipt.v1",
  sessionId: binding.sessionId,
  operationId,
  payloadDigestSha256: "a".repeat(64),
  archiveSha256: "d".repeat(64),
  ompBundleSha256: "b".repeat(64),
  t3MetadataSha256: "c".repeat(64),
  workspaceArchiveSha256: "d".repeat(64),
  transcriptSha256: "e".repeat(64),
  credentialExclusions: [...SCAFFOLD_WORKSPACE_MIGRATION_CREDENTIAL_EXCLUSIONS_V1],
  unsupportedFilesystemCases: [...SCAFFOLD_WORKSPACE_MIGRATION_UNSUPPORTED_FILESYSTEM_CASES_V1],
  binding,
  source: {
    ...source,
    globalSessionId: `sf:${source.environmentId}:${source.threadId}`,
    ompSessionId: "omp-source",
  },
  destination: {
    environmentId: binding.environmentId,
    projectId: ProjectId.make("project-destination"),
    threadId: ThreadId.make("thread-destination"),
    globalSessionId: `sf:${binding.environmentId}:thread-destination`,
    ompSessionId: "omp-destination",
  },
});

function secondaryPrepared(overrides: Partial<PreparedConnection> = {}): PreparedConnection {
  return {
    environmentId: source.environmentId,
    label: "WSL Ubuntu",
    httpBaseUrl: "http://127.0.0.1:4773/mounted/",
    socketUrl: "ws://127.0.0.1:4773/mounted/ws",
    httpAuthorization: { _tag: "Bearer", token: "secondary-bearer" },
    target: new BearerConnectionTarget({
      environmentId: source.environmentId,
      connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
      label: "WSL Ubuntu",
    }),
    ...overrides,
  };
}

const requestInput = (prepared: PreparedConnection | null = secondaryPrepared()) => ({
  deployment: "staging" as const,
  source,
  prepared,
});

const receiptResponse = (value: unknown = receipt) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const receiptForOperationId = (nextOperationId: string) =>
  new ScaffoldWorkspaceMigrationReceipt({ ...receipt, operationId: nextOperationId });

describe("Scaffold session copy client", () => {
  it("matches the canonical server SHA-256 operation identity", () => {
    expect(operationId).toBe(
      "scaffold.session-transfer.operation.v1:136bef2df3560644147a8b55a971f83e82f10674be6b5837c9b4a8a3da4acc19",
    );
  });

  it("exposes the operation request identity as a stable logical series key", async () => {
    await expect(
      scaffoldSessionTransferSeriesId({
        sourceEnvironmentId: source.environmentId,
        sourceThreadId: source.threadId,
        deployment: "staging",
      }),
    ).resolves.toBe(operationId);
  });

  it("hashes long Unicode source identities into a bounded browser-safe operation id", async () => {
    const id = await scaffoldSessionTransferOperationId({
      sourceEnvironmentId: EnvironmentId.make(`environment:${"雪".repeat(300)}`),
      sourceThreadId: ThreadId.make(`thread/%:${"🧵".repeat(300)}`),
      deployment: "production",
    });

    expect(id).toMatch(/^scaffold\.session-transfer\.operation\.v1:[a-f0-9]{64}$/);
    expect(id).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(id.length).toBeLessThanOrEqual(160);
  });

  it("uses the selected secondary endpoint and Bearer authority without a primary resolver", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => receiptResponse());

    await expect(requestScaffoldSessionCopy(requestInput(), fetchMock)).resolves.toEqual(receipt);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [request, init] = fetchMock.mock.calls[0]!;
    expect(String(request)).toBe("http://127.0.0.1:4773/mounted/api/scaffold/session-transfer");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      headers: {
        authorization: "Bearer secondary-bearer",
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      operationId,
      deployment: "staging",
      sourceThreadId: "thread-source",
      create: {},
    });
    expect(String(init?.body)).not.toMatch(/base64|archive|bootstrap|credential|token/i);
  });

  it("uses cookie credentials for a local prepared connection without authorization", async () => {
    const prepared = secondaryPrepared({ httpAuthorization: null });
    const fetchMock = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("include");
      expect(init?.headers).toEqual({ "content-type": "application/json" });
      return receiptResponse();
    });

    await requestScaffoldSessionCopy(requestInput(prepared), fetchMock);
  });

  it("fails missing, mismatched, DPoP, and non-local sources before fetch", async () => {
    const fetchMock = vi.fn();
    const mismatched = secondaryPrepared({
      environmentId: EnvironmentId.make("different-environment"),
    });
    const dpop = secondaryPrepared({
      httpAuthorization: { _tag: "Dpop", accessToken: "dpop-token" },
    });
    const nonLocal = secondaryPrepared({
      target: new RelayConnectionTarget({
        environmentId: source.environmentId,
        label: "Remote relay",
      }),
    });

    await expect(requestScaffoldSessionCopy(requestInput(null), fetchMock)).rejects.toThrow(
      "not connected",
    );
    await expect(requestScaffoldSessionCopy(requestInput(mismatched), fetchMock)).rejects.toThrow(
      "does not match",
    );
    await expect(requestScaffoldSessionCopy(requestInput(dpop), fetchMock)).rejects.toThrow(
      "unsupported request authorization",
    );
    await expect(requestScaffoldSessionCopy(requestInput(nonLocal), fetchMock)).rejects.toThrow(
      "Only a connected local environment",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reconciles a server-side completion after the start response is lost", async () => {
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    const lostResponse = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (request, init) => {
        requests.push({ url: String(request), body: String(init?.body) });
        throw new TypeError("socket closed");
      })
      .mockImplementationOnce(async (request, init) => {
        requests.push({ url: String(request), body: String(init?.body) });
        return receiptResponse(receiptForOperationId(`${operationId}:attempt:2`));
      });

    await expect(requestScaffoldSessionCopy(requestInput(), lostResponse)).resolves.toMatchObject({
      operationId: `${operationId}:attempt:2`,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("http://127.0.0.1:4773/mounted/api/scaffold/session-transfer");
    expect(requests[1]?.url).toBe(
      "http://127.0.0.1:4773/mounted/api/scaffold/session-transfer/reconcile",
    );
    expect(requests[1]?.body).toBe(requests[0]?.body);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ operationId });

    const lostBody = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => Promise.reject(new TypeError("body interrupted")),
      } as unknown as Response)
      .mockResolvedValueOnce(receiptResponse());
    await requestScaffoldSessionCopy(requestInput(), lostBody);
    expect(lostBody).toHaveBeenCalledTimes(2);
    expect(lostBody.mock.calls[1]![1]?.body).toBe(lostBody.mock.calls[0]![1]?.body);
  });

  it("aborts a stalled start request and reconciles the same operation", async () => {
    vi.useFakeTimers();
    try {
      const requestBodies: string[] = [];
      const requestSignals: AbortSignal[] = [];
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async (_request, init) => {
          requestBodies.push(String(init?.body));
          const signal = init?.signal;
          if (signal === null || signal === undefined) {
            throw new Error("expected transfer request signal");
          }
          requestSignals.push(signal);
          return await new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        })
        .mockImplementationOnce(async (_request, init) => {
          requestBodies.push(String(init?.body));
          const signal = init?.signal;
          if (signal !== null && signal !== undefined) requestSignals.push(signal);
          return receiptResponse(receiptForOperationId(`${operationId}:attempt:2`));
        });

      const result = requestScaffoldSessionCopy(requestInput(), fetchMock);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(result).resolves.toMatchObject({ operationId: `${operationId}:attempt:2` });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requestSignals[0]?.aborted).toBe(true);
      expect(requestSignals[1]?.aborted).toBe(false);
      expect(requestBodies[1]).toBe(requestBodies[0]);
      expect(JSON.parse(requestBodies[0]!)).toMatchObject({ operationId });
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/session-transfer/reconcile");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the deadline active through a stalled response body and reconciles", async () => {
    vi.useFakeTimers();
    try {
      const requestBodies: string[] = [];
      let stalledBodySignal: AbortSignal | undefined;
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async (_request, init) => {
          requestBodies.push(String(init?.body));
          const signal = init?.signal;
          if (signal === null || signal === undefined) {
            throw new Error("expected transfer request signal");
          }
          stalledBodySignal = signal;
          return {
            ok: true,
            json: async () =>
              await new Promise<unknown>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
          } as Response;
        })
        .mockImplementationOnce(async (_request, init) => {
          requestBodies.push(String(init?.body));
          return receiptResponse(receiptForOperationId(`${operationId}:attempt:2`));
        });

      const result = requestScaffoldSessionCopy(requestInput(), fetchMock);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(result).resolves.toMatchObject({ operationId: `${operationId}:attempt:2` });
      expect(stalledBodySignal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requestBodies[1]).toBe(requestBodies[0]);
      expect(JSON.parse(requestBodies[0]!)).toMatchObject({ operationId });
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/session-transfer/reconcile");
    } finally {
      vi.useRealTimers();
    }
  });

  it("recreates the client after an unresolved outcome with the same logical series key", async () => {
    vi.useFakeTimers();
    try {
      const requestBodies: string[] = [];
      let firstCall = true;
      let resolveFirstFetch!: () => void;
      const firstFetch = new Promise<void>((resolve) => {
        resolveFirstFetch = resolve;
      });
      const fetchMock = vi.fn<typeof fetch>(async (_request, init) => {
        requestBodies.push(String(init?.body));
        if (firstCall) {
          resolveFirstFetch();
          throw new TypeError("response lost after commit");
        }
        return receiptResponse();
      });

      const unresolved = requestScaffoldSessionCopy(requestInput(), fetchMock);
      const settled = unresolved.then(
        (value) => ({ _tag: "Resolved" as const, value }),
        (error: unknown) => ({ _tag: "Rejected" as const, error }),
      );
      await firstFetch;
      await vi.advanceTimersByTimeAsync(31_000);
      const unresolvedOutcome = await settled;
      expect(unresolvedOutcome._tag).toBe("Rejected");
      if (unresolvedOutcome._tag === "Rejected") {
        expect(unresolvedOutcome.error).toMatchObject({
          message: "The local T3 session copy service could not determine the transfer outcome.",
        });
      }
      firstCall = false;
      await expect(requestScaffoldSessionCopy({ ...requestInput() }, fetchMock)).resolves.toEqual(
        receipt,
      );

      expect(new Set(requestBodies)).toEqual(
        new Set([
          JSON.stringify({
            operationId,
            deployment: "staging",
            sourceThreadId: source.threadId,
            create: {},
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a still-pending ambiguous transfer and confirms the terminal outcome", async () => {
    vi.useFakeTimers();
    try {
      const urls: string[] = [];
      const bodies: string[] = [];
      let abortSeen = false;
      const fetchMock = vi.fn<typeof fetch>(async (request, init) => {
        const url = String(request);
        urls.push(url);
        bodies.push(String(init?.body));
        if (urls.length === 1) {
          const signal = init?.signal;
          return await new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        if (url.endsWith("/abort")) {
          abortSeen = true;
          return receiptResponse({ ok: true });
        }
        if (!abortSeen) {
          return new Response(
            JSON.stringify({ error: "workspace_migration_source_reconciliation_pending" }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ error: "workspace_migration_source_operation_aborted" }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      });

      const result = requestScaffoldSessionCopy(requestInput(), fetchMock);
      const rejection = expect(result).rejects.toThrow("safely aborted");
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(urls[0]).toBe("http://127.0.0.1:4773/mounted/api/scaffold/session-transfer");
      expect(urls.filter((url) => url.endsWith("/abort"))).toHaveLength(1);
      expect(urls.at(-1)).toContain("/session-transfer/reconcile");
      expect(new Set(bodies)).toEqual(new Set([bodies[0]!]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps reconciling a healthy slow transfer instead of aborting it", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("start response lost"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "workspace_migration_source_reconciliation_pending" }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "workspace_migration_source_reconciliation_pending" }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(receiptResponse(receiptForOperationId(`${operationId}:attempt:2`)));

    await expect(requestScaffoldSessionCopy(requestInput(), fetchMock)).resolves.toMatchObject({
      operationId: `${operationId}:attempt:2`,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.some(([request]) => String(request).endsWith("/abort"))).toBe(
      false,
    );
    const bodies = fetchMock.mock.calls.map(([, init]) => String(init?.body));
    expect(new Set(bodies)).toEqual(new Set([bodies[0]!]));
  });

  it("reconciles a server-owned transfer already in progress without starting it again", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "workspace_migration_source_transfer_in_progress" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "workspace_migration_source_reconciliation_pending" }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(receiptResponse(receiptForOperationId(`${operationId}:attempt:2`)));

    await expect(requestScaffoldSessionCopy(requestInput(), fetchMock)).resolves.toMatchObject({
      operationId: `${operationId}:attempt:2`,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map(([request]) => String(request));
    expect(urls.filter((url) => url.endsWith("/session-transfer"))).toHaveLength(1);
    expect(urls.slice(1).every((url) => url.endsWith("/session-transfer/reconcile"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/abort"))).toBe(false);
    const bodies = fetchMock.mock.calls.map(([, init]) => String(init?.body));
    expect(new Set(bodies)).toEqual(new Set([bodies[0]!]));
  });

  it("accepts a new server generation after an aborted attempt without deriving it in the browser", async () => {
    const requestBodies: string[] = [];
    const abortedThenRestarted = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_request, init) => {
        requestBodies.push(String(init?.body));
        return new Response(
          JSON.stringify({ error: "workspace_migration_source_operation_aborted" }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        );
      })
      .mockImplementationOnce(async (_request, init) => {
        requestBodies.push(String(init?.body));
        return receiptResponse(receiptForOperationId(`${operationId}:attempt:2`));
      });

    await expect(requestScaffoldSessionCopy(requestInput(), abortedThenRestarted)).rejects.toThrow(
      "could not copy this session",
    );
    await expect(
      requestScaffoldSessionCopy(requestInput(), abortedThenRestarted),
    ).resolves.toMatchObject({ operationId: `${operationId}:attempt:2` });
    expect(requestBodies.map((body) => JSON.parse(body).operationId)).toEqual([
      operationId,
      operationId,
    ]);
  });

  it("replays a completed server attempt while continuing to send only the logical series key", async () => {
    const requestBodies: string[] = [];
    const completedAttempt = receiptForOperationId(`${operationId}:attempt:10`);
    const fetchMock = vi.fn<typeof fetch>(async (_request, init) => {
      requestBodies.push(String(init?.body));
      return receiptResponse(completedAttempt);
    });

    await expect(requestScaffoldSessionCopy(requestInput(), fetchMock)).resolves.toEqual(
      completedAttempt,
    );
    await expect(requestScaffoldSessionCopy(requestInput(), fetchMock)).resolves.toEqual(
      completedAttempt,
    );
    expect(requestBodies.map((body) => JSON.parse(body).operationId)).toEqual([
      operationId,
      operationId,
    ]);
  });

  it("rejects malformed or unrelated physical attempt ids from the receipt", async () => {
    for (const invalidOperationId of [
      `${operationId}:attempt:1`,
      `${operationId}:attempt:02`,
      `${operationId}:attempt:${Number.MAX_SAFE_INTEGER + 1}`,
      `${operationId}:attempt:2:extra`,
      `${operationId.slice(0, -1)}0:attempt:2`,
    ]) {
      await expect(
        requestScaffoldSessionCopy(requestInput(), async () =>
          receiptResponse(receiptForOperationId(invalidOperationId)),
        ),
      ).rejects.toThrow("mismatched identity");
    }
  });

  it("rejects invalid status, global identity, and OMP continuity before registration", async () => {
    const register = vi.fn(async () => ({ environmentId: binding.environmentId }));
    const cases = [
      new ScaffoldWorkspaceMigrationReceipt({
        ...receipt,
        binding: new ScaffoldEnvironmentBinding({ ...binding, status: "paused" }),
      }),
      new ScaffoldWorkspaceMigrationReceipt({
        ...receipt,
        source: { ...receipt.source, globalSessionId: "sf:wrong:source" },
      }),
      new ScaffoldWorkspaceMigrationReceipt({
        ...receipt,
        destination: { ...receipt.destination, globalSessionId: "sf:wrong:destination" },
      }),
      new ScaffoldWorkspaceMigrationReceipt({
        ...receipt,
        destination: { ...receipt.destination, ompSessionId: receipt.source.ompSessionId },
      }),
    ];

    for (const invalid of cases) {
      await expect(
        copyScaffoldSessionAndRegister({
          ...requestInput(),
          register,
          fetchImpl: async () => receiptResponse(invalid),
        }),
      ).rejects.toThrow("mismatched identity");
    }
    expect(register).not.toHaveBeenCalled();
  });

  it("registers before returning the registered environment for navigation", async () => {
    const events: string[] = [];
    const register = vi.fn(async () => {
      events.push("register");
      return { environmentId: binding.environmentId };
    });

    const destination = await copyScaffoldSessionAndRegister({
      ...requestInput(),
      register,
      fetchImpl: async () => {
        events.push("request");
        return receiptResponse();
      },
    });
    events.push(`navigate:${destination.environmentId}:${destination.threadId}`);

    expect(events).toEqual([
      "request",
      "register",
      "navigate:environment-scaffold:thread-destination",
    ]);
  });

  it("registers a receipt recovered through server reconciliation", async () => {
    const register = vi.fn(async () => ({ environmentId: binding.environmentId }));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("start response lost"))
      .mockResolvedValueOnce(receiptResponse());

    await expect(
      copyScaffoldSessionAndRegister({
        ...requestInput(),
        register,
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({
      environmentId: binding.environmentId,
      threadId: receipt.destination.threadId,
    });
    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith(binding);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/session-transfer/reconcile");
  });

  it("blocks navigation when registration fails or returns another environment", async () => {
    const navigate = vi.fn();
    await expect(
      copyScaffoldSessionAndRegister({
        ...requestInput(),
        register: async () => Promise.reject(new Error("registry failed")),
        fetchImpl: async () => receiptResponse(),
      }).then(navigate),
    ).rejects.toThrow("registry failed");
    await expect(
      copyScaffoldSessionAndRegister({
        ...requestInput(),
        register: async () => ({ environmentId: EnvironmentId.make("wrong-environment") }),
        fetchImpl: async () => receiptResponse(),
      }).then(navigate),
    ).rejects.toThrow("registered Scaffold environment has mismatched identity");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("accepts the primary prepared connection only when its exact identity matches", async () => {
    const primarySource = {
      ...source,
      environmentId: EnvironmentId.make("primary"),
    };
    const primaryReceipt = new ScaffoldWorkspaceMigrationReceipt({
      ...receipt,
      operationId: await scaffoldSessionTransferOperationId({
        sourceEnvironmentId: primarySource.environmentId,
        sourceThreadId: primarySource.threadId,
        deployment: "staging",
      }),
      source: {
        ...receipt.source,
        environmentId: primarySource.environmentId,
        globalSessionId: `sf:${primarySource.environmentId}:${primarySource.threadId}`,
      },
    });
    const primary: PreparedConnection = {
      environmentId: primarySource.environmentId,
      label: "This device",
      httpBaseUrl: "http://localhost:3773",
      socketUrl: "ws://localhost:3773/ws",
      httpAuthorization: null,
      target: new PrimaryConnectionTarget({
        environmentId: primarySource.environmentId,
        label: "This device",
        httpBaseUrl: "http://localhost:3773",
        wsBaseUrl: "ws://localhost:3773",
      }),
    };

    await expect(
      requestScaffoldSessionCopy({ ...requestInput(primary), source: primarySource }, async () =>
        receiptResponse(primaryReceipt),
      ),
    ).resolves.toEqual(primaryReceipt);
  });

  it("builds the persisted target from the returned binding without credentials", () => {
    const registration = scaffoldSessionCopyRegistration(binding, "Scaffold staging");

    expect(registration.target).toMatchObject({
      environmentId: binding.environmentId,
      deployment: "staging",
      sessionId: binding.sessionId,
      lifecycleEpoch: binding.lifecycleEpoch,
      label: "Scaffold staging",
    });
    expect(JSON.stringify(registration)).not.toMatch(/credential|bootstrap|token/i);
  });
});
