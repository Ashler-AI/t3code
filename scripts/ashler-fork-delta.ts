// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Host-side fork reporting shells out to Git before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

type ForkDeltaPolicy = {
  readonly schemaVersion: number;
  readonly additivePathPrefixes: ReadonlyArray<string>;
  readonly corePatchAllowlist: ReadonlyArray<string>;
};

export type ForkDeltaClassification = {
  readonly additive: ReadonlyArray<string>;
  readonly corePatch: ReadonlyArray<string>;
  readonly unexpected: ReadonlyArray<string>;
};

export function classifyForkDelta(
  paths: ReadonlyArray<string>,
  policy: ForkDeltaPolicy,
): ForkDeltaClassification {
  const uniquePaths = [...new Set(paths)].sort();
  const allowlist = new Set(policy.corePatchAllowlist);
  return {
    additive: uniquePaths.filter((path) =>
      policy.additivePathPrefixes.some((prefix) => path.startsWith(prefix)),
    ),
    corePatch: uniquePaths.filter((path) => allowlist.has(path)),
    unexpected: uniquePaths.filter(
      (path) =>
        !policy.additivePathPrefixes.some((prefix) => path.startsWith(prefix)) &&
        !allowlist.has(path),
    ),
  };
}

function runGit(repoRoot: string, args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export function collectForkDeltaPaths(repoRoot: string, baseSha: string): ReadonlyArray<string> {
  const tracked = runGit(repoRoot, ["diff", "--name-only", baseSha, "--"])
    .split("\n")
    .filter(Boolean);
  const untracked = runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "--"])
    .split("\n")
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])];
}

export function renderForkDeltaReport(classification: ForkDeltaClassification): string {
  const section = (label: string, paths: ReadonlyArray<string>) => [
    `${label} (${paths.length})`,
    ...(paths.length === 0 ? ["  (none)"] : paths.map((path) => `  ${path}`)),
  ];
  return [
    ...section("Additive Ashler paths", classification.additive),
    "",
    ...section("Enumerated core patches", classification.corePatch),
    "",
    ...section("Unexpected fork edits", classification.unexpected),
  ].join("\n");
}

const isMain =
  process.argv[1] !== undefined &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1]);
if (isMain) {
  const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
  const policy = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repoRoot, "ashler/fork-delta.json"), "utf8"),
  ) as ForkDeltaPolicy;
  const release = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repoRoot, "ashler/release.json"), "utf8"),
  ) as {
    readonly upstream: { readonly baseSha: string };
  };
  const classification = classifyForkDelta(
    collectForkDeltaPaths(repoRoot, release.upstream.baseSha),
    policy,
  );
  console.log(renderForkDeltaReport(classification));
  if (classification.unexpected.length > 0) process.exitCode = 1;
}
