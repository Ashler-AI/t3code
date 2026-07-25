import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeScaffoldControlPlaneClient } from "./client.ts";
import { executeScaffoldLifecycleAction } from "./executor.ts";
import { makeScaffoldLifecycleAction } from "./outbox.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const observation = (status: string, lifecycleEpoch: number) => ({
  sessionId: "session-1",
  status,
  lifecycleEpoch,
});

function createAction() {
  return makeScaffoldLifecycleAction({
    actionId: "stable-operation-1",
    kind: "create",
    environmentId: EnvironmentId.make("env-1"),
    connectionId: "connection-1",
    sessionId: "session-1",
    expectedLifecycleEpoch: 0,
    createdAt: "2026-07-24T19:00:00.000Z",
    create: { sourceRef: "main", snapshotId: "snapshot-1", name: "Agent" },
  });
}

describe("executeScaffoldLifecycleAction", () => {
  it("reuses stable create and operation ids after an ambiguous timeout", async () => {
    const posts: Array<Record<string, unknown>> = [];
    let request = 0;
    const client = makeScaffoldControlPlaneClient({
      deployment: "staging",
      baseUrl: "https://scaffold.example.com",
      fetch: async (_url, init) => {
        request += 1;
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        }
        if (request <= 2) throw new TypeError("timeout with sensitive network details");
        return init?.method === "POST"
          ? jsonResponse(observation("creating", 0))
          : jsonResponse(observation("ready", 0));
      },
    });
    const action = createAction();

    await expect(executeScaffoldLifecycleAction({ client, action })).resolves.toMatchObject({
      _tag: "retry",
    });
    await expect(executeScaffoldLifecycleAction({ client, action })).resolves.toEqual({
      _tag: "acknowledged",
    });

    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      id: "session-1",
      operationId: "stable-operation-1",
      sourceRef: "main",
      snapshotId: "snapshot-1",
      name: "Agent",
    });
    expect(posts[1]).toEqual(posts[0]);
  });

  it("performs an authoritative GET after a 409 before reconciling", async () => {
    const methods: string[] = [];
    const client = makeScaffoldControlPlaneClient({
      deployment: "staging",
      baseUrl: "https://scaffold.example.com",
      fetch: async (_url, init) => {
        methods.push(init?.method ?? "GET");
        return init?.method === "POST"
          ? jsonResponse({ error: "lifecycle_conflict" }, 409)
          : jsonResponse(observation("ready", 2));
      },
    });
    const action = makeScaffoldLifecycleAction({
      actionId: "resume-operation-1",
      kind: "resume",
      environmentId: EnvironmentId.make("env-1"),
      connectionId: "connection-1",
      sessionId: "session-1",
      expectedLifecycleEpoch: 2,
      createdAt: "2026-07-24T19:00:00.000Z",
    });

    await expect(executeScaffoldLifecycleAction({ client, action })).resolves.toEqual({
      _tag: "acknowledged",
    });
    expect(methods).toEqual(["POST", "GET"]);
  });

  it("blocks a stopped session discovered after an ambiguous failure", async () => {
    const client = makeScaffoldControlPlaneClient({
      deployment: "staging",
      baseUrl: "https://scaffold.example.com",
      fetch: async (_url, init) =>
        init?.method === "POST"
          ? jsonResponse({ error: "upstream_unavailable" }, 503)
          : jsonResponse(observation("stopped", 0)),
    });

    await expect(
      executeScaffoldLifecycleAction({ client, action: createAction() }),
    ).resolves.toEqual({ _tag: "blocked", errorCode: "session_stopped" });
  });
});
