import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { OmpAccountAssignment } from "./ompAccounts.ts";

const decodeAssignment = Schema.decodeUnknownSync(OmpAccountAssignment);

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
