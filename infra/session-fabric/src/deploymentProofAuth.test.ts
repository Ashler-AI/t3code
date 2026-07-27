import { describe, expect, it } from "@effect/vitest";
import {
  parseSessionFabricPublicKeys,
  verifySessionFabricCapability,
} from "@t3tools/shared/sessionFabricCapability";
import * as Effect from "effect/Effect";

import {
  DEPLOYMENT_PROOF_CAPABILITY_AUDIENCE,
  DEPLOYMENT_PROOF_CAPABILITY_ISSUER,
  generateDeploymentProofKeyPair,
  mintDeploymentProofCapabilities,
  parseDeploymentProofAllowedOrigins,
} from "./deploymentProofAuth.ts";
import {
  DEPLOYMENT_SMOKE_RUNNER_ID,
  DEPLOYMENT_SMOKE_SCAFFOLD_LIFECYCLE_EPOCH,
  DEPLOYMENT_SMOKE_SCAFFOLD_SESSION_ID,
} from "./deploymentSmoke.ts";

const NOW = 1_785_000_000;

describe("session fabric deployment proof auth", () => {
  it("normalizes exact allowed Scaffold origins and rejects paths", () => {
    expect(
      parseDeploymentProofAllowedOrigins(
        " https://one.scaffold.example/,https://two.scaffold.example ",
      ),
    ).toEqual(["https://one.scaffold.example", "https://two.scaffold.example"]);
    expect(() => parseDeploymentProofAllowedOrigins("https://scaffold.example/path")).toThrow(
      "Invalid allowed Scaffold origin",
    );
  });

  it.effect("mints distinct viewer and runner capabilities accepted by the deployed verifier", () =>
    Effect.gen(function* () {
      const keyPair = generateDeploymentProofKeyPair({ runId: "42", runAttempt: "3" });
      const capabilities = mintDeploymentProofCapabilities({
        keyId: keyPair.keyId,
        privateKey: keyPair.privateKey,
        runId: "42",
        runAttempt: "3",
        nowEpochSeconds: NOW,
      });
      const config = {
        mode: "required" as const,
        issuer: DEPLOYMENT_PROOF_CAPABILITY_ISSUER,
        audience: DEPLOYMENT_PROOF_CAPABILITY_AUDIENCE,
        publicKeys: parseSessionFabricPublicKeys(keyPair.publicKeysJson),
      };

      expect(capabilities.viewerCapability).not.toBe(capabilities.runnerCapability);
      expect(
        yield* verifySessionFabricCapability({
          config,
          token: capabilities.viewerCapability,
          nowEpochSeconds: NOW,
        }),
      ).toMatchObject({
        role: "viewer",
        scopes: ["directory:read", "session:read"],
        exp: NOW + 300,
      });
      expect(
        yield* verifySessionFabricCapability({
          config,
          token: capabilities.runnerCapability,
          nowEpochSeconds: NOW,
        }),
      ).toMatchObject({
        role: "runner",
        runnerId: DEPLOYMENT_SMOKE_RUNNER_ID,
        scopes: ["session:publish", "session:execute"],
        scaffoldSessionId: DEPLOYMENT_SMOKE_SCAFFOLD_SESSION_ID,
        scaffoldLifecycleEpoch: DEPLOYMENT_SMOKE_SCAFFOLD_LIFECYCLE_EPOCH,
        exp: NOW + 900,
      });
    }),
  );
});
