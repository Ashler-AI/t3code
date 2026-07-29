// @effect-diagnostics globalTimers:off - Focused tests exercise the bounded host-side deployment probe.
import { describe, expect, it } from "@effect/vitest";

import {
  DEPLOYMENT_SMOKE_EMPTY_SESSION_ID,
  DEPLOYMENT_SMOKE_SESSION_ID,
  buildDeploymentSmokeFrames,
  runDeploymentSmoke,
  type DeploymentSmokeSocket,
  verifyDeploymentSmokeSnapshot,
  waitForDeploymentCoordinatorReadiness,
} from "./deploymentSmoke.ts";

const NOW = "2026-07-25T20:00:00.000Z";
const SCAFFOLD_ORIGIN = "https://proof.scaffold.example";
const VIEWER_CAPABILITY = "viewer.header.signature";
const RUNNER_CAPABILITY = "runner.header.signature";

const authenticatedSmokeInput = {
  scaffoldOrigin: SCAFFOLD_ORIGIN,
  viewerCapability: VIEWER_CAPABILITY,
  runnerCapability: RUNNER_CAPABILITY,
} as const;

function requiredAuthGate(input: RequestInfo | URL, init?: RequestInit): Response | null {
  const url = new URL(input instanceof Request ? input.url : input);
  const headers = new Headers(init?.headers);
  if (init?.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { "access-control-allow-origin": headers.get("origin") ?? "" },
    });
  }
  if (headers.get("authorization") === null) return new Response(null, { status: 401 });
  return url.pathname === "/v1/session-fabric/sessions" ? Response.json({ sessions: [] }) : null;
}

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
  it("waits for an existing coordinator instance to accept the deployed verifier", async () => {
    const [, publication] = buildDeploymentSmokeFrames({ marker: "existing", now: NOW });
    if (publication.type !== "session.publish-snapshot") throw new Error("unexpected frame");
    const responses = [
      new Response(null, { status: 401 }),
      new Response(null, { status: 429 }),
      new Response(null, { status: 503 }),
      Response.json(publication.published.snapshot),
    ];
    const authorizations: string[] = [];
    const paths: string[] = [];

    await expect(
      waitForDeploymentCoordinatorReadiness({
        relayUrl: new URL("https://fabric.example"),
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        viewerCapability: VIEWER_CAPABILITY,
        fetch: async (input, init) => {
          paths.push(new URL(input instanceof Request ? input.url : input).pathname);
          authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
          return responses.shift() ?? Response.json(publication.published.snapshot);
        },
      }),
    ).resolves.toBeUndefined();

    expect(authorizations).toEqual([
      `Bearer ${VIEWER_CAPABILITY}`,
      `Bearer ${VIEWER_CAPABILITY}`,
      `Bearer ${VIEWER_CAPABILITY}`,
      `Bearer ${VIEWER_CAPABILITY}`,
    ]);
    expect(paths).toEqual(
      Array.from(
        { length: 4 },
        () => "/v1/session-fabric/sessions/deployment-smoke-proof-v1/snapshot",
      ),
    );
  });

  it("retries bounded network failures under the same readiness deadline", async () => {
    const [, publication] = buildDeploymentSmokeFrames({ marker: "existing", now: NOW });
    if (publication.type !== "session.publish-snapshot") throw new Error("unexpected frame");
    let attempts = 0;

    await expect(
      waitForDeploymentCoordinatorReadiness({
        relayUrl: new URL("https://fabric.example"),
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        viewerCapability: VIEWER_CAPABILITY,
        fetch: async () => {
          attempts += 1;
          if (attempts < 3) throw new TypeError("fetch failed");
          return Response.json(publication.published.snapshot);
        },
      }),
    ).resolves.toBeUndefined();

    expect(attempts).toBe(3);
  });

  it("fails fast on permanent readiness statuses and missing state", async () => {
    await expect(
      waitForDeploymentCoordinatorReadiness({
        relayUrl: new URL("https://fabric.example"),
        timeoutMs: 1_000,
        viewerCapability: VIEWER_CAPABILITY,
        fetch: async () => new Response(null, { status: 403 }),
      }),
    ).rejects.toThrow("unexpected status 403");

    await expect(
      waitForDeploymentCoordinatorReadiness({
        relayUrl: new URL("https://fabric.example"),
        timeoutMs: 1_000,
        viewerCapability: VIEWER_CAPABILITY,
        fetch: async () => new Response(null, { status: 404 }),
      }),
    ).rejects.toThrow("pre-existing deployment smoke coordinator is missing");
  });

  it("allows an explicitly gated missing coordinator only for fresh bootstrap", async () => {
    await expect(
      waitForDeploymentCoordinatorReadiness({
        relayUrl: new URL("https://fabric.example"),
        timeoutMs: 1_000,
        viewerCapability: VIEWER_CAPABILITY,
        allowMissingBootstrap: true,
        fetch: async () => new Response(null, { status: 404 }),
      }),
    ).resolves.toBeUndefined();
  });

  it("bounds repeated transient readiness failures with one deadline", async () => {
    await expect(
      waitForDeploymentCoordinatorReadiness({
        relayUrl: new URL("https://fabric.example"),
        timeoutMs: 5,
        pollIntervalMs: 1,
        viewerCapability: VIEWER_CAPABILITY,
        fetch: async () => new Response(null, { status: 502 }),
      }),
    ).rejects.toThrow("did not accept the deployed verifier before the readiness deadline");
  });

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
          session: { initialPrompt: "run-42", publication: "public" },
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
    let protocols: ReadonlyArray<string> | undefined;
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
    const requests: Array<{
      readonly method: string;
      readonly authorization: string;
      readonly origin: string;
      readonly pathname: string;
    }> = [];
    const fetchClient: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      urls.push(url);
      const headers = new Headers(init?.headers);
      requests.push({
        method: init?.method ?? "GET",
        authorization: headers.get("authorization") ?? "",
        origin: headers.get("origin") ?? "",
        pathname: url.pathname,
      });
      const gated = requiredAuthGate(input, init);
      if (gated !== null) return gated;
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
      ...authenticatedSmokeInput,
      createWebSocket: (url, selectedProtocols) => {
        protocols = selectedProtocols;
        return (socket = new TestSocket(url, urls));
      },
    });

    expect(result).toMatchObject({ marker: "run-84", sessionId: DEPLOYMENT_SMOKE_SESSION_ID });
    expect(urls[0]?.pathname).toBe("/base/v1/session-fabric/sessions");
    expect(urls.some((url) => url.protocol === "wss:")).toBe(true);
    expect(proofPolls).toBe(4);
    expect(socket?.sent.map((frame) => JSON.parse(frame).type)).toEqual([
      "runner.hello",
      "session.publish-snapshot",
    ]);
    expect(socket?.readyState).toBe(3);
    expect(socket?.closeCalls).toBe(1);
    expect(requests.slice(0, 4)).toEqual([
      {
        method: "GET",
        authorization: "",
        origin: "",
        pathname: "/base/v1/session-fabric/sessions",
      },
      {
        method: "GET",
        authorization: "",
        origin: "",
        pathname: "/base/v1/session-fabric/sessions/deployment-smoke-empty-v1/snapshot",
      },
      {
        method: "OPTIONS",
        authorization: "",
        origin: SCAFFOLD_ORIGIN,
        pathname: "/base/v1/session-fabric/sessions",
      },
      {
        method: "GET",
        authorization: `Bearer ${VIEWER_CAPABILITY}`,
        origin: "",
        pathname: "/base/v1/session-fabric/sessions/deployment-smoke-empty-v1/snapshot",
      },
    ]);
    expect(
      requests
        .filter((request) => request.method === "GET" && request.pathname.endsWith("/snapshot"))
        .map((request) => request.authorization),
    ).toEqual(["", ...Array.from({ length: 5 }, () => `Bearer ${VIEWER_CAPABILITY}`)]);
    expect(protocols).toEqual([
      "t3.session-fabric.v1",
      "t3.session-fabric.capability.runner.header.signature",
    ]);
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
    const fetchClient: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const gated = requiredAuthGate(input, init);
      if (gated !== null) return gated;
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
        ...authenticatedSmokeInput,
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
    const fetchClient: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const gated = requiredAuthGate(input, init);
      if (gated !== null) return gated;
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
        ...authenticatedSmokeInput,
        createWebSocket: (url) => (socket = new TestSocket(url, urls, false)),
      }),
    ).rejects.toThrow("timed out waiting for WebSocket close");

    expect(socket?.closeCalls).toBe(1);
  });

  it("fails closed when the stable empty coordinator already has state", async () => {
    const fetchClient: typeof fetch = async (input, init) =>
      requiredAuthGate(input, init) ?? Response.json({ unexpected: true });

    await expect(
      runDeploymentSmoke({
        relayUrl: new URL("https://fabric.example"),
        marker: "run-126",
        timeoutMs: 1_000,
        fetch: fetchClient,
        ...authenticatedSmokeInput,
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
        ...authenticatedSmokeInput,
        createWebSocket: () => {
          throw new Error("WebSocket must not be created");
        },
      }),
    ).rejects.toThrow("deployment smoke timed out");
  });
});
