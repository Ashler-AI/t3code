import { describe, expect, it } from "@effect/vitest";

import {
  decideCommandSubmit,
  decideEventAppend,
  decideRunnerGeneration,
  shouldReplayCommand,
} from "./SessionStreamModel.ts";

describe("SessionStreamModel", () => {
  it("rejects a stale runner after a newer generation takes the lease", () => {
    expect(decideRunnerGeneration(4, 3)).toBe("stale");
    expect(
      decideEventAppend({
        currentRunnerGeneration: 4,
        incomingRunnerGeneration: 3,
        eventAlreadyExists: false,
      }),
    ).toBe("stale-runner");
  });

  it("deduplicates a committed event before considering runner generation", () => {
    expect(
      decideEventAppend({
        currentRunnerGeneration: 4,
        incomingRunnerGeneration: 3,
        eventAlreadyExists: true,
      }),
    ).toBe("duplicate");
  });

  it("preserves the complete stored receipt for duplicate commands", () => {
    expect(decideCommandSubmit(undefined)).toEqual({ type: "accepted" });
    const existing = {
      status: "accepted" as const,
      resultSequence: 42,
      detail: null,
    };
    const duplicate = decideCommandSubmit(existing);
    expect(duplicate).toEqual({ type: "duplicate", existing });
    if (duplicate.type !== "duplicate") throw new Error("expected duplicate command");
    expect(duplicate.existing).toBe(existing);
    expect(duplicate.existing.resultSequence).toBe(42);
  });

  it("replays only unfinished command delivery states", () => {
    expect(shouldReplayCommand("queued")).toBe(true);
    expect(shouldReplayCommand("delivered")).toBe(true);
    expect(shouldReplayCommand("accepted")).toBe(false);
    expect(shouldReplayCommand("rejected")).toBe(false);
  });
});
