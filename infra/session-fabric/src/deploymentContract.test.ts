import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const readFile = (url: URL) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = yield* path.fromFileUrl(url);
    return yield* fileSystem.readFileString(filePath);
  });

describe("session fabric proof deployment", () => {
  it.effect("uses shared remote state and a stable isolated Worker name", () =>
    Effect.gen(function* () {
      const stack = yield* readFile(new URL("../alchemy.run.ts", import.meta.url));
      const worker = yield* readFile(new URL("./SessionFabricApi.ts", import.meta.url));

      expect(stack).toContain("state: Cloudflare.state()");
      expect(stack).not.toContain("state: Alchemy.localState()");
      expect(worker).toContain('name: "ashler-session-fabric-proof"');
      expect(worker).toContain("SESSION_FABRIC_DEPLOYMENT_MARKER:");
      expect(worker).toContain("process.env.SESSION_FABRIC_DEPLOYMENT_MARKER");
      expect(worker).not.toContain("SESSION_FABRIC_ALLOWED_ORIGINS: process.env");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves the shared proof Worker under the Platform controller's sole ownership", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workflowPath = yield* path.fromFileUrl(
        new URL("../../../.github/workflows/deploy-session-fabric-proof.yml", import.meta.url),
      );
      const packageJson = yield* readFile(new URL("../package.json", import.meta.url));
      const readme = yield* readFile(new URL("../README.md", import.meta.url));

      expect(yield* fileSystem.exists(workflowPath)).toBe(false);
      expect(packageJson).toContain('"deploy": "alchemy deploy"');
      expect(packageJson).toContain('"destroy": "alchemy destroy"');
      expect(packageJson).toContain('"wrangler": "4.114.0"');
      expect(readme).toContain("sole CI deployment owner");
      expect(readme).toContain("Do not run `pnpm --dir infra/session-fabric deploy`");
      expect(readme).toMatch(/forcing\s+reconciliation/u);
      expect(readme).toMatch(/fails closed instead of overwriting a newer external\s+deployment/u);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
