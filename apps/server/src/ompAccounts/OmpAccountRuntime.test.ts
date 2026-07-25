import { describe, expect, it } from "@effect/vitest";

import { accountMode } from "./OmpAccountRuntime.ts";

describe("OMP account runtime mode", () => {
  it("preserves local account login behavior by default", () => {
    expect(accountMode({})).toBe("local");
    expect(accountMode({ T3_OMP_ACCOUNT_MODE: "local" })).toBe("local");
  });

  it("uses read-only broker account behavior on Scaffold", () => {
    expect(accountMode({ T3_OMP_ACCOUNT_MODE: "broker" })).toBe("broker");
  });

  it("fails closed on an unknown account mode", () => {
    expect(() => accountMode({ T3_OMP_ACCOUNT_MODE: "managed-ish" })).toThrow(
      /must be either local or broker/u,
    );
  });
});
