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
  readonly emitClose: boolean;
  closeCalls = 0;
  serverCloseHandled = false;
  readonly #listeners = {
    open: new Set<() => void>(),
    error: new Set<() => void>(),
    close: new Set<() => void>(),
  };

  constructor(url: URL, urls: URL[], emitClose = true) {
    this.urls = urls;
    this.emitClose = emitClose;
    this.urls.push(url);
    queueMicrotask(() => {
      this.readyState = 1;
      for (const listener of this.#listeners.open) listener();
    });
  }

  addEventListener(type: "open" | "error" | "close", listener: () => void): void {
    this.#listeners[type].add(listener);
  }

  removeEventListener(type: "open" | "error" | "close", listener: () => void): void {
    this.#listeners[type].delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 2;
    if (!this.emitClose) return;
    queueMicrotask(() => {
      this.readyState = 3;
      this.serverCloseHandled = true;
      for (const listener of this.#listeners.close) listener();
    });
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

  it("waits for disconnect handling and the retained offline snapshot before succeeding", async () => {
    const urls: URL[] = [];
    let socket: TestSocket | undefined;
    let proofPolls = 0;
    const [, stalePublication] = buildDeploymentSmokeFrames({ marker: "old-run", now: NOW });
    const [, publication] = buildDeploymentSmokeFrames({ marker: "run-84", now: NOW });
    if (stalePublication.type !== "session.publish-snapshot") throw new Error("unexpected frame");
    if (publication.type !== "session.publish-snapshot") throw new Error("unexpected frame");
    const offlineSnapshot = {
      ...publication.published.snapshot,
      session: { ...publication.published.snapshot.session, runnerState: "offline" as const },
    };
    const fetchClient: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      urls.push(url);
      if (url.pathname.includes(DEPLOYMENT_SMOKE_EMPTY_SESSION_ID)) {
        return new Response(null, { status: 404 });
      }
      proofPolls += 1;
      if (proofPolls === 1) return new Response(null, { status: 404 });
      if (proofPolls === 2) return Response.json(stalePublication.published.snapshot);
      if (proofPolls === 3) return Response.json(publication.published.snapshot);
      if (!socket?.serverCloseHandled)
        throw new Error("offline snapshot polled before close handling");
      return Response.json(offlineSnapshot);
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
    expect(proofPolls).toBe(4);
    expect(socket?.sent.map((frame) => JSON.parse(frame).type)).toEqual([
      "runner.hello",
      "session.publish-snapshot",
    ]);
    expect(socket?.readyState).toBe(3);
    expect(socket?.closeCalls).toBe(1);
  });

  it("rejects post-disconnect snapshots with the wrong sequence or identity", async () => {
    const urls: URL[] = [];
    let socket: TestSocket | undefined;
    let postDisconnectPolls = 0;
    const [, publication] = buildDeploymentSmokeFrames({ marker: "run-identity", now: NOW });
    if (publication.type !== "session.publish-snapshot") throw new Error("unexpected frame");
    const offlineSnapshot = {
      ...publication.published.snapshot,
      session: { ...publication.published.snapshot.session, runnerState: "offline" as const },
    };
    const wrongSequence = {
      ...offlineSnapshot,
      session: {
        ...offlineSnapshot.session,
        cursor: { ...offlineSnapshot.session.cursor, snapshotSequence: 2 },
      },
    };
    const wrongIdentity = {
      ...offlineSnapshot,
      session: {
        ...offlineSnapshot.session,
        location: { ...offlineSnapshot.session.location, environmentId: "wrong-environment" },
      },
    };
    const fetchClient: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.includes(DEPLOYMENT_SMOKE_EMPTY_SESSION_ID)) {
        return new Response(null, { status: 404 });
      }
      if (!socket?.serverCloseHandled) return Response.json(publication.published.snapshot);
      postDisconnectPolls += 1;
      if (postDisconnectPolls === 1) return Response.json(wrongSequence);
      if (postDisconnectPolls === 2) return Response.json(wrongIdentity);
      return Response.json(offlineSnapshot);
    };

    await expect(
      runDeploymentSmoke({
        relayUrl: new URL("https://fabric.example"),
        marker: "run-identity",
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        fetch: fetchClient,
        createWebSocket: (url) => (socket = new TestSocket(url, urls)),
      }),
    ).resolves.toMatchObject({ marker: "run-identity" });

    expect(postDisconnectPolls).toBe(3);
    expect(socket?.closeCalls).toBe(1);
  });

  it("bounds the WebSocket close handshake without closing twice", async () => {
    const urls: URL[] = [];
    let socket: TestSocket | undefined;
    const [, publication] = buildDeploymentSmokeFrames({ marker: "run-close-timeout", now: NOW });
    if (publication.type !== "session.publish-snapshot") throw new Error("unexpected frame");
    const fetchClient: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return url.pathname.includes(DEPLOYMENT_SMOKE_EMPTY_SESSION_ID)
        ? new Response(null, { status: 404 })
        : Response.json(publication.published.snapshot);
    };

    await expect(
      runDeploymentSmoke({
        relayUrl: new URL("https://fabric.example"),
        marker: "run-close-timeout",
        timeoutMs: 25,
        pollIntervalMs: 1,
        fetch: fetchClient,
        createWebSocket: (url) => (socket = new TestSocket(url, urls, false)),
      }),
    ).rejects.toThrow("timed out waiting for WebSocket close");

    expect(socket?.closeCalls).toBe(1);
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
