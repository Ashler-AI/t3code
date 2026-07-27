/**
 * BUILT_IN_DRIVERS — the static set of `ProviderDriver`s this build ships
 * with.
 *
 * Every driver exposed by this product build is listed here. The
 * `ProviderInstanceRegistry` iterates this array when
 * resolving `providerInstances` entries; anything not in the array surfaces
 * as an `"unavailable"` shadow snapshot at runtime (see
 * `buildUnavailableProviderSnapshot`).
 *
 * Adding a new first-party driver means:
 *   1. implement `ProviderDriver` in a sibling `Drivers/<Name>Driver.ts`,
 *   2. add it to this array,
 *   3. ensure the runtime layer satisfies its declared `R`.
 *
 * The aggregated `BuiltInDriversEnv` type is the union of every driver's
 * env requirement — the registry layer's `R` is this type, and the runtime
 * layer (ChildProcessSpawner, FileSystem, Path, ServerConfig,
 * OpenCodeRuntime, …) must satisfy it.
 *
 * @module provider/builtInDrivers
 */
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import { OmpDriver, type OmpDriverEnv } from "./Drivers/OmpDriver.ts";
import type { AnyProviderDriver } from "./ProviderDriver.ts";

/**
 * Union of infrastructure services required to construct any built-in
 * driver. The registry layer declares `R = BuiltInDriversEnv`; the runtime
 * layer must provide every service in this union.
 */
export type BuiltInDriversEnv = ClaudeDriverEnv | CodexDriverEnv | OmpDriverEnv;

/**
 * Ordered list of built-in drivers. Order matters only for tie-breaking in
 * UI presentation — the registry itself is keyed by `driverKind`, so
 * iteration order has no functional effect on instance lookup.
 */
const LOCAL_PRODUCT_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  OmpDriver,
  CodexDriver,
  ClaudeDriver,
];

/**
 * Scaffold ships a single managed harness. Local installs expose the Ashler
 * product catalog: OMP plus the optional native Codex and Claude harnesses.
 *
 * Cursor, Grok, and OpenCode remain in the fork for upstream compatibility,
 * but are not advertised or instantiated through the product registry.
 */
export function builtInDriversForEnvironment(
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> {
  const mode = environment.T3_PROVIDER_DRIVER_MODE?.trim();
  const scaffoldRuntimeProfile = environment.SCAFFOLD_RUNTIME_PROFILE?.trim();

  if (scaffoldRuntimeProfile === "agent_t3_omp") {
    if (mode && mode !== "omp-only") {
      throw new Error(
        "agent_t3_omp requires T3_PROVIDER_DRIVER_MODE to be omp-only when configured",
      );
    }
    return [OmpDriver];
  }

  if (mode === "omp-only") return [OmpDriver];
  if (!mode || mode === "all") return LOCAL_PRODUCT_DRIVERS;
  throw new Error("T3_PROVIDER_DRIVER_MODE must be either all or omp-only");
}

export const BUILT_IN_DRIVERS = builtInDriversForEnvironment(process.env);
