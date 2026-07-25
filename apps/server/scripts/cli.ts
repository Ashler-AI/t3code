#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DEVELOPMENT_ICON_OVERRIDES,
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
} from "../../../scripts/lib/brand-assets.ts";
import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import serverPackageJson from "../package.json" with { type: "json" };
import {
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliDevelopmentIconSourceMissingError,
  ServerCliDevelopmentIconTargetMissingError,
  ServerCliPublishIconSourceMissingError,
  ServerCliPublishIconTargetMissingError,
} from "./cliErrors.ts";
import {
  type TemporaryFileReplacement,
  withTemporaryFileReplacements,
  withTemporaryPackageStage,
} from "./temporaryFileReplacements.ts";

interface PackageJson {
  name: string;
  repository: {
    type: string;
    url: string;
    directory: string;
  };
  bin: Record<string, string>;
  type: string;
  version: string;
  engines: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
  overrides?: Record<string, string>;
}

const PackageJsonPrettyJson = fromJsonStringPretty(Schema.Unknown);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);
const VerifyInstallPackageJson = Schema.Struct({ private: Schema.Literal(true) });
const encodeVerifyInstallPackageJson = Schema.encodeEffect(
  Schema.fromJsonString(VerifyInstallPackageJson),
);
const PackedArtifactDescriptor = Schema.Struct({
  artifactPath: Schema.String,
  sha256: Schema.String,
});
const encodePackedArtifactDescriptor = Schema.encodeEffect(
  Schema.fromJsonString(PackedArtifactDescriptor),
);

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.StandardCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: command.args,
      cwd: command.options.cwd,
      exitCode,
    });
  }
});

const preparePublishIcons = Effect.fn("preparePublishIcons")(function* (
  repoRoot: string,
  serverDir: string,
  version: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const brand = resolveWebAssetBrandForPackageVersion(version);
  const icons = resolveWebIconOverrides(brand, "dist/client").map((override) => ({
    sourcePath: path.join(repoRoot, override.sourceRelativePath),
    targetPath: path.join(serverDir, override.targetRelativePath),
  }));

  for (const icon of icons) {
    if (!(yield* fs.exists(icon.sourcePath))) {
      return yield* new ServerCliPublishIconSourceMissingError({ sourcePath: icon.sourcePath });
    }
    if (!(yield* fs.exists(icon.targetPath))) {
      return yield* new ServerCliPublishIconTargetMissingError({ targetPath: icon.targetPath });
    }
  }

  return yield* Effect.forEach(icons, (icon) =>
    fs
      .readFile(icon.sourcePath)
      .pipe(Effect.map((publish) => ({ targetPath: icon.targetPath, publish }))),
  );
});

const assertBuildAssets = Effect.fn("assertBuildAssets")(function* (serverDir: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  for (const relPath of ["dist/bin.mjs", "dist/client/index.html"]) {
    const abs = path.join(serverDir, relPath);
    if (!(yield* fs.exists(abs))) {
      return yield* new ServerCliBuildAssetMissingError({ assetPath: abs });
    }
  }
});

const prepareProductionPackageReplacements = Effect.fn("prepareProductionPackageReplacements")(
  function* (repoRoot: string, serverDir: string, version: string, includeOverrides = true) {
    const path = yield* Path.Path;
    const workspaceConfig = yield* readWorkspaceConfig();
    const workspaceCatalog = workspaceConfig.catalog ?? {};
    const workspaceOverrides = workspaceConfig.overrides ?? {};
    const pkg: PackageJson = {
      name: serverPackageJson.name,
      repository: serverPackageJson.repository,
      bin: serverPackageJson.bin,
      type: serverPackageJson.type,
      version,
      engines: serverPackageJson.engines,
      files: serverPackageJson.files,
      dependencies: resolveCatalogDependencies(
        serverPackageJson.dependencies,
        workspaceCatalog,
        "apps/server",
      ),
      ...(includeOverrides
        ? {
            overrides: resolveCatalogDependencies(
              workspaceOverrides,
              workspaceCatalog,
              "apps/server",
            ),
          }
        : {}),
    };
    const packageJsonString = yield* encodePackageJson(pkg);
    const icons = yield* preparePublishIcons(repoRoot, serverDir, version);
    const replacements: TemporaryFileReplacement[] = [
      {
        path: path.join(serverDir, "package.json"),
        contents: new TextEncoder().encode(`${packageJsonString}\n`),
      },
      ...icons.map((icon) => ({ path: icon.targetPath, contents: icon.publish })),
    ];
    return replacements;
  },
);

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new ServerCliDevelopmentIconSourceMissingError({ sourcePath });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new ServerCliDevelopmentIconTargetMissingError({ targetPath });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

// ---------------------------------------------------------------------------
// build subcommand
// ---------------------------------------------------------------------------

const buildServer = Effect.fn("buildServer")(function* (verbose: boolean) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* RepoRoot;
  const serverDir = path.join(repoRoot, "apps/server");

  yield* Effect.log("[cli] Running tsdown...");
  yield* runCommand(
    ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
      cwd: serverDir,
      stdout: verbose ? "inherit" : "ignore",
      stderr: "inherit",
      shell: false,
    }),
  );

  const webDist = path.join(repoRoot, "apps/web/dist");
  const clientTarget = path.join(serverDir, "dist/client");

  if (yield* fs.exists(webDist)) {
    yield* fs.copy(webDist, clientTarget);
    yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
    yield* Effect.log("[cli] Bundled web app into dist/client");
  } else {
    yield* Effect.logWarning("[cli] Web dist not found — skipping client bundle.");
  }
});

const buildPackAssets = Effect.fn("buildPackAssets")(function* (verbose: boolean) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const webBuildCommand = yield* resolveSpawnCommand(path.join(repoRoot, "node_modules/.bin/vp"), [
    "run",
    "--filter",
    "@t3tools/web",
    "build",
  ]);
  yield* runCommand(
    ChildProcess.make(webBuildCommand.command, webBuildCommand.args, {
      cwd: repoRoot,
      stdout: verbose ? "inherit" : "ignore",
      stderr: "inherit",
      shell: webBuildCommand.shell,
    }),
  );
  yield* buildServer(verbose);
});

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) => buildServer(config.verbose),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

// ---------------------------------------------------------------------------
// publish subcommand
// ---------------------------------------------------------------------------

interface PublishCommandConfig {
  readonly access: string;
  readonly tag: string;
  readonly provenance: boolean;
  readonly dryRun: boolean;
}

const createVpPmPublishArgs = (config: PublishCommandConfig): ReadonlyArray<string> => {
  const args = [
    "publish",
    "--filter",
    "t3",
    "--access",
    config.access,
    "--tag",
    config.tag,
    "--no-git-checks",
  ];

  if (config.provenance) args.push("--provenance");
  if (config.dryRun) args.push("--dry-run");

  return args;
};

const publishCmd = Command.make(
  "publish",
  {
    tag: Flag.string("tag").pipe(Flag.withDefault("latest")),
    access: Flag.string("access").pipe(Flag.withDefault("public")),
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    provenance: Flag.boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");
      yield* assertBuildAssets(serverDir);
      const version = Option.getOrElse(config.appVersion, () => serverPackageJson.version);
      const replacements = yield* prepareProductionPackageReplacements(
        repoRoot,
        serverDir,
        version,
      );

      yield* withTemporaryFileReplacements(
        replacements,
        // Publish from the workspace root so pnpm-only workspace config,
        // including override selectors, is interpreted correctly.
        () =>
          Effect.gen(function* () {
            yield* Effect.log("[cli] Applied package metadata and publish icon overrides");

            const args = createVpPmPublishArgs(config);
            const spawnCommand = yield* resolveSpawnCommand("vp", ["pm", ...args]);

            yield* Effect.log(`[cli] Running: vp pm ${args.join(" ")}`);
            yield* runCommand(
              ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                cwd: repoRoot,
                stdout: config.verbose ? "inherit" : "ignore",
                stderr: "inherit",
                shell: spawnCommand.shell,
              }),
            );
          }),
      );
      if (config.verbose) yield* Effect.log("[cli] Restored original publish assets");
    }),
).pipe(Command.withDescription("Publish the server package to npm."));

// ---------------------------------------------------------------------------
// pack subcommand
// ---------------------------------------------------------------------------

const sha256File = Effect.fn("sha256File")(function* (artifactPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFile(artifactPath);
  const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", contents));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
});

const verifyPackedArtifact = Effect.fn("verifyPackedArtifact")(function* (artifactPath: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcessPlatform;
  const installDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-pack-verify-" });
  const installPackageJson = yield* encodeVerifyInstallPackageJson({ private: true });
  yield* fs.writeFileString(path.join(installDir, "package.json"), `${installPackageJson}\n`);

  const installCommand = yield* resolveSpawnCommand("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    "--no-save",
    artifactPath,
  ]);
  yield* runCommand(
    ChildProcess.make(installCommand.command, installCommand.args, {
      cwd: installDir,
      stdout: "ignore",
      stderr: "inherit",
      shell: installCommand.shell,
    }),
  );

  const binPath = path.join(
    installDir,
    "node_modules",
    ".bin",
    hostPlatform === "win32" ? "t3.cmd" : "t3",
  );
  if (!(yield* fs.exists(binPath))) {
    return yield* new ServerCliBuildAssetMissingError({ assetPath: binPath });
  }
  yield* runCommand(
    ChildProcess.make(binPath, ["--version"], {
      cwd: installDir,
      stdout: "ignore",
      stderr: "inherit",
      shell: hostPlatform === "win32",
    }),
  );
});

const packCmd = Command.make(
  "pack",
  {
    outputDir: Flag.string("output-dir").pipe(Flag.withDefault("artifacts/server")),
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");
      const outputDir = path.resolve(repoRoot, config.outputDir);
      const version = Option.getOrElse(config.appVersion, () => serverPackageJson.version);
      const artifactPath = path.join(outputDir, `t3-${version}.tgz`);

      yield* buildPackAssets(config.verbose);
      yield* assertBuildAssets(serverDir);
      yield* fs.makeDirectory(outputDir, { recursive: true });
      if (yield* fs.exists(artifactPath)) {
        yield* fs.remove(artifactPath);
      }

      const replacements = yield* prepareProductionPackageReplacements(
        repoRoot,
        serverDir,
        version,
        false,
      );
      yield* withTemporaryPackageStage(serverDir, replacements, (stageDirectory) =>
        Effect.gen(function* () {
          const packCommand = yield* resolveSpawnCommand("npm", [
            "pack",
            "--silent",
            "--pack-destination",
            outputDir,
          ]);
          yield* runCommand(
            ChildProcess.make(packCommand.command, packCommand.args, {
              cwd: stageDirectory,
              stdout: config.verbose ? "inherit" : "ignore",
              stderr: "inherit",
              shell: packCommand.shell,
            }),
          );
        }),
      );

      if (!(yield* fs.exists(artifactPath))) {
        return yield* new ServerCliBuildAssetMissingError({ assetPath: artifactPath });
      }
      yield* verifyPackedArtifact(artifactPath);
      const sha256 = yield* sha256File(artifactPath);
      yield* Console.log(yield* encodePackedArtifactDescriptor({ artifactPath, sha256 }));
    }),
).pipe(
  Command.withDescription(
    "Build, pack, clean-install, and verify an immutable server tarball for deployment.",
  ),
);

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

const cli = Command.make("cli").pipe(
  Command.withDescription("T3 server build, pack, and publish CLI."),
  Command.withSubcommands([buildCmd, packCmd, publishCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
