// @effect-diagnostics globalFetch:off globalTimers:off globalDate:off - This host-side deployment probe uses bounded native HTTP and WebSocket clients.
import {
  SESSION_FABRIC_PROTOCOL_VERSION,
  SessionFabricClientFrame,
  SessionFabricSessionId,
  SessionFabricSnapshot,
  type SessionFabricClientFrame as SessionFabricClientFrameType,
  type SessionFabricSnapshot as SessionFabricSnapshotType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { sessionFabricWebSocketProtocols } from "@t3tools/shared/sessionFabricCapability";

export const DEPLOYMENT_SMOKE_EMPTY_SESSION_ID = SessionFabricSessionId.make(
  "deployment-smoke-empty-v1",
);
export const DEPLOYMENT_SMOKE_SESSION_ID = SessionFabricSessionId.make("deployment-smoke-proof-v1");

export const DEPLOYMENT_SMOKE_RUNNER_ID = "deployment-smoke-runner-v1";
const DEPLOYMENT_SMOKE_ENVIRONMENT_ID = "deployment-smoke-environment-v1";
const DEPLOYMENT_SMOKE_PROJECT_ID = "deployment-smoke-project-v1";
const DEPLOYMENT_SMOKE_THREAD_ID = "deployment-smoke-thread-v1";
const DEPLOYMENT_SMOKE_RUNNER_GENERATION = 1;
const DEPLOYMENT_SMOKE_SNAPSHOT_SEQUENCE = 1;
export const DEPLOYMENT_SMOKE_SCAFFOLD_SESSION_ID = "ses_deployment_smoke_v1";
export const DEPLOYMENT_SMOKE_SCAFFOLD_LIFECYCLE_EPOCH = 1;

const decodeClientFrame = Schema.decodeUnknownSync(SessionFabricClientFrame);
const decodeSnapshot = Schema.decodeUnknownSync(SessionFabricSnapshot);
const encodeClientFrame = Schema.encodeSync(Schema.fromJsonString(SessionFabricClientFrame));

export interface DeploymentSmokeSocket {
  readonly readyState: number;
  addEventListener(
    type: "open" | "error" | "close",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "open" | "error" | "close", listener: () => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RunDeploymentSmokeInput {
  readonly relayUrl: URL;
  readonly marker: string;
  readonly timeoutMs: number;
  readonly fetch: typeof fetch;
  readonly createWebSocket: (url: URL, protocols?: ReadonlyArray<string>) => DeploymentSmokeSocket;
  readonly scaffoldOrigin: string;
  readonly viewerCapability: string;
  readonly runnerCapability: string;
  readonly pollIntervalMs?: number;
}

export interface DeploymentSmokeResult {
  readonly marker: string;
  readonly sessionId: typeof DEPLOYMENT_SMOKE_SESSION_ID;
  readonly runnerId: string;
}

export interface WaitForDeploymentCoordinatorReadinessInput {
  readonly relayUrl: URL;
  readonly timeoutMs: number;
  readonly fetch: typeof fetch;
  readonly viewerCapability: string;
  readonly pollIntervalMs?: number;
  readonly allowMissingBootstrap?: boolean;
}

function sessionResourceUrl(
  relayUrl: URL,
  sessionId: typeof DEPLOYMENT_SMOKE_SESSION_ID,
  resource: "connect" | "snapshot",
): URL {
  const url = new URL(relayUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/session-fabric/sessions/${encodeURIComponent(sessionId)}/${resource}`;
  url.search = "";
  url.hash = "";
  if (resource === "connect") {
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else throw new Error("The Relay URL must use http or https.");
  }
  return url;
}

function deploymentEndpointUrl(relayUrl: URL, pathname: string): URL {
  const url = new URL(relayUrl);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}${pathname}`;
  url.search = "";
  url.hash = "";
  return url;
}

const markerTitle = (marker: string): string => `Session fabric deployment smoke ${marker}`;

export function buildDeploymentSmokeFrames(input: {
  readonly marker: string;
  readonly now: string;
}): readonly [SessionFabricClientFrameType, SessionFabricClientFrameType] {
  if (input.marker.trim().length === 0) throw new Error("The deployment smoke marker is required.");
  const title = markerTitle(input.marker);
  const location = {
    environmentKind: "scaffold",
    environmentId: DEPLOYMENT_SMOKE_ENVIRONMENT_ID,
    projectId: DEPLOYMENT_SMOKE_PROJECT_ID,
    threadId: DEPLOYMENT_SMOKE_THREAD_ID,
    repositoryRoot: null,
    worktreePath: null,
    scaffoldSessionId: DEPLOYMENT_SMOKE_SCAFFOLD_SESSION_ID,
    scaffoldSessionUrl: "https://scaffold.example/sessions/ses_deployment_smoke_v1",
    scaffoldLifecycleEpoch: DEPLOYMENT_SMOKE_SCAFFOLD_LIFECYCLE_EPOCH,
  } as const;
  const snapshot = {
    session: {
      sessionId: DEPLOYMENT_SMOKE_SESSION_ID,
      title,
      publication: "public",
      runnerState: "online",
      location,
      initialPrompt: input.marker,
      searchableText: title,
      summary: null,
      cursor: { eventSequence: 0, snapshotSequence: DEPLOYMENT_SMOKE_SNAPSHOT_SEQUENCE },
      lastEventAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    },
    shell: {
      snapshotSequence: DEPLOYMENT_SMOKE_SNAPSHOT_SEQUENCE,
      projects: [],
      threads: [],
      updatedAt: input.now,
    },
    thread: {
      snapshotSequence: DEPLOYMENT_SMOKE_SNAPSHOT_SEQUENCE,
      thread: {
        id: DEPLOYMENT_SMOKE_THREAD_ID,
        projectId: DEPLOYMENT_SMOKE_PROJECT_ID,
        title,
        modelSelection: {
          instanceId: "deployment-smoke-provider-v1",
          model: "deployment-smoke-model-v1",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "deployment-smoke",
        worktreePath: null,
        latestTurn: null,
        createdAt: input.now,
        updatedAt: input.now,
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
    compactedThroughEventSequence: 0,
  };

  return [
    decodeClientFrame({
      type: "runner.hello",
      hello: {
        protocolVersion: SESSION_FABRIC_PROTOCOL_VERSION,
        sessionId: DEPLOYMENT_SMOKE_SESSION_ID,
        runnerId: DEPLOYMENT_SMOKE_RUNNER_ID,
        runnerGeneration: DEPLOYMENT_SMOKE_RUNNER_GENERATION,
        location,
        publication: "public",
        lastCommittedEventSequence: 0,
        connectedAt: input.now,
      },
    }),
    decodeClientFrame({
      type: "session.publish-snapshot",
      published: {
        sessionId: DEPLOYMENT_SMOKE_SESSION_ID,
        runnerId: DEPLOYMENT_SMOKE_RUNNER_ID,
        runnerGeneration: DEPLOYMENT_SMOKE_RUNNER_GENERATION,
        snapshot,
      },
    }),
  ];
}

export function verifyDeploymentSmokeSnapshot(
  value: unknown,
  marker: string,
): SessionFabricSnapshotType {
  const snapshot = decodeSnapshot(value);
  if (!matchesDeploymentSmokeSnapshot(snapshot, marker)) {
    throw new Error(
      "The deployment smoke snapshot did not match the published marker and identity.",
    );
  }
  return snapshot;
}

function matchesDeploymentSmokeSnapshot(
  snapshot: SessionFabricSnapshotType,
  marker: string,
): boolean {
  return (
    snapshot.session.sessionId === DEPLOYMENT_SMOKE_SESSION_ID &&
    snapshot.session.title === markerTitle(marker) &&
    snapshot.session.initialPrompt === marker &&
    snapshot.session.publication === "public" &&
    snapshot.session.location.environmentKind === "scaffold" &&
    snapshot.session.location.environmentId === DEPLOYMENT_SMOKE_ENVIRONMENT_ID &&
    snapshot.session.location.projectId === DEPLOYMENT_SMOKE_PROJECT_ID &&
    snapshot.session.location.threadId === DEPLOYMENT_SMOKE_THREAD_ID &&
    snapshot.session.location.scaffoldSessionId === DEPLOYMENT_SMOKE_SCAFFOLD_SESSION_ID &&
    snapshot.session.location.scaffoldLifecycleEpoch ===
      DEPLOYMENT_SMOKE_SCAFFOLD_LIFECYCLE_EPOCH &&
    snapshot.session.cursor.snapshotSequence === DEPLOYMENT_SMOKE_SNAPSHOT_SEQUENCE &&
    snapshot.shell.snapshotSequence === DEPLOYMENT_SMOKE_SNAPSHOT_SEQUENCE &&
    snapshot.thread.snapshotSequence === DEPLOYMENT_SMOKE_SNAPSHOT_SEQUENCE &&
    snapshot.thread.thread.id === DEPLOYMENT_SMOKE_THREAD_ID &&
    snapshot.thread.thread.projectId === DEPLOYMENT_SMOKE_PROJECT_ID
  );
}

const remainingMs = (deadline: number): number => Math.max(0, deadline - Date.now());

const viewerCapabilityHeaders = (viewerCapability: string): HeadersInit => ({
  authorization: `Bearer ${viewerCapability}`,
});

async function fetchBeforeDeadline(
  fetchClient: typeof fetch,
  url: URL,
  deadline: number,
  timeoutMessage = "The session fabric deployment smoke timed out.",
  init?: RequestInit,
): Promise<Response> {
  const timeoutMs = remainingMs(deadline);
  if (timeoutMs === 0) throw new Error(timeoutMessage);
  const signal = AbortSignal.timeout(timeoutMs);
  const request = fetchClient(url, {
    ...init,
    headers: new Headers({
      "cache-control": "no-cache",
      ...Object.fromEntries(new Headers(init?.headers)),
    }),
    signal,
  });
  const timeout = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error(timeoutMessage)), { once: true });
  });
  return await Promise.race([request, timeout]);
}

async function closeSocket(socket: DeploymentSmokeSocket, deadline: number): Promise<void> {
  if (socket.readyState === 3) return;
  await new Promise<void>((resolve, reject) => {
    const timeoutMs = remainingMs(deadline);
    if (timeoutMs === 0) {
      reject(
        new Error("The session fabric deployment smoke timed out waiting for WebSocket close."),
      );
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("close", onClose);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error("The session fabric deployment smoke timed out waiting for WebSocket close."),
      );
    }, timeoutMs);
    socket.addEventListener("close", onClose, { once: true });
    if (socket.readyState < 2) socket.close(1000, "deployment smoke complete");
  });
}

async function openSocket(socket: DeploymentSmokeSocket, deadline: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeoutMs = remainingMs(deadline);
    if (timeoutMs === 0) {
      reject(new Error("The session fabric deployment smoke timed out."));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The session fabric deployment smoke WebSocket failed to connect."));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("The session fabric deployment smoke timed out opening WebSocket."));
    }, timeoutMs);
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

async function waitForPoll(
  deadline: number,
  pollIntervalMs: number,
  timeoutMessage = "The session fabric deployment smoke timed out.",
): Promise<void> {
  const delayMs = Math.min(pollIntervalMs, remainingMs(deadline));
  if (delayMs === 0) throw new Error(timeoutMessage);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export async function waitForDeploymentCoordinatorReadiness(
  input: WaitForDeploymentCoordinatorReadinessInput,
): Promise<void> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("The coordinator readiness timeout must be positive.");
  }
  if (input.viewerCapability.length === 0) {
    throw new Error("The viewer capability is required for coordinator readiness.");
  }
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("The coordinator readiness poll interval must be positive.");
  }
  const deadline = Date.now() + input.timeoutMs;
  const snapshotUrl = sessionResourceUrl(input.relayUrl, DEPLOYMENT_SMOKE_SESSION_ID, "snapshot");
  const timeoutMessage =
    "The session fabric coordinator did not accept the deployed verifier before the readiness deadline.";

  while (true) {
    let response: Response;
    try {
      response = await fetchBeforeDeadline(input.fetch, snapshotUrl, deadline, timeoutMessage, {
        headers: viewerCapabilityHeaders(input.viewerCapability),
      });
    } catch (error) {
      if (
        remainingMs(deadline) === 0 ||
        (error instanceof Error && error.message === timeoutMessage)
      ) {
        throw new Error(timeoutMessage, { cause: error });
      }
      await waitForPoll(deadline, pollIntervalMs, timeoutMessage);
      continue;
    }
    if (response.status === 200) {
      const snapshot = decodeSnapshot(await response.json());
      if (snapshot.session.sessionId !== DEPLOYMENT_SMOKE_SESSION_ID) {
        throw new Error("The readiness coordinator returned the wrong session identity.");
      }
      return;
    }
    if (response.status === 404) {
      if (input.allowMissingBootstrap === true) return;
      throw new Error(
        "The pre-existing deployment smoke coordinator is missing; bootstrap mode is required only for a fresh environment.",
      );
    }
    if (
      response.status !== 401 &&
      response.status !== 429 &&
      (response.status < 500 || response.status > 599)
    ) {
      throw new Error(
        `The coordinator readiness probe returned unexpected status ${response.status}.`,
      );
    }
    await waitForPoll(deadline, pollIntervalMs, timeoutMessage);
  }
}

async function pollForDeploymentSnapshot(input: {
  readonly fetch: typeof fetch;
  readonly snapshotUrl: URL;
  readonly deadline: number;
  readonly pollIntervalMs: number;
  readonly marker: string;
  readonly runnerState: "online" | "offline";
  readonly timeoutMessage: string;
  readonly requireOpenSocket?: DeploymentSmokeSocket;
  readonly viewerCapability: string;
}): Promise<void> {
  while (true) {
    const response = await fetchBeforeDeadline(
      input.fetch,
      input.snapshotUrl,
      input.deadline,
      input.timeoutMessage,
      { headers: viewerCapabilityHeaders(input.viewerCapability) },
    );
    if (response.status === 200) {
      const snapshot = decodeSnapshot(await response.json());
      if (
        matchesDeploymentSmokeSnapshot(snapshot, input.marker) &&
        snapshot.session.runnerState === input.runnerState
      ) {
        if (input.requireOpenSocket !== undefined && input.requireOpenSocket.readyState !== 1) {
          throw new Error(
            "The session fabric deployment smoke WebSocket closed before the online snapshot was proven.",
          );
        }
        return;
      }
      await waitForPoll(input.deadline, input.pollIntervalMs, input.timeoutMessage);
      continue;
    }
    if (response.status !== 404) {
      throw new Error(
        `The deployment smoke snapshot returned unexpected status ${response.status}.`,
      );
    }
    await waitForPoll(input.deadline, input.pollIntervalMs, input.timeoutMessage);
  }
}

export async function runDeploymentSmoke(
  input: RunDeploymentSmokeInput,
): Promise<DeploymentSmokeResult> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("The deployment smoke timeout must be a positive number of milliseconds.");
  }
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("The deployment smoke poll interval must be positive.");
  }
  const deadline = Date.now() + input.timeoutMs;
  const scaffoldOrigin = input.scaffoldOrigin.trim().replace(/\/+$/gu, "");
  if (scaffoldOrigin.length === 0) {
    throw new Error("The Scaffold origin is required for authenticated smoke.");
  }
  if (input.viewerCapability.length === 0 || input.runnerCapability.length === 0) {
    throw new Error("Both viewer and runner capabilities are required for authenticated smoke.");
  }
  if (input.viewerCapability === input.runnerCapability) {
    throw new Error("Viewer and runner capabilities must be distinct.");
  }

  const directoryUrl = deploymentEndpointUrl(input.relayUrl, "/v1/session-fabric/sessions");
  const anonymousDirectoryResponse = await fetchBeforeDeadline(input.fetch, directoryUrl, deadline);
  if (anonymousDirectoryResponse.status !== 401) {
    throw new Error(
      `The anonymous session directory returned status ${anonymousDirectoryResponse.status}, not 401.`,
    );
  }

  const emptySnapshotUrl = sessionResourceUrl(
    input.relayUrl,
    DEPLOYMENT_SMOKE_EMPTY_SESSION_ID,
    "snapshot",
  );
  const anonymousSnapshotResponse = await fetchBeforeDeadline(
    input.fetch,
    emptySnapshotUrl,
    deadline,
  );
  if (anonymousSnapshotResponse.status !== 401) {
    throw new Error(
      `The anonymous session snapshot returned status ${anonymousSnapshotResponse.status}, not 401.`,
    );
  }

  const preflightResponse = await fetchBeforeDeadline(
    input.fetch,
    directoryUrl,
    deadline,
    undefined,
    {
      method: "OPTIONS",
      headers: {
        origin: scaffoldOrigin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    },
  );
  if (
    preflightResponse.status !== 204 ||
    preflightResponse.headers.get("access-control-allow-origin") !== scaffoldOrigin
  ) {
    throw new Error(
      `The Scaffold-origin CORS preflight returned status ${preflightResponse.status} or an unexpected allow-origin header.`,
    );
  }

  const emptyResponse = await fetchBeforeDeadline(
    input.fetch,
    emptySnapshotUrl,
    deadline,
    undefined,
    { headers: viewerCapabilityHeaders(input.viewerCapability) },
  );
  if (emptyResponse.status !== 404) {
    throw new Error(
      `The stable empty coordinator returned status ${emptyResponse.status}, not 404.`,
    );
  }

  const frames = buildDeploymentSmokeFrames({
    marker: input.marker,
    now: new Date().toISOString(),
  });
  const socket = input.createWebSocket(
    sessionResourceUrl(input.relayUrl, DEPLOYMENT_SMOKE_SESSION_ID, "connect"),
    sessionFabricWebSocketProtocols(input.runnerCapability),
  );
  let socketCloseRequested = false;
  try {
    await openSocket(socket, deadline);
    for (const frame of frames) socket.send(encodeClientFrame(frame));

    const snapshotUrl = sessionResourceUrl(input.relayUrl, DEPLOYMENT_SMOKE_SESSION_ID, "snapshot");
    await pollForDeploymentSnapshot({
      fetch: input.fetch,
      snapshotUrl,
      deadline,
      pollIntervalMs,
      marker: input.marker,
      runnerState: "online",
      requireOpenSocket: socket,
      timeoutMessage:
        "The session fabric deployment smoke timed out waiting for the published online snapshot.",
      viewerCapability: input.viewerCapability,
    });

    socketCloseRequested = true;
    await closeSocket(socket, deadline);
    await pollForDeploymentSnapshot({
      fetch: input.fetch,
      snapshotUrl,
      deadline,
      pollIntervalMs,
      marker: input.marker,
      runnerState: "offline",
      timeoutMessage:
        "The session fabric deployment smoke timed out waiting for the post-disconnect offline snapshot.",
      viewerCapability: input.viewerCapability,
    });

    return {
      marker: input.marker,
      sessionId: DEPLOYMENT_SMOKE_SESSION_ID,
      runnerId: DEPLOYMENT_SMOKE_RUNNER_ID,
    };
  } finally {
    if (!socketCloseRequested && socket.readyState < 2) {
      socket.close(1000, "deployment smoke complete");
    }
  }
}
