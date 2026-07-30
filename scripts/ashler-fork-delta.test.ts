import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { classifyForkDelta, renderForkDeltaReport } from "./ashler-fork-delta.ts";

const ForkDeltaPolicyFromString = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Number,
    additivePathPrefixes: Schema.Array(Schema.String),
    corePatchAllowlist: Schema.Array(Schema.String),
  }),
);
const decodeForkDeltaPolicy = Schema.decodeEffect(ForkDeltaPolicyFromString);
const loadForkDeltaPolicy = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem.readFileString("ashler/fork-delta.json");
  return yield* decodeForkDeltaPolicy(contents);
});

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

  it.effect("classifies session-transfer modules without admitting adjacent upstream paths", () =>
    Effect.gen(function* () {
      const policy = yield* loadForkDeltaPolicy;
      const classification = classifyForkDelta(
        [
          "apps/server/src/sessionTransfer/CanonicalTranscript.ts",
          "apps/server/src/persistence/Migrations/035_ScaffoldSessionTransferFences.ts",
          "apps/server/src/persistence/Migrations/037_UnrelatedUpstreamChange.ts",
          "apps/web/src/connection/scaffoldSessionTransfer.ts",
          "apps/web/src/connection/scaffoldSessionTransferUnexpected.ts",
          "apps/server/src/provider/Layers/ProviderSessionDirectory.ts",
          "packages/client-runtime/src/sessionTransfer/index.ts",
          "packages/client-runtime/src/sessionTransferUnexpected.ts",
          "packages/shared/src/sessionFabricCapability.ts",
          "packages/shared/src/sessionFabricCapabilityUnexpected.ts",
        ],
        policy,
      );

      assert.deepStrictEqual(classification, {
        additive: [
          "apps/server/src/persistence/Migrations/035_ScaffoldSessionTransferFences.ts",
          "apps/server/src/sessionTransfer/CanonicalTranscript.ts",
          "apps/web/src/connection/scaffoldSessionTransfer.ts",
          "packages/client-runtime/src/sessionTransfer/index.ts",
          "packages/shared/src/sessionFabricCapability.ts",
        ],
        corePatch: ["apps/server/src/provider/Layers/ProviderSessionDirectory.ts"],
        unexpected: [
          "apps/server/src/persistence/Migrations/037_UnrelatedUpstreamChange.ts",
          "apps/web/src/connection/scaffoldSessionTransferUnexpected.ts",
          "packages/client-runtime/src/sessionTransferUnexpected.ts",
          "packages/shared/src/sessionFabricCapabilityUnexpected.ts",
        ],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "classifies the observability seam without admitting unrelated observability modules",
    () =>
      Effect.gen(function* () {
        const policy = yield* loadForkDeltaPolicy;
        const classification = classifyForkDelta(
          [
            "apps/server/src/config.ts",
            "apps/server/src/observability/Layers/Observability.test.ts",
            "apps/server/src/observability/Layers/Observability.ts",
            "apps/server/src/observability/Metrics.test.ts",
            "apps/server/src/observability/Metrics.ts",
            "apps/server/src/observability/OmpMetrics.test.ts",
            "apps/server/src/observability/OmpMetrics.ts",
            "apps/server/src/observability/UnexpectedCollector.ts",
          ],
          policy,
        );

        assert.deepStrictEqual(classification, {
          additive: [
            "apps/server/src/observability/Layers/Observability.test.ts",
            "apps/server/src/observability/OmpMetrics.test.ts",
            "apps/server/src/observability/OmpMetrics.ts",
          ],
          corePatch: [
            "apps/server/src/config.ts",
            "apps/server/src/observability/Layers/Observability.ts",
            "apps/server/src/observability/Metrics.test.ts",
            "apps/server/src/observability/Metrics.ts",
          ],
          unexpected: ["apps/server/src/observability/UnexpectedCollector.ts"],
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
