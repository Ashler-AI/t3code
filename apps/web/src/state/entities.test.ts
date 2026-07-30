import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { environmentSupportsSettlement, resolveThreadDetailRef } from "./entities";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("resolveThreadDetailRef", () => {
  it("does not subscribe to a reserved draft thread before it enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: true,
      }),
    ).toBeNull();
  });

  it("subscribes once the reserved draft thread enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: true,
        waitForShell: true,
      }),
    ).toBe(threadRef);
  });

  it("keeps direct server-thread lookups enabled when the shell has not loaded it", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: false,
      }),
    ).toBe(threadRef);
  });
});

describe("readEnvironmentSupportsSettlement", () => {
  it("recognizes a virtual session-fabric source without fabricating server config", () => {
    expect(
      environmentSupportsSettlement({
        serverConfig: null,
        sourceTag: "SessionFabricConnectionTarget",
      }),
    ).toBe(true);
  });

  it("preserves direct environment version-skew behavior", () => {
    expect(
      environmentSupportsSettlement({ serverConfig: null, sourceTag: "PrimaryConnectionTarget" }),
    ).toBe(false);
    expect(
      environmentSupportsSettlement({
        serverConfig: { environment: { capabilities: { threadSettlement: true } } },
        sourceTag: "ScaffoldConnectionTarget",
      }),
    ).toBe(true);
  });
});
