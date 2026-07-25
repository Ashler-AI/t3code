import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ScaffoldLifecycleAction, normalizeScaffoldControlPlaneBaseUrl } from "./model.ts";
import { makeScaffoldLifecycleAction } from "./outbox.ts";

const decodeScaffoldLifecycleAction = Schema.decodeUnknownSync(ScaffoldLifecycleAction);

describe("Scaffold lifecycle model", () => {
  it("normalizes only credential-free HTTPS origins without echoing rejected input", () => {
    expect(normalizeScaffoldControlPlaneBaseUrl(" https://scaffold.example.com ")).toBe(
      "https://scaffold.example.com/",
    );
    const secretUrl = "https://user:secret@scaffold.example.com/path?token=private#fragment";
    expect(() => normalizeScaffoldControlPlaneBaseUrl(secretUrl)).toThrow(
      "Invalid Scaffold control-plane URL.",
    );
    try {
      normalizeScaffoldControlPlaneBaseUrl(secretUrl);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
      expect(String(error)).not.toContain("private");
    }
  });

  it("persists create parameters only on create actions and strips credentials", () => {
    const action = decodeScaffoldLifecycleAction({
      ...makeScaffoldLifecycleAction({
        actionId: "operation-1",
        kind: "create",
        environmentId: EnvironmentId.make("env-1"),
        connectionId: "connection-1",
        sessionId: "session-1",
        expectedLifecycleEpoch: 0,
        createdAt: "2026-07-24T19:00:00.000Z",
        create: { sourceRef: "main", snapshotId: "snapshot-1", name: "Agent" },
      }),
      token: "must-not-persist",
    });

    expect(action.kind).toBe("create");
    if (action.kind !== "create") throw new Error("expected create action");
    expect(action.create).toEqual({
      sourceRef: "main",
      snapshotId: "snapshot-1",
      name: "Agent",
    });
    expect(action).not.toHaveProperty("token");
  });

  it("rejects create actions without their discriminated create payload", () => {
    expect(() =>
      decodeScaffoldLifecycleAction({
        ...makeScaffoldLifecycleAction({
          actionId: "operation-2",
          kind: "resume",
          environmentId: EnvironmentId.make("env-1"),
          connectionId: "connection-1",
          sessionId: "session-1",
          expectedLifecycleEpoch: 1,
          createdAt: "2026-07-24T19:00:00.000Z",
        }),
        kind: "create",
      }),
    ).toThrow();
  });
});
