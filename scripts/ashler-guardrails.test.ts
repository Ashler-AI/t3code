import { assert, describe, it } from "@effect/vitest";

import {
  type AshlerProductManifest,
  type AshlerReleaseMetadata,
  validateProductManifest,
  validateReleaseMetadata,
} from "./ashler-guardrails.ts";

const product: AshlerProductManifest = {
  schemaVersion: 1,
  productName: "Ashler Code",
  defaultRepositoryBasename: "ashler-platform",
  bundleIdentifiers: { desktop: "ai.ashler.code" },
  urlSchemes: ["ashler-code"],
  dataDirectories: {
    home: ".ashler-code",
    userData: "ashler-code",
    developmentUserData: "ashler-code-dev",
  },
  domains: { webOrigin: "${ASHLER_CODE_WEB_ORIGIN}" },
  updateFeed: "${ASHLER_CODE_UPDATE_FEED_URL}",
  telemetry: { enabledByDefault: false },
  runtimeProfile: {
    default: "local",
    profiles: {
      local: { allowedHarnesses: ["omp", "codex"], defaultHarness: "omp" },
      scaffold: { allowedHarnesses: ["omp"], defaultHarness: "omp" },
    },
  },
};

describe("Ashler product guardrails", () => {
  it("accepts the additive product and release contract", () => {
    const release: AshlerReleaseMetadata = {
      schemaVersion: 1,
      ashlerVersion: "0.1.0-alpha.0",
      upstream: {
        repository: "https://github.com/pingdotgg/t3code",
        baseSha: "ece05087a70e94efcd57441337fa1249559362ba",
      },
    };

    assert.deepStrictEqual(validateProductManifest(product), []);
    assert.deepStrictEqual(validateReleaseMetadata(release), []);
  });

  it("rejects enabled telemetry, concrete deployment domains, and non-OMP Scaffold runtimes", () => {
    const invalid: AshlerProductManifest = {
      ...product,
      domains: { webOrigin: "https://code.ashler.ai" },
      telemetry: { enabledByDefault: true },
      runtimeProfile: {
        ...product.runtimeProfile,
        profiles: {
          ...product.runtimeProfile.profiles,
          scaffold: { allowedHarnesses: ["omp", "codex"], defaultHarness: "omp" },
        },
      },
    };

    const errors = validateProductManifest(invalid).join("\n");
    assert.match(errors, /placeholder/u);
    assert.match(errors, /disabled by default/u);
    assert.match(errors, /only OMP/u);
  });

  it("rejects a default repository value that is not a basename", () => {
    const invalid: AshlerProductManifest = {
      ...product,
      defaultRepositoryBasename: "ashler/ashler-platform",
    };

    assert.match(validateProductManifest(invalid).join("\n"), /repository basename/u);
  });
});
