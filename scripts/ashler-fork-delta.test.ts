import { assert, describe, it } from "@effect/vitest";

import { classifyForkDelta, renderForkDeltaReport } from "./ashler-fork-delta.ts";

describe("Ashler fork delta", () => {
  it("separates additive paths, enumerated core patches, and unexpected edits", () => {
    const classification = classifyForkDelta(
      ["README.md", "ashler/product.json", "apps/server/src/provider/builtInDrivers.ts"],
      {
        schemaVersion: 1,
        additivePathPrefixes: ["ashler/"],
        corePatchAllowlist: ["apps/server/src/provider/builtInDrivers.ts"],
      },
    );

    assert.deepStrictEqual(classification, {
      additive: ["ashler/product.json"],
      corePatch: ["apps/server/src/provider/builtInDrivers.ts"],
      unexpected: ["README.md"],
    });
    assert.match(
      renderForkDeltaReport(classification),
      /Unexpected fork edits \(1\)\n  README\.md/u,
    );
  });
});
