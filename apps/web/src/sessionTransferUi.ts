import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  scaffoldSessionTransferKind,
  scaffoldSessionTransferPresentation,
  type ScaffoldSessionTransferKind,
} from "@t3tools/client-runtime/session-transfer";
import type {
  EnvironmentId,
  OrchestrationSessionStatus,
  ProjectId,
  ScaffoldDeployment,
  ThreadId,
} from "@t3tools/contracts";

import { isDesktopLocalConnectionTarget } from "./connection/desktopLocal";

export interface SessionTransferSourceRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}

export interface SessionTransferDestinationRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export type StartSessionCopy = (input: {
  readonly deployment: ScaffoldDeployment;
  readonly source: SessionTransferSourceRef;
}) => Promise<SessionTransferDestinationRef>;

const COPYABLE_SESSION_STATUSES = new Set<OrchestrationSessionStatus>([
  "idle",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);

// Production must be re-enabled from an authoritative deployment-capability signal,
// not inferred from generic Scaffold availability.
export const COPY_SESSION_SCAFFOLD_DEPLOYMENTS = [
  "staging",
] as const satisfies ReadonlyArray<ScaffoldDeployment>;

/** Primary descriptors use generated environment ids; locality comes from the target kind. */
export function isSessionTransferLocalConnectionTarget(target: ConnectionTarget): boolean {
  return target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target);
}

export function canCopySessionToScaffold(input: {
  readonly isLocalEnvironment: boolean;
  readonly startAvailable: boolean;
  readonly thread: {
    readonly session: {
      readonly providerName: string | null;
      readonly status: OrchestrationSessionStatus;
      readonly activeTurnId: unknown;
    } | null;
  } | null;
}): boolean {
  const session = input.thread?.session;
  return Boolean(
    input.startAvailable &&
    input.isLocalEnvironment &&
    session !== null &&
    session !== undefined &&
    scaffoldSessionTransferKind(session.providerName) !== null &&
    COPYABLE_SESSION_STATUSES.has(session.status) &&
    session.activeTurnId == null,
  );
}

export function sessionTransferKindForThread(
  thread: {
    readonly session: { readonly providerName: string | null } | null;
  } | null,
): ScaffoldSessionTransferKind | null {
  return scaffoldSessionTransferKind(thread?.session?.providerName);
}

export function sessionTransferCommandTitle(kind: ScaffoldSessionTransferKind): string {
  return scaffoldSessionTransferPresentation(kind).commandTitle;
}

export function sessionTransferProgressTitle(
  deployment: ScaffoldDeployment,
  kind: ScaffoldSessionTransferKind = "exact-omp",
): string {
  return `${scaffoldSessionTransferPresentation(kind).progressVerb} Scaffold ${deployment}`;
}

export function sessionTransferCompletionTitle(
  deployment: ScaffoldDeployment,
  kind: ScaffoldSessionTransferKind = "exact-omp",
): string {
  return `${scaffoldSessionTransferPresentation(kind).completionVerb} Scaffold ${deployment}`;
}

export const SESSION_TRANSFER_ERROR_TITLE = "Could not copy session";

export async function runSessionTransferCommand(input: {
  readonly deployment: ScaffoldDeployment;
  readonly kind?: ScaffoldSessionTransferKind;
  readonly source: SessionTransferSourceRef;
  readonly start: StartSessionCopy;
  readonly closePalette: () => void;
  readonly onProgress: (title: string) => void;
  readonly onCompleted: (title: string, destination: SessionTransferDestinationRef) => void;
  readonly onFailed: (title: string, error: unknown) => void;
}): Promise<void> {
  input.closePalette();
  const kind = input.kind ?? "exact-omp";
  input.onProgress(sessionTransferProgressTitle(input.deployment, kind));
  try {
    const destination = await input.start({
      deployment: input.deployment,
      source: input.source,
    });
    input.onCompleted(sessionTransferCompletionTitle(input.deployment, kind), destination);
  } catch (error) {
    input.onFailed(SESSION_TRANSFER_ERROR_TITLE, error);
  }
}
