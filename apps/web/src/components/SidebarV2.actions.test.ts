import { describe, expect, it, vi } from "vite-plus/test";

import { runSidebarThreadActionOnce } from "./SidebarV2";
import sidebarV2Source from "./SidebarV2.tsx?raw";

describe("Sidebar v2 thread lifecycle actions", () => {
  it("dispatches only once while the same settle or un-settle action is in flight", async () => {
    const inFlight = new Set<string>();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const dispatch = vi.fn(() => pending);

    const first = runSidebarThreadActionOnce(
      inFlight,
      "session-fabric:fabric-1:thread-1",
      dispatch,
    );
    const duplicate = runSidebarThreadActionOnce(
      inFlight,
      "session-fabric:fabric-1:thread-1",
      dispatch,
    );

    expect(await duplicate).toBeNull();
    expect(dispatch).toHaveBeenCalledOnce();

    finish();
    await first;
  });

  it("allows a lifecycle action to be dispatched again after the first action settles", async () => {
    const inFlight = new Set<string>();
    const dispatch = vi.fn(async () => undefined);

    await runSidebarThreadActionOnce(inFlight, "session-fabric:fabric-1:thread-1", dispatch);
    await runSidebarThreadActionOnce(inFlight, "session-fabric:fabric-1:thread-1", dispatch);

    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("stops fabric lifecycle clicks before choosing settle or un-settle", () => {
    expect(sidebarV2Source).toMatch(
      /aria-label=\{\s*fabricThreadIsSettled \? "Un-settle thread" : "Settle thread"\s*\}[\s\S]*?onClick=\{\(event\) => \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*if \(fabricThreadIsSettled\) attemptUnsettle\(fabricThreadRef\);\s*else attemptSettle\(fabricThreadRef\);\s*\}\}/u,
    );
  });

  it("guards both fabric settle and un-settle dispatch paths against duplicate actions", () => {
    expect(sidebarV2Source).toMatch(
      /runSidebarThreadActionOnce\(settlingThreadKeysRef\.current, threadKey,/u,
    );
    expect(sidebarV2Source).toMatch(
      /runSidebarThreadActionOnce\(unsettlingThreadKeysRef\.current, threadKey,/u,
    );
  });

  it("uses the source-aware settlement capability when opening a thread context menu", () => {
    expect(sidebarV2Source).toMatch(
      /const handleThreadContextMenu[\s\S]*?const supportsSettlement =\s*readEnvironmentSupportsSettlement\(thread\.environmentId\);/u,
    );
  });

  it("uses the source-aware settlement capability for every selected thread", () => {
    expect(sidebarV2Source).toMatch(
      /const canSettleSelection = selectedThreads\.every\(\(thread\) =>\s*readEnvironmentSupportsSettlement\(thread\.environmentId\),?\s*\);/u,
    );
    expect(sidebarV2Source).toMatch(
      /\.\.\.\(canSettleSelection \? \[\{ id: "settle", label: `Settle \(\$\{count\}\)` \}\] : \[\]\)/u,
    );
  });
});
