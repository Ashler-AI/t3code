import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ScopedThreadSessionRef } from "./environment.ts";

const decodeScopedThreadSessionRef = Schema.decodeUnknownSync(ScopedThreadSessionRef);
const encodeScopedThreadSessionRef = Schema.encodeSync(ScopedThreadSessionRef);

describe("global session identity contracts", () => {
  it("round-trips the stable thread and environment identity without transport state", () => {
    // The current compatibility seam has no runner ID or runner generation.
    // Those require the future session-fabric lease contract and must not be
    // inferred from connection or lifecycle generations here.
    const decoded = decodeScopedThreadSessionRef({
      environmentId: "environment-global-1",
      threadId: "thread-global-1",
    });

    expect(encodeScopedThreadSessionRef(decoded)).toEqual({
      environmentId: "environment-global-1",
      threadId: "thread-global-1",
    });
    expect(Object.keys(decoded).sort()).toEqual(["environmentId", "threadId"]);
  });
});
