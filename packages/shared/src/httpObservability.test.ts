import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Headers from "effect/unstable/http/Headers";

import { httpHeaderRedactionLayer } from "./httpObservability.ts";

describe("httpHeaderRedactionLayer", () => {
  it.effect("redacts DPoP and Scaffold attach authority", () =>
    Effect.gen(function* () {
      const names = yield* Headers.CurrentRedactedNames;
      expect(names).toContain("dpop");
      expect(names).toContain("x-scaffold-attach-grant");
    }).pipe(Effect.provide(httpHeaderRedactionLayer)),
  );
});
