import { describe, expect, it } from "@effect/vitest";

import { builtInDriversForEnvironment } from "./builtInDrivers.ts";

describe("built-in provider driver profile", () => {
  it("retains native provider choices for local installs", () => {
    expect(builtInDriversForEnvironment({}).map(({ driverKind }) => driverKind)).toEqual([
      "omp",
      "codex",
      "claudeAgent",
    ]);
    expect(
      builtInDriversForEnvironment({ T3_PROVIDER_DRIVER_MODE: "all" }).map(
        ({ driverKind }) => driverKind,
      ),
    ).toEqual(["omp", "codex", "claudeAgent"]);
  });

  it("registers only OMP when the managed driver mode is explicit", () => {
    expect(
      builtInDriversForEnvironment({ T3_PROVIDER_DRIVER_MODE: "omp-only" }).map(
        ({ driverKind }) => driverKind,
      ),
    ).toEqual(["omp"]);
  });

  it("registers only OMP for the agent_t3_omp Scaffold runtime profile", () => {
    expect(
      builtInDriversForEnvironment({ SCAFFOLD_RUNTIME_PROFILE: "agent_t3_omp" }).map(
        ({ driverKind }) => driverKind,
      ),
    ).toEqual(["omp"]);
  });

  it("fails closed when agent_t3_omp is configured with a wider driver mode", () => {
    expect(() =>
      builtInDriversForEnvironment({
        SCAFFOLD_RUNTIME_PROFILE: "agent_t3_omp",
        T3_PROVIDER_DRIVER_MODE: "all",
      }),
    ).toThrow(/requires T3_PROVIDER_DRIVER_MODE to be omp-only/u);
  });

  it("fails closed on an unknown managed profile", () => {
    expect(() => builtInDriversForEnvironment({ T3_PROVIDER_DRIVER_MODE: "omp-ish" })).toThrow(
      /must be either all or omp-only/u,
    );
  });
});
