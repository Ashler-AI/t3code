import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeProviderStatusCache } from "../providerStatusCache.ts";
import { loadVerifiedCachedProviderSnapshot } from "./cachedProviderSnapshot.ts";

const instanceId = ProviderInstanceId.make("codex");
const fallbackProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: false,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-07-27T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

it.layer(NodeServices.layer)("native provider cached snapshot", (it) => {
  it.effect("hydrates only a correlated verified snapshot for the first live probe", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-native-provider-cache-",
      });
      const filePath = path.join(cacheDir, `${instanceId}.json`);
      const cachedProvider = {
        ...fallbackProvider,
        installed: true,
        version: "0.145.0",
        status: "ready",
        auth: { status: "authenticated", email: "cached@example.com" },
        checkedAt: "2026-07-27T00:01:00.000Z",
        models: [
          {
            slug: "gpt-5.6-sol",
            name: "GPT-5.6-Sol",
            isCustom: false,
            capabilities: null,
          },
        ],
      } satisfies ServerProvider;

      yield* writeProviderStatusCache({ filePath, provider: cachedProvider });
      const hydrated = yield* loadVerifiedCachedProviderSnapshot({
        cacheDir,
        instanceId,
        fallbackProvider,
      });

      assert.deepStrictEqual(hydrated, cachedProvider);

      yield* writeProviderStatusCache({
        filePath,
        provider: {
          ...cachedProvider,
          status: "error",
          auth: { status: "unauthenticated" },
        },
      });
      assert.strictEqual(
        yield* loadVerifiedCachedProviderSnapshot({
          cacheDir,
          instanceId,
          fallbackProvider,
        }),
        undefined,
      );
    }).pipe(Effect.scoped),
  );
});
