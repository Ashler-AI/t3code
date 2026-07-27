#!/usr/bin/env node
// @effect-diagnostics globalFetch:off globalTimers:off globalDate:off cryptoRandomUUID:off - This host-side live smoke drives native HTTP and WebSocket clients outside an Effect runtime.
import * as NodeUtil from "node:util";

import {
  SESSION_FABRIC_PROTOCOL_VERSION,
  SessionFabricClientFrame,
  SessionFabricClientId,
  SessionFabricSearchResponse,
  SessionFabricServerFrame,
  SessionFabricSessionId,
  SessionFabricSnapshot,
  type SessionFabricServerFrame as SessionFabricServerFrameType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { sessionFabricWebSocketProtocols } from "@t3tools/shared/sessionFabricCapability";

import {
  buildScaffoldSessionProofCommand,
  fetchScaffoldProofSnapshotResponse,
  isTerminalScaffoldProofCommandReceipt,
  scaffoldSessionSemanticSearchResult,
  scaffoldSessionProofMetadata,
} from "../src/scaffoldProof.ts";

const encodeClientFrame = Schema.encodeSync(Schema.fromJsonString(SessionFabricClientFrame));
const decodeServerFrame = Schema.decodeUnknownSync(Schema.fromJsonString(SessionFabricServerFrame));
const decodeSnapshot = Schema.decodeUnknownSync(SessionFabricSnapshot);
const decodeSearchResponse = Schema.decodeUnknownSync(SessionFabricSearchResponse);

const { values } = NodeUtil.parseArgs({
  options: {
    "relay-url": { type: "string" },
    "session-id": { type: "string" },
    message: { type: "string" },
    "semantic-query": { type: "string" },
    timeout: { type: "string", default: "60000" },
  },
});

if (
  values["relay-url"] === undefined ||
  values["session-id"] === undefined ||
  values["semantic-query"] === undefined
) {
  throw new Error(
    "Usage: pnpm smoke:scaffold --relay-url <url> --session-id <global-id> --semantic-query <zero-overlap-query> [--message <prompt>]",
  );
}

const relayUrl = new URL(values["relay-url"]);
const sessionId = SessionFabricSessionId.make(values["session-id"]);
const timeoutMs = Number(values.timeout);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("--timeout must be a positive number of milliseconds.");
}

function sessionUrl(resource: "connect" | "snapshot"): URL {
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

const viewerCapability = process.env.SESSION_FABRIC_SMOKE_VIEWER_CAPABILITY;
const snapshotResponse = await fetchScaffoldProofSnapshotResponse({
  url: sessionUrl("snapshot"),
  timeoutMs,
  fetch,
  ...(viewerCapability === undefined ? {} : { capability: viewerCapability }),
});
if (!snapshotResponse.ok) {
  throw new Error(`Session snapshot failed with status ${snapshotResponse.status}.`);
}
const snapshot = decodeSnapshot(await snapshotResponse.json());
const metadata = scaffoldSessionProofMetadata(snapshot);
const searchUrl = new URL(relayUrl);
searchUrl.pathname = `${searchUrl.pathname.replace(/\/$/, "")}/v1/session-fabric/search`;
searchUrl.search = "";
searchUrl.hash = "";
const searchResponse = await fetch(searchUrl, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "cache-control": "no-cache",
    ...(process.env.SESSION_FABRIC_SMOKE_VIEWER_CAPABILITY === undefined
      ? {}
      : {
          authorization: `Bearer ${process.env.SESSION_FABRIC_SMOKE_VIEWER_CAPABILITY}`,
        }),
  },
  body: JSON.stringify({ query: values["semantic-query"], limit: 50 }),
  signal: AbortSignal.timeout(timeoutMs),
});
if (!searchResponse.ok) {
  throw new Error(`Session semantic search failed with status ${searchResponse.status}.`);
}
const semanticResult = scaffoldSessionSemanticSearchResult({
  snapshot,
  query: values["semantic-query"],
  response: decodeSearchResponse(await searchResponse.json()),
});

class ProofClient {
  readonly clientId;
  readonly socket;
  readonly frames: SessionFabricServerFrameType[] = [];
  private readonly waiters = new Set<{
    readonly predicate: (frame: SessionFabricServerFrameType) => boolean;
    readonly resolve: (frame: SessionFabricServerFrameType) => void;
  }>();

  constructor(clientId: string, capability: string | undefined) {
    this.clientId = SessionFabricClientId.make(clientId);
    this.socket = new WebSocket(
      sessionUrl("connect"),
      capability === undefined ? undefined : [...sessionFabricWebSocketProtocols(capability)],
    );
    this.socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const frame = decodeServerFrame(event.data);
      this.frames.push(frame);
      for (const waiter of this.waiters) {
        if (!waiter.predicate(frame)) continue;
        this.waiters.delete(waiter);
        waiter.resolve(frame);
      }
    });
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket open timed out.")), timeoutMs);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        this.socket.send(
          encodeClientFrame({
            type: "client.hello",
            hello: {
              protocolVersion: SESSION_FABRIC_PROTOCOL_VERSION,
              sessionId,
              clientId: this.clientId,
              afterEventSequence: 0,
              connectedAt: new Date().toISOString(),
            },
          }),
        );
        resolve();
      });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("WebSocket connection failed."));
      });
    });
    await this.waitFor((frame) => frame.type === "session.synchronized");
  }

  send(frame: Parameters<typeof encodeClientFrame>[0]): void {
    this.socket.send(encodeClientFrame(frame));
  }

  waitFor(
    predicate: (frame: SessionFabricServerFrameType) => boolean,
  ): Promise<SessionFabricServerFrameType> {
    const existing = this.frames.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const waiter = {
        predicate,
        resolve: (frame: SessionFabricServerFrameType) => {
          clearTimeout(timer);
          resolve(frame);
        },
      };
      this.waiters.add(waiter);
      timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("Timed out waiting for a session fabric frame."));
      }, timeoutMs);
    });
  }

  close(): void {
    this.socket.close(1000, "proof complete");
  }
}

const clients = [
  new ProofClient(
    "scaffold-proof-client-1",
    process.env.SESSION_FABRIC_SMOKE_CONTROLLER_CAPABILITY ??
      process.env.SESSION_FABRIC_SMOKE_VIEWER_CAPABILITY,
  ),
  new ProofClient("scaffold-proof-client-2", process.env.SESSION_FABRIC_SMOKE_VIEWER_CAPABILITY),
];
try {
  await Promise.all(clients.map((client) => client.connect()));
  let receipt: SessionFabricServerFrameType | null = null;
  let observedSequences: number[] = [];
  if (values.message !== undefined) {
    const command = buildScaffoldSessionProofCommand({
      snapshot,
      clientId: clients[0]!.clientId,
      message: values.message,
      now: new Date().toISOString(),
      commandId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
    });
    clients[0]!.send({ type: "command.submit", command });
    const commandReceipt = await clients[0]!.waitFor((frame) =>
      isTerminalScaffoldProofCommandReceipt(frame, command.commandId),
    );
    if (commandReceipt.type !== "command.receipt" || commandReceipt.receipt.status !== "accepted") {
      throw new Error("The Scaffold runner rejected the proof command.");
    }
    receipt = commandReceipt;
    const observed = await Promise.all(
      clients.map((client) =>
        client.waitFor(
          (frame) =>
            frame.type === "session.event" &&
            frame.published.event.commandId === command.commandId &&
            frame.published.event.type === "thread.message-sent",
        ),
      ),
    );
    observedSequences = observed.map((frame) =>
      frame.type === "session.event" ? frame.sequence : -1,
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        sessionId: metadata.sessionId,
        scaffoldSessionId: metadata.scaffoldSessionId,
        scaffoldSessionUrl: metadata.scaffoldSessionUrl,
        clients: clients.length,
        semanticSearchScore: semanticResult.score,
        resultSequence: receipt?.type === "command.receipt" ? receipt.receipt.resultSequence : null,
        observedSequences,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  for (const client of clients) client.close();
}
