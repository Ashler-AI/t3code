import * as NodeCrypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  SCAFFOLD_WAKE_SIGNATURE_HEADER,
  SCAFFOLD_WAKE_TIMESTAMP_HEADER,
  ScaffoldWakeAuthorityConfigError,
  scaffoldWakeAuthoritySignature,
  validateScaffoldWakeAuthorityConfig,
  wakeScaffoldSession,
} from "./ScaffoldWakeAuthority.ts";

const request = {
  fabricSessionId: "fabric-1",
  commandId: "command-1",
  scaffoldSessionId: "scaffold-1",
  expectedLifecycleEpoch: 4,
  actorId: "actor-1",
};

const config = () =>
  validateScaffoldWakeAuthorityConfig({
    endpoint: "https://scaffold.example/api/session-fabric/wake",
    sharedSecret: "shared-secret",
    timeoutMs: 50,
  })!;

const successResponse = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  version: "scaffold.session_fabric.wake_result.v1",
  fabricSessionId: request.fabricSessionId,
  commandId: request.commandId,
  scaffoldSessionId: request.scaffoldSessionId,
  expectedLifecycleEpoch: request.expectedLifecycleEpoch,
  targetLifecycleEpoch: request.expectedLifecycleEpoch + 1,
  status: "resuming",
  deduplicated: false,
  ...overrides,
});

describe("ScaffoldWakeAuthority", () => {
  it("treats absent config as unavailable and rejects partial or unsafe config", async () => {
    expect(validateScaffoldWakeAuthorityConfig()).toBeNull();
    expect(validateScaffoldWakeAuthorityConfig({ endpoint: null, sharedSecret: null })).toBeNull();
    expect(() => validateScaffoldWakeAuthorityConfig({ endpoint: "", sharedSecret: "" })).toThrow(
      ScaffoldWakeAuthorityConfigError,
    );
    expect(() =>
      validateScaffoldWakeAuthorityConfig({ endpoint: "https://scaffold.example/wake" }),
    ).toThrow(ScaffoldWakeAuthorityConfigError);
    expect(() =>
      validateScaffoldWakeAuthorityConfig({ endpoint: "file:///tmp/wake", sharedSecret: "secret" }),
    ).toThrow("must use HTTP or HTTPS");
    expect(() =>
      validateScaffoldWakeAuthorityConfig({
        endpoint: "https://user:password@scaffold.example/wake",
        sharedSecret: "secret",
      }),
    ).toThrow("must not contain credentials");

    await expect(wakeScaffoldSession(null, request)).resolves.toMatchObject({
      ok: false,
      classification: "unavailable",
      code: "not_configured",
    });
  });

  it("signs the exact raw body deterministically and sends the signature headers", async () => {
    const timestamp = "1785450123456";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const rawBody = String(init?.body);
      const expected = NodeCrypto.createHmac("sha256", "shared-secret")
        .update(`${timestamp}.${rawBody}`)
        .digest("hex");
      const headers = new Headers(init?.headers);

      expect(init?.method).toBe("POST");
      expect(JSON.parse(rawBody)).toEqual({
        version: "scaffold.session_fabric.wake.v1",
        ...request,
      });
      expect(headers.get(SCAFFOLD_WAKE_TIMESTAMP_HEADER)).toBe(timestamp);
      expect(headers.get(SCAFFOLD_WAKE_SIGNATURE_HEADER)).toBe(expected);
      return Response.json(successResponse());
    });

    const rawBody = JSON.stringify({ version: "scaffold.session_fabric.wake.v1", ...request });
    await expect(
      scaffoldWakeAuthoritySignature({
        sharedSecret: "shared-secret",
        timestamp,
        rawBody,
      }),
    ).resolves.toBe(
      NodeCrypto.createHmac("sha256", "shared-secret")
        .update(`${timestamp}.${rawBody}`)
        .digest("hex"),
    );
    await expect(
      wakeScaffoldSession(config(), request, { fetch, now: () => Number(timestamp) }),
    ).resolves.toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("classifies a bounded request timeout as retryable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => undefined));
    const result = await wakeScaffoldSession({ ...config(), timeoutMs: 5 }, request, { fetch });

    expect(result).toMatchObject({
      ok: false,
      classification: "retryable",
      code: "timeout",
    });
  });

  it("classifies 5xx responses as retryable without reflecting the response body", async () => {
    const result = await wakeScaffoldSession(config(), request, {
      fetch: vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ secret: "must-not-leak" }, { status: 503 }),
      ),
    });

    expect(result).toEqual({
      ok: false,
      classification: "retryable",
      code: "retryable_status",
      message: "Scaffold wake authority returned HTTP 503.",
      status: 503,
    });
  });

  it("rejects mismatched identity and any lifecycle response other than the exact next epoch", async () => {
    const mismatched = await wakeScaffoldSession(config(), request, {
      fetch: vi.fn<typeof globalThis.fetch>(async () =>
        Response.json(successResponse({ commandId: "different-command" })),
      ),
    });
    const stale = await wakeScaffoldSession(config(), request, {
      fetch: vi.fn<typeof globalThis.fetch>(async () =>
        Response.json(successResponse({ targetLifecycleEpoch: request.expectedLifecycleEpoch })),
      ),
    });
    const skipped = await wakeScaffoldSession(config(), request, {
      fetch: vi.fn<typeof globalThis.fetch>(async () =>
        Response.json(
          successResponse({ targetLifecycleEpoch: request.expectedLifecycleEpoch + 2 }),
        ),
      ),
    });

    expect(mismatched).toMatchObject({
      ok: false,
      classification: "terminal",
      code: "response_mismatch",
    });
    expect(stale).toMatchObject({
      ok: false,
      classification: "terminal",
      code: "response_mismatch",
    });
    expect(skipped).toMatchObject({
      ok: false,
      classification: "terminal",
      code: "response_mismatch",
    });
  });

  it.each(["resuming", "ready", "agent_running"] as const)(
    "accepts a bound, advancing %s response",
    async (status) => {
      const response = successResponse({ status, deduplicated: status === "ready" });
      await expect(
        wakeScaffoldSession(config(), request, {
          fetch: vi.fn<typeof globalThis.fetch>(async () => Response.json(response)),
        }),
      ).resolves.toEqual({ ok: true, response });
    },
  );

  it("accepts a bound 202 response so the relay can keep polling for the runner snapshot", async () => {
    const response = successResponse({ status: "resuming" });
    await expect(
      wakeScaffoldSession(config(), request, {
        fetch: vi.fn<typeof globalThis.fetch>(async () => Response.json(response, { status: 202 })),
      }),
    ).resolves.toEqual({ ok: true, response });
  });
});
