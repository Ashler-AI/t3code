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
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("binds required auth and only the credentials needed by the proof deployment", () =>
    Effect.gen(function* () {
      const workflow = yield* readFile(
        new URL("../../../.github/workflows/deploy-session-fabric-proof.yml", import.meta.url),
      );

      expect(workflow).toContain("workflow_dispatch:");
      expect(workflow).toContain("name: session-fabric-proof");
      expect(workflow).toContain("contents: read");
      expect(workflow).toContain("id-token: none");
      expect(workflow).toContain("CLOUDFLARE_ACCOUNT_ID");
      expect(workflow).toContain("CLOUDFLARE_API_TOKEN");
      expect(workflow).toContain("BASETEN_API_KEY: ${{ secrets.BASETEN_API_KEY }}");
      expect(workflow).toContain("BASETEN_EMBEDDING_URL: ${{ vars.BASETEN_EMBEDDING_URL }}");
      expect(workflow).toContain(
        "SESSION_FABRIC_ALLOWED_ORIGINS: ${{ vars.SESSION_FABRIC_ALLOWED_ORIGINS }}",
      );
      expect(workflow).toContain("SESSION_FABRIC_AUTH_MODE: required");
      expect(workflow).toContain("SESSION_FABRIC_CAPABILITY_AUDIENCE: t3code-session-fabric-proof");
      expect(workflow).toContain(
        "SESSION_FABRIC_CAPABILITY_ISSUER: https://session-fabric-proof.t3.tools",
      );
      expect(workflow).toContain("deployment-proof-auth.ts verifier");
      expect(workflow).toContain("deployment-proof-auth.ts capabilities");
      expect(workflow).not.toContain("SESSION_FABRIC_AUTH_MODE: disabled");
      expect(workflow).toContain("--stage proof --yes");
      expect(workflow).toContain("ashler-session-fabric-proof");
      expect(workflow).toContain("smoke:deployment");
      expect(workflow).toContain('--marker "github-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"');
      expect(workflow).toContain('--scaffold-origin "${SESSION_FABRIC_SMOKE_SCAFFOLD_ORIGIN}"');
      expect(workflow).not.toContain("/health");

      for (const unrelatedCredential of [
        "PLANETSCALE",
        "CLERK",
        "APNS",
        "AXIOM",
        "RELAY_DOMAIN",
        "RELAY_API_ZONE_NAME",
        "RELAY_TUNNEL_ZONE_NAME",
      ]) {
        expect(workflow).not.toContain(unrelatedCredential);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
