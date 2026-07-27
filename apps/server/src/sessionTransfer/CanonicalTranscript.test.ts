import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationThread } from "@t3tools/contracts";

import { canonicalTranscriptSha256 } from "./CanonicalTranscript.ts";

type Transcript = Pick<OrchestrationThread, "messages" | "activities">;

function transcript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    messages: [
      {
        id: "message-source" as never,
        role: "user",
        text: "Inspect the workspace",
        attachments: [
          {
            type: "file",
            id: "attachment-source",
            name: "input.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
          },
        ],
        turnId: "turn-source" as never,
        streaming: false,
        createdAt: "2026-07-26T00:00:00.000Z",
        updatedAt: "2026-07-26T00:00:00.000Z",
      },
    ],
    activities: [
      {
        id: "event-source" as never,
        tone: "tool",
        kind: "tool.completed",
        summary: "Read input.txt",
        payload: {
          toolCallId: "tool-source",
          sequence: 17,
          completedAt: "2026-07-26T00:00:01.000Z",
          rawInput: { path: "input.txt" },
          rawOutput: "hello",
          format: "text",
          chat: "semantic",
        },
        turnId: "turn-source" as never,
        sequence: 17,
        createdAt: "2026-07-26T00:00:01.000Z",
      },
      {
        id: "session-source" as never,
        tone: "info",
        kind: "provider.session.started",
        summary: "Provider session started",
        payload: { sessionId: "private-source" },
        turnId: null,
        sequence: 18,
        createdAt: "2026-07-26T00:00:02.000Z",
      },
    ],
    ...overrides,
  };
}

describe("canonicalTranscriptSha256", () => {
  it("ignores destination ids, cursors, timestamps, and lifecycle-only activity", () => {
    const source = transcript();
    const destination = transcript({
      messages: source.messages.map((message) => ({
        ...message,
        id: "message-destination" as never,
        turnId: "turn-destination" as never,
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z",
        attachments: message.attachments?.map((attachment) => ({
          ...attachment,
          id: "attachment-destination",
        })),
      })),
      activities: [
        {
          ...source.activities[0]!,
          id: "event-destination" as never,
          turnId: "turn-destination" as never,
          sequence: 2,
          createdAt: "2026-07-27T00:00:01.000Z",
          payload: {
            toolCallId: "tool-destination",
            sequence: 2,
            completedAt: "2026-07-27T00:00:01.000Z",
            rawInput: { path: "input.txt" },
            rawOutput: "hello",
            format: "text",
            chat: "semantic",
          },
        },
      ],
    });

    expect(canonicalTranscriptSha256(destination)).toBe(canonicalTranscriptSha256(source));
  });

  it("changes when semantic message, reasoning, tool, or error content changes", () => {
    const source = transcript();
    const changed = transcript({
      activities: source.activities.map((activity, index) =>
        index === 0
          ? { ...activity, payload: { rawInput: { path: "input.txt" }, rawOutput: "changed" } }
          : activity,
      ),
    });
    expect(canonicalTranscriptSha256(changed)).not.toBe(canonicalTranscriptSha256(source));
  });

  it("keeps semantic keys ending in at while dropping explicit volatile keys", () => {
    const source = transcript();
    const changed = transcript({
      activities: source.activities.map((activity, index) =>
        index === 0
          ? {
              ...activity,
              payload: {
                eventId: "event-other",
                sourceSequence: 99,
                createdAt: "2026-07-28T00:00:00.000Z",
                rawInput: { path: "input.txt" },
                rawOutput: "hello",
                format: "json",
                chat: "semantic",
              },
            }
          : activity,
      ),
    });
    expect(canonicalTranscriptSha256(changed)).not.toBe(canonicalTranscriptSha256(source));
  });
});
