import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CommandId, EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  SESSION_FABRIC_PROTOCOL_VERSION,
  SessionFabricClientFrame,
  SessionFabricClientId,
  SessionFabricCommand,
  SessionFabricCommandReceipt,
  SessionFabricRunnerHello,
  SessionFabricRunnerId,
  SessionFabricSearchRequest,
  SessionFabricSessionId,
} from "./sessionFabric.ts";

describe("session fabric contracts", () => {
  it("keeps global identity independent from the current execution location", () => {
    const hello = Schema.decodeUnknownSync(SessionFabricRunnerHello)({
      protocolVersion: SESSION_FABRIC_PROTOCOL_VERSION,
      sessionId: "global-session-1",
      runnerId: "runner-1",
      runnerGeneration: 2,
      location: {
        environmentKind: "scaffold",
        environmentId: "scaffold-environment-2",
        projectId: "project-1",
        threadId: "thread-9",
        repositoryRoot: "/workspace/ashler-platform",
        worktreePath: null,
        scaffoldSessionId: "ses_123",
        scaffoldSessionUrl: "https://scaffold.example/ses_123",
      },
      publication: "public",
      lastCommittedEventSequence: 41,
      connectedAt: "2026-07-24T20:00:00.000Z",
    });

    expect(hello.sessionId).toBe(SessionFabricSessionId.make("global-session-1"));
    expect(hello.runnerId).toBe(SessionFabricRunnerId.make("runner-1"));
    expect(hello.location.environmentId).toBe(EnvironmentId.make("scaffold-environment-2"));
    expect(hello.location.projectId).toBe(ProjectId.make("project-1"));
    expect(hello.location.threadId).toBe(ThreadId.make("thread-9"));
  });

  it("carries the original idempotent orchestration command", () => {
    const frame = Schema.decodeUnknownSync(SessionFabricClientFrame)({
      type: "command.submit",
      command: {
        sessionId: "global-session-1",
        commandId: "command-1",
        clientId: "client-2",
        submittedAt: "2026-07-24T20:01:00.000Z",
        command: {
          type: "thread.turn.interrupt",
          commandId: "command-1",
          threadId: "thread-9",
          createdAt: "2026-07-24T20:01:00.000Z",
        },
      },
    });

    expect(frame.type).toBe("command.submit");
    if (frame.type !== "command.submit") throw new Error("unexpected frame");
    expect(frame.command.commandId).toBe(CommandId.make("command-1"));
    expect(frame.command.clientId).toBe(SessionFabricClientId.make("client-2"));
    expect(frame.command.command.commandId).toBe(frame.command.commandId);
  });

  it("rejects invalid semantic search limits", () => {
    expect(() =>
      Schema.decodeUnknownSync(SessionFabricSearchRequest)({ query: "harness", limit: 51 }),
    ).toThrow();
  });

  it("requires accepted receipts to preserve their original result sequence", () => {
    const decode = Schema.decodeUnknownSync(SessionFabricCommandReceipt);
    expect(
      decode({
        sessionId: "global-session-1",
        commandId: "command-1",
        status: "accepted",
        resultSequence: 42,
        detail: null,
        updatedAt: "2026-07-24T20:02:00.000Z",
      }).resultSequence,
    ).toBe(42);
    expect(() =>
      decode({
        sessionId: "global-session-1",
        commandId: "command-1",
        status: "accepted",
        resultSequence: null,
        detail: null,
        updatedAt: "2026-07-24T20:02:00.000Z",
      }),
    ).toThrow();
    for (const status of ["queued", "delivered", "rejected"] as const) {
      expect(() =>
        decode({
          sessionId: "global-session-1",
          commandId: "command-1",
          status,
          resultSequence: 42,
          detail: null,
          updatedAt: "2026-07-24T20:02:00.000Z",
        }),
      ).toThrow();
    }
  });

  it("rejects unrecognized runner payloads before they reach the stream authority", () => {
    expect(() =>
      Schema.decodeUnknownSync(SessionFabricCommand)({
        sessionId: "global-session-1",
        commandId: "command-1",
        clientId: "client-2",
        submittedAt: "2026-07-24T20:01:00.000Z",
        command: {
          type: "provider.raw-event",
          commandId: "command-1",
        },
      }),
    ).toThrow();
  });

  it("accepts heavy code context as a runner-only publication frame", () => {
    const frame = Schema.decodeUnknownSync(SessionFabricClientFrame)({
      type: "session.publish-context",
      published: {
        sessionId: "global-session-1",
        runnerId: "runner-1",
        runnerGeneration: 1,
        codeDiff: "diff --git a/file.ts b/file.ts",
        continuationRef: "session-fabric:global-session-1",
        publishedAt: "2026-07-24T20:03:00.000Z",
      },
    });
    expect(frame.type).toBe("session.publish-context");
  });
});
