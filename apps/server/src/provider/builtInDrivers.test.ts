import { describe, expect, it } from "@effect/vitest";

import { builtInDriversForEnvironment } from "./builtInDrivers.ts";

describe("built-in provider driver profile", () => {
  it("retains native provider choices for local installs", () => {
    expect(builtInDriversForEnvironment({}).map(({ driverKind }) => driverKind)).toEqual([
      "omp",
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
      "opencode",
    ]);
  });

  it("registers only OMP for the managed Scaffold profile", () => {
    expect(
      builtInDriversForEnvironment({ T3_PROVIDER_DRIVER_MODE: "omp-only" }).map(
        ({ driverKind }) => driverKind,
      ),
    ).toEqual(["omp"]);
  });

  it("fails closed on an unknown managed profile", () => {
    expect(() => builtInDriversForEnvironment({ T3_PROVIDER_DRIVER_MODE: "omp-ish" })).toThrow(
      /must be either all or omp-only/u,
    );
  });
});
