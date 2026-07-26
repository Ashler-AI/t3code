// @effect-diagnostics globalTimers:off - Focused tests exercise the bounded host-side deployment probe.
import { describe, expect, it } from "@effect/vitest";

import {
  DEPLOYMENT_SMOKE_EMPTY_SESSION_ID,
  DEPLOYMENT_SMOKE_SESSION_ID,
  buildDeploymentSmokeFrames,
  runDeploymentSmoke,
  type DeploymentSmokeSocket,
  verifyDeploymentSmokeSnapshot,
} from "./deploymentSmoke.ts";

const NOW = "2026-07-25T20:00:00.000Z";

class TestSocket implements DeploymentSmokeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly urls: URL[];
  readonly #listeners = {
    open: new Set<() => void>(),
    error: new Set<() => void>(),
  };

  constructor(url: URL, urls: URL[]) {
    this.urls = urls;
    this.urls.push(url);
    queueMicrotask(() => {
      this.readyState = 1;
      for (const listener of this.#listeners.open) listener();
    });
  }

  addEventListener(type: "open" | "error", listener: () => void): void {
    this.#listeners[type].add(listener);
  }

  removeEventListener(type: "open" | "error", listener: () => void): void {
    this.#listeners[type].delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

describe("session fabric deployment smoke", () => {
  it("builds valid runner hello and snapshot publication frames with stable identity", () => {
    const [hello, publication] = buildDeploymentSmokeFrames({ marker: "run-42", now: NOW });

    expect(hello).toMatchObject({
      type: "runner.hello",
      hello: {
        sessionId: DEPLOYMENT_SMOKE_SESSION_ID,
        runnerId: "deployment-smoke-runner-v1",
      },
    });
    expect(publication).toMatchObject({
      type: "session.publish-snapshot",
      published: {
        sessionId: DEPLOYMENT_SMOKE_SESSION_ID,
        runnerId: "deployment-smoke-runner-v1",
        snapshot: {
          session: { initialPrompt: "run-42", publication: "local_only" },
          thread: { thread: { id: "deployment-smoke-thread-v1" } },
        },
      },
    });
  });

  it("rejects a schema-valid snapshot carrying a stale marker", () => {
    const [, publication] = buildDeploymentSmokeFrames({ marker: "old-run", now: NOW });
    if (publication.type !== "session.publish-snapshot") throw new Error("unexpected frame");

    expect(() => verifyDeploymentSmokeSnapshot(publication.published.snapshot, "new-run")).toThrow(
      "did not match the published marker and identity",
    );
  });

  it("requires the empty coordinator to be absent, publishes over WebSocket, and polls to 200", async () => {
    const urls: URL[] = [];
    let socket: TestSocket | undefined;
    let proofPolls = 0;
    const [, stalePublication] = buildDeploymentSmokeFrames({ marker: "old-run", now: NOW });
    const [, publication] = buildDeploymentSmokeFrames({ marker: "run-84", now: NOW });
    if (stalePublication.type !== "session.publish-snapshot") throw new Error("unexpected frame");
    if (publication.type !== "session.publish-snapshot") throw new Error("unexpected frame");
    const fetchClient: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      urls.push(url);
      if (url.pathname.includes(DEPLOYMENT_SMOKE_EMPTY_SESSION_ID)) {
        return new Response(null, { status: 404 });
      }
      proofPolls += 1;
      if (proofPolls === 1) return new Response(null, { status: 404 });
      return Response.json(
        proofPolls === 2 ? stalePublication.published.snapshot : publication.published.snapshot,
      );
    };

    const result = await runDeploymentSmoke({
      relayUrl: new URL("https://fabric.example/base/"),
      marker: "run-84",
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      fetch: fetchClient,
      createWebSocket: (url) => (socket = new TestSocket(url, urls)),
    });

    expect(result).toMatchObject({ marker: "run-84", sessionId: DEPLOYMENT_SMOKE_SESSION_ID });
    expect(urls[0]?.pathname).toContain(`${DEPLOYMENT_SMOKE_EMPTY_SESSION_ID}/snapshot`);
    expect(urls.some((url) => url.protocol === "wss:")).toBe(true);
    expect(proofPolls).toBe(3);
    expect(socket?.sent.map((frame) => JSON.parse(frame).type)).toEqual([
      "runner.hello",
      "session.publish-snapshot",
    ]);
    expect(socket?.readyState).toBe(3);
  });

  it("fails closed when the stable empty coordinator already has state", async () => {
    const fetchClient: typeof fetch = async () => Response.json({ unexpected: true });

    await expect(
      runDeploymentSmoke({
        relayUrl: new URL("https://fabric.example"),
        marker: "run-126",
        timeoutMs: 1_000,
        fetch: fetchClient,
        createWebSocket: () => {
          throw new Error("WebSocket must not be created");
        },
      }),
    ).rejects.toThrow("returned status 200, not 404");
  });

  it("bounds a hanging HTTP request with the overall timeout", async () => {
    const fetchClient: typeof fetch = () => new Promise<Response>(() => undefined);

    await expect(
      runDeploymentSmoke({
        relayUrl: new URL("https://fabric.example"),
        marker: "run-timeout",
        timeoutMs: 5,
        fetch: fetchClient,
        createWebSocket: () => {
          throw new Error("WebSocket must not be created");
        },
      }),
    ).rejects.toThrow("deployment smoke timed out");
  });
});
