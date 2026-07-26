import {
  ProviderInstanceId,
  SessionFabricSessionId,
  type SessionFabricContextBundle,
  type SessionFabricSessionRecord,
  type SessionFabricSnapshot,
} from "@t3tools/contracts";

export const TEST_NOW = "2026-07-24T20:00:00.000Z";

export const TEST_SESSION_RECORD = {
  sessionId: SessionFabricSessionId.make("global-session-1"),
  title: "Repair OAuth callbacks",
  publication: "public",
  runnerState: "online",
  location: {
    environmentKind: "local",
    environmentId: "environment-remote",
    projectId: "project-remote",
    threadId: "thread-remote",
    repositoryRoot: "/workspace/repo",
    worktreePath: "/workspace/worktree",
    scaffoldSessionId: null,
    scaffoldSessionUrl: null,
  },
  initialPrompt: "Repair OAuth callbacks",
  searchableText: "Repair OAuth callbacks and test Claude login",
  summary: null,
  cursor: { eventSequence: 4, snapshotSequence: 7 },
  lastEventAt: TEST_NOW,
  createdAt: "2026-07-24T19:00:00.000Z",
  updatedAt: TEST_NOW,
} as SessionFabricSessionRecord;

export const TEST_SESSION_SNAPSHOT = {
  session: TEST_SESSION_RECORD,
  shell: {
    snapshotSequence: 7,
    projects: [
      {
        id: TEST_SESSION_RECORD.location.projectId,
        title: "T3 Code",
        workspaceRoot: "/workspace/repo",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: TEST_SESSION_RECORD.createdAt,
        updatedAt: TEST_SESSION_RECORD.updatedAt,
      },
    ],
    threads: [
      {
        id: TEST_SESSION_RECORD.location.threadId,
        projectId: TEST_SESSION_RECORD.location.projectId,
        title: TEST_SESSION_RECORD.title,
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "openai/gpt-5.6-terra",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: TEST_SESSION_RECORD.location.worktreePath,
        latestTurn: null,
        createdAt: TEST_SESSION_RECORD.createdAt,
        updatedAt: TEST_SESSION_RECORD.updatedAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: null,
        latestUserMessageAt: TEST_SESSION_RECORD.updatedAt,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    ],
    updatedAt: TEST_SESSION_RECORD.updatedAt,
  },
  thread: {
    snapshotSequence: 7,
    thread: {
      id: TEST_SESSION_RECORD.location.threadId,
      projectId: TEST_SESSION_RECORD.location.projectId,
      title: TEST_SESSION_RECORD.title,
      modelSelection: {
        instanceId: ProviderInstanceId.make("omp"),
        model: "openai/gpt-5.6-terra",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: TEST_SESSION_RECORD.location.worktreePath,
      latestTurn: null,
      createdAt: TEST_SESSION_RECORD.createdAt,
      updatedAt: TEST_SESSION_RECORD.updatedAt,
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

export const TEST_SESSION_CONTEXT = {
  session: TEST_SESSION_RECORD,
  snapshot: TEST_SESSION_SNAPSHOT,
  codeDiff: "diff --git a/auth.ts b/auth.ts",
  continuationRef: `session-fabric:${TEST_SESSION_RECORD.sessionId}`,
  generatedAt: TEST_NOW,
} satisfies SessionFabricContextBundle;
