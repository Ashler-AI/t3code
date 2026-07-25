import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface TemporaryFileReplacement {
  readonly path: string;
  readonly contents: Uint8Array;
}

export const withTemporaryFileReplacements = <A, E, R>(
  replacements: ReadonlyArray<TemporaryFileReplacement>,
  use: () => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* Effect.forEach(replacements, (replacement) =>
        fs
          .readFile(replacement.path)
          .pipe(Effect.map((original) => ({ ...replacement, original }))),
      );
    }),
    (files) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.forEach(files, (file) => fs.writeFile(file.path, file.contents), {
          discard: true,
        });
        return yield* use();
      }),
    (files) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.forEach(files, (file) => fs.writeFile(file.path, file.original), {
          discard: true,
        });
      }),
  );

export const withTemporaryPackageStage = <A, E, R>(
  sourceDirectory: string,
  replacements: ReadonlyArray<TemporaryFileReplacement>,
  use: (stageDirectory: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stageDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-pack-stage-" });

    yield* fs.copy(path.join(sourceDirectory, "dist"), path.join(stageDirectory, "dist"));
    yield* Effect.forEach(
      replacements,
      (replacement) =>
        fs.writeFile(
          path.join(stageDirectory, path.relative(sourceDirectory, replacement.path)),
          replacement.contents,
        ),
      { discard: true },
    );

    return yield* use(stageDirectory);
  });
