// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Host-side release verification runs before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

export type AshlerProductManifest = {
  readonly schemaVersion: number;
  readonly productName: string;
  readonly defaultRepositoryBasename: string;
  readonly bundleIdentifiers: Readonly<Record<string, string>>;
  readonly urlSchemes: ReadonlyArray<string>;
  readonly dataDirectories: {
    readonly home: string;
    readonly userData: string;
    readonly developmentUserData: string;
  };
  readonly domains: Readonly<Record<string, string>>;
  readonly updateFeed: string;
  readonly telemetry: { readonly enabledByDefault: boolean };
  readonly runtimeProfile: {
    readonly default: string;
    readonly profiles: Readonly<
      Record<
        string,
        { readonly allowedHarnesses: ReadonlyArray<string>; readonly defaultHarness: string }
      >
    >;
  };
};

export type AshlerReleaseMetadata = {
  readonly schemaVersion: number;
  readonly ashlerVersion: string;
  readonly upstream: { readonly repository: string; readonly baseSha: string };
};

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const PLACEHOLDER_PATTERN = /^\$\{ASHLER_[A-Z0-9_]+\}$/u;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function validateProductManifest(manifest: AshlerProductManifest): ReadonlyArray<string> {
  const errors: Array<string> = [];
  if (manifest.schemaVersion !== 1) errors.push("product.schemaVersion must be 1");
  if (!isNonEmptyString(manifest.productName)) errors.push("product.productName is required");
  if (
    !isNonEmptyString(manifest.defaultRepositoryBasename) ||
    /[/\\\\]/u.test(manifest.defaultRepositoryBasename)
  ) {
    errors.push("product.defaultRepositoryBasename must be a repository basename");
  }
  if (Object.keys(manifest.bundleIdentifiers ?? {}).length === 0) {
    errors.push("product.bundleIdentifiers must not be empty");
  }
  for (const [name, identifier] of Object.entries(manifest.bundleIdentifiers ?? {})) {
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9-]+)+$/u.test(identifier)) {
      errors.push(`product.bundleIdentifiers.${name} is invalid`);
    }
  }
  if (!Array.isArray(manifest.urlSchemes) || manifest.urlSchemes.length === 0) {
    errors.push("product.urlSchemes must not be empty");
  }
  for (const scheme of manifest.urlSchemes ?? []) {
    if (!/^[a-z][a-z0-9+.-]*$/u.test(scheme))
      errors.push(`product URL scheme ${scheme} is invalid`);
  }
  for (const [name, directory] of Object.entries(manifest.dataDirectories ?? {})) {
    if (!/^\.?[a-z0-9][a-z0-9._-]*$/u.test(directory)) {
      errors.push(`product.dataDirectories.${name} is invalid`);
    }
  }
  for (const [name, placeholder] of Object.entries(manifest.domains ?? {})) {
    if (!PLACEHOLDER_PATTERN.test(placeholder)) {
      errors.push(`product.domains.${name} must be an ASHLER_* placeholder`);
    }
  }
  if (!PLACEHOLDER_PATTERN.test(manifest.updateFeed)) {
    errors.push("product.updateFeed must be an ASHLER_* placeholder");
  }
  if (manifest.telemetry?.enabledByDefault !== false) {
    errors.push("product telemetry must be disabled by default");
  }
  const profiles = manifest.runtimeProfile?.profiles ?? {};
  if (!(manifest.runtimeProfile?.default in profiles)) {
    errors.push("product runtimeProfile.default must reference a profile");
  }
  for (const [name, profile] of Object.entries(profiles)) {
    if (!profile.allowedHarnesses.includes(profile.defaultHarness)) {
      errors.push(`runtime profile ${name} defaultHarness must be allowed`);
    }
  }
  if (profiles.scaffold?.allowedHarnesses.join(",") !== "omp") {
    errors.push("the Scaffold runtime profile must expose only OMP");
  }
  return errors;
}

export function validateReleaseMetadata(metadata: AshlerReleaseMetadata): ReadonlyArray<string> {
  const errors: Array<string> = [];
  if (metadata.schemaVersion !== 1) errors.push("release.schemaVersion must be 1");
  if (!VERSION_PATTERN.test(metadata.ashlerVersion))
    errors.push("release.ashlerVersion is invalid");
  if (!SHA_PATTERN.test(metadata.upstream?.baseSha ?? ""))
    errors.push("release upstream baseSha is invalid");
  if (metadata.upstream?.repository !== "https://github.com/pingdotgg/t3code") {
    errors.push("release upstream repository must identify pingdotgg/t3code");
  }
  return errors;
}

function readJson<T>(path: string): T {
  return JSON.parse(NodeFS.readFileSync(path, "utf8")) as T;
}

export function verifyUpstreamLicense(repoRoot: string, baseSha: string): string | null {
  const upstream = NodeChildProcess.spawnSync("git", ["show", `${baseSha}:LICENSE`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (upstream.status !== 0) return `unable to read LICENSE from upstream base ${baseSha}`;
  const local = NodeFS.readFileSync(NodePath.join(repoRoot, "LICENSE"), "utf8");
  return local === upstream.stdout ? null : "root LICENSE differs from the recorded upstream base";
}

export function runGuardrails(repoRoot: string): ReadonlyArray<string> {
  const product = readJson<AshlerProductManifest>(NodePath.join(repoRoot, "ashler/product.json"));
  const release = readJson<AshlerReleaseMetadata>(NodePath.join(repoRoot, "ashler/release.json"));
  const errors = [...validateProductManifest(product), ...validateReleaseMetadata(release)];
  const licenseError = SHA_PATTERN.test(release.upstream.baseSha)
    ? verifyUpstreamLicense(repoRoot, release.upstream.baseSha)
    : null;
  if (licenseError) errors.push(licenseError);
  if (!NodeFS.existsSync(NodePath.join(repoRoot, "ashler/THIRD_PARTY_NOTICES.md"))) {
    errors.push("ashler/THIRD_PARTY_NOTICES.md is missing; run pnpm ashler:notices");
  }
  return errors;
}

const isMain =
  process.argv[1] !== undefined &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1]);
if (isMain) {
  const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
  const errors = runGuardrails(repoRoot);
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Ashler product, release, license, and notices guardrails passed.");
  }
}
