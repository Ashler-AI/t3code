import * as NodeCrypto from "node:crypto";

import type { OrchestrationThread } from "@t3tools/contracts";

function isVolatilePayloadKey(key: string): boolean {
  return (
    /^(?:id|ids|sequence|timestamp)$/.test(key) ||
    /(?:Id|Ids|Sequence|Timestamp|At)$/.test(key) ||
    /_(?:id|ids|sequence|timestamp|at)$/.test(key)
  );
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function normalizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePayload);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isVolatilePayloadKey(key))
      .map(([key, entry]) => [key, normalizePayload(entry)]),
  );
}

function isTranscriptActivity(activity: OrchestrationThread["activities"][number]): boolean {
  return (
    activity.tone === "error" ||
    /^(?:reasoning\.|tool\.|task\.|approval\.|user-input\.|turn\.plan\.)/.test(activity.kind) ||
    activity.kind === "runtime.error" ||
    activity.kind === "runtime.warning" ||
    activity.kind === "context-compaction" ||
    /^provider\..*\.failed$/.test(activity.kind)
  );
}

/**
 * Stable semantic surface shared by the source projection and the projection
 * rebuilt from an imported OMP session. T3 ids, ordering cursors, and clocks
 * are deliberately omitted; user/assistant text, attachment meaning,
 * reasoning, tool/task activity, interaction requests, warnings, and errors
 * remain bound.
 */
export function canonicalTranscript(thread: Pick<OrchestrationThread, "messages" | "activities">) {
  return {
    version: 1,
    messages: thread.messages.map((message) => ({
      role: message.role,
      text: message.text,
      attachments: (message.attachments ?? []).map(({ id: _id, ...attachment }) => attachment),
    })),
    activities: thread.activities.filter(isTranscriptActivity).map((activity) => ({
      tone: activity.tone,
      kind: activity.kind,
      summary: activity.summary,
      payload: normalizePayload(activity.payload),
    })),
  } as const;
}

export function canonicalTranscriptSha256(
  thread: Pick<OrchestrationThread, "messages" | "activities">,
): string {
  return NodeCrypto.createHash("sha256")
    .update(canonicalJson(canonicalTranscript(thread)))
    .digest("hex");
}
