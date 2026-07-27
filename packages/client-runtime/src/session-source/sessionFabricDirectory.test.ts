import {
  ProviderInstanceId,
  SessionFabricClientId,
  SessionFabricSessionId,
  type SessionFabricContextBundle,
  type SessionFabricSessionRecord,
  type SessionFabricSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeSessionFabricDirectoryClient,
  sessionFabricConnectionForContext,
} from "./sessionFabricDirectory.ts";
import { makeSessionFabricCapabilityAuthorization } from "./sessionFabricAuthorization.ts";

const record = {
  sessionId: SessionFabricSessionId.make("global-session-1"),
  title: "Repair OAuth callbacks",
  publication: "public",
  runnerState: "online",
  location: {
    environmentKind: "local",
    environmentId: "environment-1",
    projectId: "project-1",
    threadId: "thread-1",
    repositoryRoot: "/workspace/repo",
    worktreePath: "/workspace/worktree",
    scaffoldSessionId: null,
    scaffoldSessionUrl: null,
  },
  initialPrompt: "Repair OAuth callbacks",
  searchableText: "Repair OAuth callbacks and test Claude login",
  summary: null,
  cursor: { eventSequence: 4, snapshotSequence: 7 },
  lastEventAt: "2026-07-24T20:00:00.000Z",
  createdAt: "2026-07-24T19:00:00.000Z",
  updatedAt: "2026-07-24T20:00:00.000Z",
} as SessionFabricSessionRecord;

const snapshot = {
  session: record,
  shell: {
    snapshotSequence: 7,
    projects: [
      {
        id: record.location.projectId,
        title: "T3 Code",
        workspaceRoot: "/workspace/repo",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    ],
    threads: [
      {
        id: record.location.threadId,
        projectId: record.location.projectId,
        title: record.title,
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "gpt-5.6-terra",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: record.location.worktreePath,
        latestTurn: null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: null,
        latestUserMessageAt: record.updatedAt,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    ],
    updatedAt: record.updatedAt,
  },
  thread: {
    snapshotSequence: 7,
    thread: {
      id: record.location.threadId,
      projectId: record.location.projectId,
      title: record.title,
      modelSelection: {
        instanceId: ProviderInstanceId.make("omp"),
        model: "gpt-5.6-terra",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: record.location.worktreePath,
      latestTurn: null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  },
  compactedThroughEventSequence: 4,
} satisfies SessionFabricSnapshot;

describe("sessionFabricDirectory", () => {
  it.effect("searches and loads code plus continuation without browser storage", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly body: unknown }> = [];
      const authorization = makeSessionFabricCapabilityAuthorization({
        endpoint: "https://t3.example/api/session-fabric/capabilities",
        now: () => Date.parse("2026-07-24T20:00:00.000Z"),
        fetch: (async () =>
          Response.json({
            capability: "viewer-secret",
            tokenType: "Bearer",
            role: "viewer",
            scopes: ["directory:read", "session:read"],
            expiresAt: "2026-07-24T21:00:00.000Z",
            issuer: "scaffold",
            audience: "session-fabric",
            keyId: "key-1",
            bindings: {},
          })) as typeof fetch,
      });
      const client = makeSessionFabricDirectoryClient({
        relayBaseUrl: "https://relay.example/base/",
        authorization,
        fetch: async (input, init) => {
          const url = String(input);
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer viewer-secret");
          calls.push({ url, body: init?.body });
          if (url.endsWith("/search")) {
            return Response.json({
              results: [{ session: record, score: 0.93, matchText: record.searchableText }],
            });
          }
          return Response.json({
            session: record,
            snapshot,
            codeDiff: "diff --git a/auth.ts b/auth.ts",
            continuationRef: "session-fabric:global-session-1",
            generatedAt: record.updatedAt,
          });
        },
      });

      const search = yield* client.search({ query: "login regression", limit: 5 });
      expect(search.results[0]?.session.sessionId).toBe(record.sessionId);
      const context = yield* client.context({
        sessionId: record.sessionId,
        includeCodeDiff: true,
        includeContinuation: true,
      });
      expect(context.codeDiff).toContain("auth.ts");
      expect(calls.map((call) => call.url)).toEqual([
        "https://relay.example/base/v1/session-fabric/search",
        "https://relay.example/base/v1/session-fabric/context",
      ]);
      expect(globalThis.localStorage).toBeUndefined();
    }),
  );

  it("turns a context continuation into a virtual fabric connection", () => {
    const context = {
      session: record,
      continuationRef: "session-fabric:global-session-1",
    } as SessionFabricContextBundle;
    const registration = sessionFabricConnectionForContext({
      relayBaseUrl: "https://relay.example/",
      context,
      clientId: "fresh-client",
    });
    expect(registration?.target.sessionId).toBe(SessionFabricSessionId.make("global-session-1"));
    expect(registration?.target.clientId).toBe(SessionFabricClientId.make("fresh-client"));
    expect(registration?.target.environmentId).toBe("session-fabric:global-session-1");
  });

  it.effect("refreshes a rejected viewer capability once and still reads an offline session", () =>
    Effect.gen(function* () {
      let capabilityCalls = 0;
      const relayAuthorizationHeaders: Array<string | null> = [];
      const authorization = makeSessionFabricCapabilityAuthorization({
        endpoint: "https://t3.example/api/session-fabric/capabilities",
        now: () => Date.parse("2026-07-24T20:00:00.000Z"),
        fetch: (async () => {
          capabilityCalls += 1;
          return Response.json({
            capability: `viewer-${capabilityCalls}`,
            tokenType: "Bearer",
            role: "viewer",
            scopes: ["directory:read", "session:read"],
            expiresAt: "2026-07-24T21:00:00.000Z",
            issuer: "scaffold",
            audience: "session-fabric",
            keyId: "key-1",
            bindings: {},
          });
        }) as typeof fetch,
      });
      const client = makeSessionFabricDirectoryClient({
        relayBaseUrl: "https://relay.example/",
        authorization,
        fetch: (async (_input, init) => {
          const header = new Headers(init?.headers).get("authorization");
          relayAuthorizationHeaders.push(header);
          if (header === "Bearer viewer-1") return new Response(null, { status: 401 });
          return Response.json({
            sessions: [{ ...record, runnerState: "offline" }],
          });
        }) as typeof fetch,
      });

      const listed = yield* client.list();
      expect(listed.sessions[0]?.runnerState).toBe("offline");
      expect(capabilityCalls).toBe(2);
      expect(relayAuthorizationHeaders).toEqual(["Bearer viewer-1", "Bearer viewer-2"]);
    }),
  );
});
