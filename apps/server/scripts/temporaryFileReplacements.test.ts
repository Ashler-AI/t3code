import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  withTemporaryFileReplacements,
  withTemporaryPackageStage,
} from "./temporaryFileReplacements.ts";

const encoder = new TextEncoder();

it.layer(NodeServices.layer)("temporary package file replacements", (it) => {
  it.effect("restores temporary package files after successful use", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pack-success-" });
      const path = `${directory}/package.json`;
      yield* fs.writeFileString(path, "original");

      const observed = yield* withTemporaryFileReplacements(
        [{ path, contents: encoder.encode("production") }],
        () => fs.readFileString(path),
      );

      assert.equal(observed, "production");
      assert.equal(yield* fs.readFileString(path), "original");
    }),
  );

  it.effect("restores temporary package files when artifact creation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pack-failure-" });
      const path = `${directory}/package.json`;
      yield* fs.writeFileString(path, "original");

      const exit = yield* Effect.exit(
        withTemporaryFileReplacements([{ path, contents: encoder.encode("production") }], () =>
          Effect.fail("pack failed" as const),
        ),
      );

      assert.isTrue(exit._tag === "Failure");
      assert.equal(yield* fs.readFileString(path), "original");
    }),
  );

  it.effect("stages a package without changing workspace files during use", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pack-stage-test-" });
      const serverDirectory = `${directory}/apps/server`;
      const packageJsonPath = `${serverDirectory}/package.json`;
      const iconPath = `${serverDirectory}/dist/client/icon.svg`;
      const lockfilePath = `${directory}/pnpm-lock.yaml`;

      yield* fs.makeDirectory(`${serverDirectory}/dist/client`, { recursive: true });
      yield* fs.writeFileString(packageJsonPath, "workspace package");
      yield* fs.writeFileString(`${serverDirectory}/dist/bin.mjs`, "server bundle");
      yield* fs.writeFileString(iconPath, "development icon");
      yield* fs.writeFileString(lockfilePath, "workspace lockfile");

      yield* withTemporaryPackageStage(
        serverDirectory,
        [
          { path: packageJsonPath, contents: encoder.encode("production package") },
          { path: iconPath, contents: encoder.encode("production icon") },
        ],
        (stageDirectory) =>
          Effect.gen(function* () {
            assert.equal(yield* fs.readFileString(packageJsonPath), "workspace package");
            assert.equal(yield* fs.readFileString(lockfilePath), "workspace lockfile");
            assert.equal(
              yield* fs.readFileString(`${stageDirectory}/package.json`),
              "production package",
            );
            assert.equal(
              yield* fs.readFileString(`${stageDirectory}/dist/client/icon.svg`),
              "production icon",
            );
            assert.equal(
              yield* fs.readFileString(`${stageDirectory}/dist/bin.mjs`),
              "server bundle",
            );
          }),
      );

      assert.equal(yield* fs.readFileString(packageJsonPath), "workspace package");
      assert.equal(yield* fs.readFileString(lockfilePath), "workspace lockfile");
    }),
  );
});
