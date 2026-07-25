// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import SessionFabricApi from "./src/SessionFabricApi.ts";

export default Alchemy.Stack(
  "T3CodeSessionFabric",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* SessionFabricApi;
    return {
      workerName: api.workerName,
      url: api.url,
    };
  }),
);
