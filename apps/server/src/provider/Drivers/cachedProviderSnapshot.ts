import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  hydrateCachedProvider,
  isCachedProviderCorrelated,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
} from "../providerStatusCache.ts";

export const loadVerifiedCachedProviderSnapshot = Effect.fn("loadVerifiedCachedProviderSnapshot")(
  function* (input: {
    readonly cacheDir: string;
    readonly instanceId: ProviderInstanceId;
    readonly fallbackProvider: ServerProvider;
  }): Effect.fn.Return<ServerProvider | undefined, never, FileSystem.FileSystem | Path.Path> {
    const cachePath = yield* resolveProviderStatusCachePath({
      cacheDir: input.cacheDir,
      instanceId: input.instanceId,
    });
    const cachedProvider = yield* readProviderStatusCache(cachePath);
    if (
      cachedProvider === undefined ||
      !isCachedProviderCorrelated({ cachedProvider, fallbackProvider: input.fallbackProvider })
    ) {
      return undefined;
    }

    const hydrated = hydrateCachedProvider({
      cachedProvider,
      fallbackProvider: input.fallbackProvider,
    });
    return hydrated.status === "ready" && hydrated.models.length > 0 ? hydrated : undefined;
  },
);
