import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { OmpAccountAssignment, OmpUsageReport } from "./ompAccounts.ts";

const decodeAssignment = Schema.decodeUnknownSync(OmpAccountAssignment);
const decodeUsageReport = Schema.decodeUnknownSync(OmpUsageReport);

describe("OmpAccountAssignment", () => {
  it("accepts masked automatic assignment metadata", () => {
    expect(
      decodeAssignment({
        threadId: "thread-1",
        account: null,
        automatic: true,
        reassignmentReason: "quota-exhausted",
      }),
    ).toEqual({
      threadId: ThreadId.make("thread-1"),
      account: null,
      automatic: true,
      reassignmentReason: "quota-exhausted",
    });
  });

  it("rejects provider-private reassignment details", () => {
    expect(() =>
      decodeAssignment({
        threadId: "thread-1",
        account: null,
        automatic: true,
        reassignmentReason: "credential 42 failed with bearer secret",
      }),
    ).toThrow();
  });
});

describe("OmpUsageReport", () => {
  it("keeps only sanitized reset-credit metadata", () => {
    const report = decodeUsageReport({
      provider: "openai-codex",
      fetchedAt: 1,
      limits: [],
      resetCredits: {
        availableCount: 2,
        credits: [
          {
            id: "provider-private-id",
            grantedAt: "2026-07-24T20:00:00.000Z",
            expiresAt: "2026-08-24T20:00:00.000Z",
            status: "available",
          },
        ],
      },
    });

    expect(report.resetCredits).toEqual({
      availableCount: 2,
      credits: [
        {
          grantedAt: "2026-07-24T20:00:00.000Z",
          expiresAt: "2026-08-24T20:00:00.000Z",
          status: "available",
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("provider-private-id");
  });
});
