import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SessionFabricClientId,
  SessionFabricSessionId,
  ThreadId,
  type SessionFabricSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  buildScaffoldSessionProofCommand,
  fetchScaffoldProofSnapshotResponse,
  isTerminalScaffoldProofCommandReceipt,
  scaffoldSessionSemanticSearchResult,
  scaffoldSessionProofMetadata,
} from "./scaffoldProof.ts";

const NOW = "2026-07-24T20:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-scaffold-proof");
const PROJECT_ID = ProjectId.make("project-scaffold-proof");
const SESSION_ID = SessionFabricSessionId.make("session-scaffold-proof");

const scaffoldSnapshot = {
  session: {
    sessionId: SESSION_ID,
    title: "Scaffold multiplayer proof",
    publication: "public",
    runnerState: "online",
    location: {
      environmentKind: "scaffold",
      environmentId: EnvironmentId.make("environment-scaffold-proof"),
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      repositoryRoot: "/workspace/repository",
      worktreePath: "/workspace/repository",
      scaffoldSessionId: "ses_scaffold_proof",
      scaffoldSessionUrl: "https://scaffold.example/sessions/ses_scaffold_proof",
    },
    initialPrompt: "Exercise the Scaffold runner",
    searchableText: "Exercise the Scaffold runner and stream the result",
    summary: null,
    cursor: { eventSequence: 4, snapshotSequence: 7 },
    lastEventAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  },
  shell: {
    snapshotSequence: 7,
    projects: [],
    threads: [],
    updatedAt: NOW,
  },
  thread: {
    snapshotSequence: 7,
    thread: {
      id: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Scaffold multiplayer proof",
      modelSelection: {
        instanceId: ProviderInstanceId.make("omp"),
        model: "openai-codex/gpt-5.6-luna",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: "/workspace/repository",
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
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

describe("Scaffold session fabric proof", () => {
  it("bounds a hanging authoritative snapshot request with the CLI timeout", async () => {
    const request = { signal: null as AbortSignal | null };
    const hangingFetch: typeof fetch = (_input, init) => {
      request.signal = init?.signal instanceof AbortSignal ? init.signal : null;
      return new Promise<Response>(() => undefined);
    };

    await expect(
      fetchScaffoldProofSnapshotResponse({
        url: new URL("https://fabric.example/v1/session-fabric/sessions/session/snapshot"),
        timeoutMs: 5,
        fetch: hangingFetch,
      }),
    ).rejects.toThrow("Session snapshot timed out after 5ms.");
    expect(request.signal?.aborted).toBe(true);
  });

  it("requires an authoritative Scaffold identity", () => {
    expect(scaffoldSessionProofMetadata(scaffoldSnapshot)).toEqual({
      sessionId: SESSION_ID,
      scaffoldSessionId: "ses_scaffold_proof",
      scaffoldSessionUrl: "https://scaffold.example/sessions/ses_scaffold_proof",
      threadId: THREAD_ID,
    });
    expect(() =>
      scaffoldSessionProofMetadata({
        ...scaffoldSnapshot,
        session: {
          ...scaffoldSnapshot.session,
          location: {
            ...scaffoldSnapshot.session.location,
            environmentKind: "local",
            scaffoldSessionId: null,
          },
        },
      }),
    ).toThrow("not backed by a Scaffold sandbox");
  });

  it("requires a positive semantic match with zero lexical token overlap", () => {
    const query = "coordinated interfaces transferred a programming artifact";
    const result = {
      session: scaffoldSnapshot.session,
      score: 0.47,
      matchText: scaffoldSnapshot.session.initialPrompt,
    };

    expect(
      scaffoldSessionSemanticSearchResult({
        snapshot: scaffoldSnapshot,
        query,
        response: { results: [result] },
      }),
    ).toEqual(result);
    expect(() =>
      scaffoldSessionSemanticSearchResult({
        snapshot: scaffoldSnapshot,
        query: "Scaffold runner",
        response: { results: [result] },
      }),
    ).toThrow("lexical overlap");
    expect(() =>
      scaffoldSessionSemanticSearchResult({
        snapshot: scaffoldSnapshot,
        query,
        response: { results: [] },
      }),
    ).toThrow("did not return the target Scaffold session");
  });

  it("builds a real turn command against the global session and sandbox thread", () => {
    const command = buildScaffoldSessionProofCommand({
      snapshot: scaffoldSnapshot,
      clientId: SessionFabricClientId.make("proof-client-1"),
      message: "Reply with SCAFFOLD_FABRIC_PROOF_OK.",
      now: NOW,
      commandId: "command-scaffold-proof",
      messageId: "message-scaffold-proof",
    });
    expect(command).toMatchObject({
      sessionId: SESSION_ID,
      clientId: "proof-client-1",
      command: {
        type: "thread.turn.start",
        threadId: THREAD_ID,
        message: { text: "Reply with SCAFFOLD_FABRIC_PROOF_OK." },
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    });
  });

  it("waits past nonterminal receipts and preserves the accepted result sequence", () => {
    const commandId = CommandId.make("command-scaffold-proof");
    const pendingReceipt = (status: "queued" | "delivered") => ({
      type: "command.receipt" as const,
      receipt: {
        sessionId: SESSION_ID,
        commandId,
        status,
        resultSequence: null,
        detail: null,
        updatedAt: NOW,
      },
    });
    const acceptedReceipt = {
      type: "command.receipt" as const,
      receipt: {
        sessionId: SESSION_ID,
        commandId,
        status: "accepted" as const,
        resultSequence: 42,
        detail: null,
        updatedAt: NOW,
      },
    };
    const receipts = [pendingReceipt("queued"), pendingReceipt("delivered"), acceptedReceipt];

    expect(
      receipts.find((receipt) => isTerminalScaffoldProofCommandReceipt(receipt, commandId)),
    ).toEqual(acceptedReceipt);
    expect(
      isTerminalScaffoldProofCommandReceipt(
        {
          type: "command.receipt",
          receipt: {
            sessionId: SESSION_ID,
            commandId,
            status: "rejected",
            resultSequence: null,
            detail: "runner rejected command",
            updatedAt: NOW,
          },
        },
        commandId,
      ),
    ).toBe(true);
    expect(
      isTerminalScaffoldProofCommandReceipt(acceptedReceipt, CommandId.make("different-command")),
    ).toBe(false);
  });
});
