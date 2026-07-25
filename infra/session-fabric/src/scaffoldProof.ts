import {
  CommandId,
  MessageId,
  type SessionFabricClientId,
  type SessionFabricCommand,
  type SessionFabricServerFrame,
  type SessionFabricSnapshot,
} from "@t3tools/contracts";

export interface ScaffoldSessionProofMetadata {
  readonly sessionId: SessionFabricSnapshot["session"]["sessionId"];
  readonly scaffoldSessionId: string;
  readonly scaffoldSessionUrl: string | null;
  readonly threadId: SessionFabricSnapshot["thread"]["thread"]["id"];
}

export async function fetchScaffoldProofSnapshotResponse(input: {
  readonly url: URL;
  readonly timeoutMs: number;
  readonly fetch: typeof fetch;
}): Promise<Response> {
  const signal = AbortSignal.timeout(input.timeoutMs);
  const timeout = new Promise<never>((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error(`Session snapshot timed out after ${input.timeoutMs}ms.`)),
      { once: true },
    );
  });
  const request = input.fetch(input.url, {
    headers: { "cache-control": "no-cache" },
    signal,
  });
  return await Promise.race([timeout, request]);
}

export function isTerminalScaffoldProofCommandReceipt(
  frame: SessionFabricServerFrame,
  commandId: CommandId,
): boolean {
  return (
    frame.type === "command.receipt" &&
    frame.receipt.commandId === commandId &&
    (frame.receipt.status === "accepted" || frame.receipt.status === "rejected")
  );
}

export function scaffoldSessionProofMetadata(
  snapshot: SessionFabricSnapshot,
): ScaffoldSessionProofMetadata {
  const location = snapshot.session.location;
  if (location.environmentKind !== "scaffold" || location.scaffoldSessionId === null) {
    throw new Error("The session fabric snapshot is not backed by a Scaffold sandbox.");
  }
  if (location.threadId !== snapshot.thread.thread.id) {
    throw new Error("The session fabric location does not match its authoritative thread.");
  }
  return {
    sessionId: snapshot.session.sessionId,
    scaffoldSessionId: location.scaffoldSessionId,
    scaffoldSessionUrl: location.scaffoldSessionUrl,
    threadId: location.threadId,
  };
}

export function buildScaffoldSessionProofCommand(input: {
  readonly snapshot: SessionFabricSnapshot;
  readonly clientId: SessionFabricClientId;
  readonly message: string;
  readonly now: string;
  readonly commandId: string;
  readonly messageId: string;
}): SessionFabricCommand {
  const metadata = scaffoldSessionProofMetadata(input.snapshot);
  const commandId = CommandId.make(input.commandId);
  return {
    sessionId: metadata.sessionId,
    commandId,
    clientId: input.clientId,
    command: {
      type: "thread.turn.start",
      commandId,
      threadId: metadata.threadId,
      message: {
        messageId: MessageId.make(input.messageId),
        role: "user",
        text: input.message,
        attachments: [],
      },
      runtimeMode: input.snapshot.thread.thread.runtimeMode,
      interactionMode: input.snapshot.thread.thread.interactionMode,
      createdAt: input.now,
    },
    submittedAt: input.now,
  };
}
