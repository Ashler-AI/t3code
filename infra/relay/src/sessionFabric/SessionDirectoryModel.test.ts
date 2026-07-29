import {
  SessionFabricSessionId,
  type SessionFabricSessionRecord,
} from "@t3tools/contracts/session-fabric";
import { describe, expect, it } from "@effect/vitest";

import {
  cosineSimilarity,
  lexicalSimilarity,
  rankSessionDirectoryEntries,
} from "./SessionDirectoryModel.ts";

const session = (input: {
  readonly id: string;
  readonly text: string;
  readonly updatedAt: string;
}): SessionFabricSessionRecord =>
  ({
    sessionId: SessionFabricSessionId.make(input.id),
    title: input.text,
    publication: "public",
    runnerState: "offline",
    location: {
      environmentKind: "scaffold",
      environmentId: "environment-1",
      projectId: "project-1",
      threadId: `thread-${input.id}`,
      repositoryRoot: "/workspace/repo",
      worktreePath: `/workspace/${input.id}`,
      scaffoldSessionId: `ses_${input.id}`,
      scaffoldSessionUrl: `https://scaffold.example/sessions/ses_${input.id}`,
      scaffoldLifecycleEpoch: 1,
    },
    initialPrompt: input.text,
    searchableText: input.text,
    summary: null,
    cursor: { eventSequence: 1, snapshotSequence: 1 },
    lastEventAt: input.updatedAt,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  }) as SessionFabricSessionRecord;

describe("SessionDirectoryModel", () => {
  it("ranks semantic neighbors even when they do not share query tokens", () => {
    const results = rankSessionDirectoryEntries({
      query: "repair login",
      queryEmbedding: [1, 0],
      limit: 10,
      entries: [
        {
          session: session({
            id: "auth",
            text: "Resolve the OAuth callback regression",
            updatedAt: "2026-07-24T21:00:00.000Z",
          }),
          embedding: [0.99, 0.01],
        },
        {
          session: session({
            id: "css",
            text: "Polish the settings dropdown",
            updatedAt: "2026-07-24T22:00:00.000Z",
          }),
          embedding: [0, 1],
        },
      ],
    });

    expect(results.map((result) => result.session.sessionId)).toEqual([
      SessionFabricSessionId.make("auth"),
    ]);
    expect(results[0]?.score).toBeGreaterThan(0.8);
  });

  it("falls back to lexical ranking when embeddings are unavailable", () => {
    expect(lexicalSimilarity("relay capacity", "repair relay capacity manager")).toBe(1);
    expect(cosineSimilarity([1], [1, 0])).toBeNull();
    const results = rankSessionDirectoryEntries({
      query: "relay capacity",
      queryEmbedding: null,
      limit: 1,
      entries: [
        {
          session: session({
            id: "relay",
            text: "repair relay capacity manager",
            updatedAt: "2026-07-24T21:00:00.000Z",
          }),
          embedding: null,
        },
        {
          session: session({
            id: "unrelated",
            text: "update the settings menu",
            updatedAt: "2026-07-24T22:00:00.000Z",
          }),
          embedding: null,
        },
      ],
    });
    expect(results[0]?.session.sessionId).toBe(SessionFabricSessionId.make("relay"));
  });

  it("includes public local sessions but filters private sessions before ranking and limiting", () => {
    const publicScaffold = session({
      id: "public-scaffold",
      text: "relay capacity",
      updatedAt: "2026-07-24T21:00:00.000Z",
    });
    const local = {
      ...session({
        id: "local",
        text: "relay capacity exact match",
        updatedAt: "2026-07-24T23:00:00.000Z",
      }),
      location: {
        ...publicScaffold.location,
        environmentKind: "local" as const,
        scaffoldSessionId: null,
        scaffoldSessionUrl: null,
        scaffoldLifecycleEpoch: null,
      },
    } as SessionFabricSessionRecord;
    const privateScaffold = {
      ...session({
        id: "private",
        text: "relay capacity exact match",
        updatedAt: "2026-07-24T22:00:00.000Z",
      }),
      publication: "local_only" as const,
    };
    const results = rankSessionDirectoryEntries({
      query: "relay capacity",
      queryEmbedding: null,
      limit: 1,
      entries: [
        { session: local, embedding: null },
        { session: privateScaffold, embedding: null },
        { session: publicScaffold, embedding: null },
      ],
    });
    expect(results.map((result) => result.session.sessionId)).toEqual([
      SessionFabricSessionId.make("local"),
    ]);
  });

  it("keeps offline pre-epoch public Scaffold sessions searchable", () => {
    const currentPublicScaffold = session({
      id: "legacy-public-scaffold",
      text: "recover relay history",
      updatedAt: "2026-07-20T21:00:00.000Z",
    });
    const legacyPublicScaffold = {
      ...currentPublicScaffold,
      location: {
        ...currentPublicScaffold.location,
        scaffoldLifecycleEpoch: undefined,
      },
    } as SessionFabricSessionRecord;

    const results = rankSessionDirectoryEntries({
      query: "relay history",
      queryEmbedding: null,
      limit: 10,
      entries: [{ session: legacyPublicScaffold, embedding: null }],
    });

    expect(legacyPublicScaffold.runnerState).toBe("offline");
    expect(results.map((result) => result.session.sessionId)).toEqual([
      SessionFabricSessionId.make("legacy-public-scaffold"),
    ]);
  });
});
