import { assert, describe, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";

import { otlpExportHeaders } from "./Observability.ts";

describe("OTLP export headers", () => {
  it("keeps authorization absent unless the env-only redacted config is present", () => {
    assert.equal(otlpExportHeaders(undefined), undefined);
    assert.deepEqual(otlpExportHeaders(Redacted.make("Bearer collector-token")), {
      authorization: "Bearer collector-token",
    });
  });
});
