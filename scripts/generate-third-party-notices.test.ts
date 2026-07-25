import { assert, describe, it } from "@effect/vitest";

import { normalizeLicenseReport, renderThirdPartyNotices } from "./generate-third-party-notices.ts";

describe("Ashler third-party notices", () => {
  it("normalizes pnpm output without machine-specific paths and sorts it deterministically", () => {
    const entries = normalizeLicenseReport({
      MIT: [
        { name: "zeta", versions: ["2.0.0"], license: "MIT", homepage: "https://example.com/zeta" },
        { name: "alpha", versions: ["1.1.0", "1.0.0"], license: "MIT" },
      ],
    });

    assert.deepStrictEqual(entries, [
      { name: "alpha", version: "1.0.0", license: "MIT" },
      { name: "alpha", version: "1.1.0", license: "MIT" },
      { name: "zeta", version: "2.0.0", license: "MIT", homepage: "https://example.com/zeta" },
    ]);
    const rendered = renderThirdPartyNotices(entries);
    assert.match(rendered, /\| alpha\s+\| 1\.0\.0\s+\| MIT\s+\|/u);
    assert.match(rendered, /\| -+ \| -+ \| -+ \| -+ \|/u);
    assert.equal(rendered.includes("/Users/"), false);
  });
});
