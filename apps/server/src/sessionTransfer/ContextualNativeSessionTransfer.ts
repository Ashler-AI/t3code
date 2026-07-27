import * as NodeCrypto from "node:crypto";

import {
  ContextualNativeSessionTransferArtifact,
  ContextualNativeSessionTransferSource,
  type EnvironmentId,
  type OrchestrationThread,
  type ProjectId,
  ProviderDriverKind,
  type ScaffoldSessionTransferDescriptor,
  type ThreadId,
} from "@t3tools/contracts";

export const CONTEXTUAL_HANDOFF_ARTIFACT_PATH =
  ".__scaffold_workspace_migration__/contextual-handoff.md" as const;

type ContextualNativeProvider = "codex" | "claudeAgent";

export type ContextualWorktreeOverlayEntry =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly bytes: Uint8Array;
      readonly mode: 0o644 | 0o755;
    }
  | { readonly kind: "tombstone"; readonly path: string }
  | { readonly kind: "symlink"; readonly path: string; readonly target: string };

export interface ContextualNativeSessionTransferPackage {
  readonly descriptor: Extract<ScaffoldSessionTransferDescriptor, { kind: "contextual-native" }>;
  readonly contextArtifactBytes: Uint8Array;
  readonly worktreeOverlay: ReadonlyArray<ContextualWorktreeOverlayEntry>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function selectedEffort(thread: OrchestrationThread): string | undefined {
  const value = thread.modelSelection.options?.find((option) =>
    ["reasoningEffort", "effort", "thinking"].includes(option.id),
  )?.value;
  return typeof value === "string" ? value : undefined;
}

function contextualProvider(provider: ProviderDriverKind): ContextualNativeProvider {
  if (provider === ProviderDriverKind.make("codex")) return "codex";
  if (provider === ProviderDriverKind.make("claudeAgent")) return "claudeAgent";
  throw new Error("Contextual Scaffold handoff supports only native Codex or Claude sessions.");
}

function isVisibleActivity(activity: OrchestrationThread["activities"][number]): boolean {
  return (
    activity.tone === "error" ||
    /^(?:reasoning\.|tool\.|task\.|approval\.|user-input\.|turn\.plan\.)/.test(activity.kind) ||
    activity.kind === "runtime.error" ||
    activity.kind === "runtime.warning" ||
    activity.kind === "context-compaction"
  );
}

function visibleContext(input: {
  readonly provider: ContextualNativeProvider;
  readonly thread: OrchestrationThread;
  readonly capturedAt: string;
}) {
  const { thread } = input;
  return {
    version: "t3.contextual_native_handoff.v1",
    continuation: {
      exact: false,
      destinationProvider: "omp",
      nativeSessionStateTransferred: false,
      notice:
        "This is a contextual handoff into a new OMP session, not continuation of the native provider session.",
    },
    provenance: {
      sourceProvider: input.provider,
      sourceProjectId: thread.projectId,
      sourceThreadId: thread.id,
      modelSelection: thread.modelSelection,
      effort: selectedEffort(thread),
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      capturedAt: input.capturedAt,
    },
    transcript: {
      title: thread.title,
      messages: thread.messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({
          role: message.role,
          text: message.text,
          attachments: (message.attachments ?? []).map((attachment) => ({
            type: attachment.type,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          })),
        })),
      activities: thread.activities.filter(isVisibleActivity).map((activity) => ({
        tone: activity.tone,
        kind: activity.kind,
        summary: activity.summary,
      })),
    },
  } as const;
}

function renderContextArtifact(context: ReturnType<typeof visibleContext>): Uint8Array {
  const text = [
    "# Contextual handoff to OMP",
    "",
    "> This starts a new OMP session. It is not an exact continuation of the source Codex or Claude session.",
    "> Native provider session state, resume identifiers, credentials, and browser storage are not included.",
    "",
    "Use the visible transcript and restored worktree as context. Re-check current workspace state before acting.",
    "",
    "```json",
    canonicalJson(context),
    "```",
    "",
  ].join("\n");
  return new TextEncoder().encode(text);
}

function assertSafeOverlayPath(path: string): void {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  const basename = segments.at(-1)?.toLowerCase() ?? "";
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const forbiddenBasenames = new Set([
    ".claude.json",
    ".git-credentials",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "auth.json",
    "credentials.json",
    "mcp-credentials.json",
    "oauth.json",
  ]);
  const forbiddenTrees = new Set([
    ".anthropic",
    ".aws",
    ".claude",
    ".codex",
    ".config/gcloud",
    ".config/gh",
    ".docker",
    ".kube",
    ".omp",
    ".openai",
    ".ssh",
  ]);
  const lowerPath = lowerSegments.join("/");
  const isEnvironmentFile = basename === ".env" || basename.startsWith(".env.");
  const isAllowedEnvironmentTemplate = [".env.example", ".env.sample", ".env.template"].includes(
    basename,
  );
  if (
    !normalized ||
    normalized.startsWith("/") ||
    segments.includes("..") ||
    normalized === CONTEXTUAL_HANDOFF_ARTIFACT_PATH ||
    forbiddenBasenames.has(basename) ||
    (isEnvironmentFile && !isAllowedEnvironmentTemplate) ||
    [...forbiddenTrees].some((tree) => lowerPath === tree || lowerPath.startsWith(`${tree}/`))
  ) {
    throw new Error("Contextual handoff worktree overlay contains a forbidden path.");
  }
}

export function makeContextualNativeSessionTransferPackage(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceProjectId: ProjectId;
  readonly sourceRootPath: string;
  readonly provider: ProviderDriverKind;
  readonly thread: OrchestrationThread;
  readonly capturedAt: string;
  readonly worktreeOverlay: ReadonlyArray<ContextualWorktreeOverlayEntry>;
}): ContextualNativeSessionTransferPackage {
  if (input.thread.projectId !== input.sourceProjectId) {
    throw new Error("Contextual handoff source project does not own the source thread.");
  }
  if (input.thread.latestTurn?.state === "running" || input.thread.session?.activeTurnId != null) {
    throw new Error("Wait for the native provider turn to finish before handing off context.");
  }
  const provider = contextualProvider(input.provider);
  for (const entry of input.worktreeOverlay) assertSafeOverlayPath(entry.path);

  const context = visibleContext({ provider, thread: input.thread, capturedAt: input.capturedAt });
  const contextArtifactBytes = renderContextArtifact(context);
  const visibleContextSha256 = sha256(contextArtifactBytes);
  const source = new ContextualNativeSessionTransferSource({
    environmentId: input.sourceEnvironmentId,
    projectId: input.sourceProjectId,
    threadId: input.thread.id,
    globalSessionId: `sf:${input.sourceEnvironmentId}:${input.thread.id}`,
    rootPath: input.sourceRootPath,
    title: input.thread.title,
    provider: input.provider,
    modelSelection: input.thread.modelSelection,
    runtimeMode: input.thread.runtimeMode,
    interactionMode: input.thread.interactionMode,
    capturedAt: input.capturedAt,
    visibleContextSha256,
  });
  const contextArtifact = new ContextualNativeSessionTransferArtifact({
    path: CONTEXTUAL_HANDOFF_ARTIFACT_PATH,
    bytes: contextArtifactBytes.byteLength,
    sha256: visibleContextSha256,
    mediaType: "text/markdown; charset=utf-8",
  });
  return {
    descriptor: {
      kind: "contextual-native",
      continuation: {
        exact: false,
        destinationProvider: "omp",
        nativeSessionStateTransferred: false,
      },
      source,
      contextArtifact,
    },
    contextArtifactBytes,
    worktreeOverlay: [
      ...input.worktreeOverlay,
      {
        kind: "file",
        path: CONTEXTUAL_HANDOFF_ARTIFACT_PATH,
        bytes: contextArtifactBytes,
        mode: 0o644,
      },
    ],
  };
}

export function assertFreshContextualDestination(input: {
  readonly source: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly globalSessionId: string;
  };
  readonly destination: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly globalSessionId: string;
  };
}): void {
  const { source, destination } = input;
  if (
    destination.environmentId === source.environmentId ||
    destination.projectId === source.projectId ||
    destination.threadId === source.threadId ||
    destination.globalSessionId === source.globalSessionId ||
    destination.globalSessionId !== `sf:${destination.environmentId}:${destination.threadId}`
  ) {
    throw new Error(
      "Contextual handoff destination must use fresh environment, project, thread, and global ids.",
    );
  }
}
