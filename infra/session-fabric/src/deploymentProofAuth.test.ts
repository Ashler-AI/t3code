// @effect-diagnostics preferSchemaOverJson:off - Node crypto fixtures exercise the host-side JSON verifier envelope directly.
import { describe, expect, it } from "@effect/vitest";
import {
  parseSessionFabricPublicKeys,
  verifySessionFabricCapability,
} from "@t3tools/shared/sessionFabricCapability";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";

import {
  DEPLOYMENT_PROOF_CAPABILITY_AUDIENCE,
  DEPLOYMENT_PROOF_CAPABILITY_ISSUER,
  mintDeploymentProofCapabilities,
  parseDeploymentProofAllowedOrigins,
  prepareDeploymentProofVerifier,
} from "./deploymentProofAuth.ts";
import {
  DEPLOYMENT_SMOKE_RUNNER_ID,
  DEPLOYMENT_SMOKE_SCAFFOLD_LIFECYCLE_EPOCH,
  DEPLOYMENT_SMOKE_SCAFFOLD_SESSION_ID,
} from "./deploymentSmoke.ts";

const NOW = 1_785_000_000;

describe("session fabric deployment proof auth", () => {
  const signingKey = NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });

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
      const keyPair = prepareDeploymentProofVerifier({ privateKey: signingKey.privateKey });
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

  it.effect("keeps the verifier identity stable and accepts an overlap signer", () =>
    Effect.gen(function* () {
      const previous = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const first = prepareDeploymentProofVerifier({ privateKey: signingKey.privateKey });
      const second = prepareDeploymentProofVerifier({
        privateKey: signingKey.privateKey.replaceAll("\n", "\\n"),
        additionalPublicKeysJson: JSON.stringify({ previous: previous.publicKey }),
      });
      const previousCapability = mintDeploymentProofCapabilities({
        keyId: "previous",
        privateKey: previous.privateKey,
        runId: "41",
        runAttempt: "2",
        nowEpochSeconds: NOW,
      }).viewerCapability;

      expect(second.keyId).toBe(first.keyId);
      expect(second.privateKey).toBe(first.privateKey);
      expect(JSON.parse(second.publicKeysJson)).toMatchObject({
        previous: previous.publicKey.trim(),
        [first.keyId]: JSON.parse(first.publicKeysJson)[first.keyId],
      });
      expect(
        yield* verifySessionFabricCapability({
          config: {
            mode: "required",
            issuer: DEPLOYMENT_PROOF_CAPABILITY_ISSUER,
            audience: DEPLOYMENT_PROOF_CAPABILITY_AUDIENCE,
            publicKeys: parseSessionFabricPublicKeys(second.publicKeysJson),
          },
          token: previousCapability,
          nowEpochSeconds: NOW,
        }),
      ).toMatchObject({ role: "viewer" });
    }),
  );

  it("rejects malformed and non-Ed25519 signing keys before deployment", () => {
    const rsa = NodeCrypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const ec = NodeCrypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });

    expect(() => prepareDeploymentProofVerifier({ privateKey: "not a PEM" })).toThrow(
      "valid Ed25519 private key",
    );
    expect(() => prepareDeploymentProofVerifier({ privateKey: rsa.privateKey })).toThrow(
      "must be an Ed25519 private key",
    );
    expect(() => prepareDeploymentProofVerifier({ privateKey: ec.privateKey })).toThrow(
      "must be an Ed25519 private key",
    );
  });

  it("rejects malformed and non-Ed25519 overlap verifier keys before deployment", () => {
    const rsa = NodeCrypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const ec = NodeCrypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });

    for (const publicKey of ["not a PEM", signingKey.privateKey, rsa.publicKey, ec.publicKey]) {
      expect(() =>
        prepareDeploymentProofVerifier({
          privateKey: signingKey.privateKey,
          additionalPublicKeysJson: JSON.stringify({ previous: publicKey }),
        }),
      ).toThrow(/Ed25519 public keys/u);
    }
  });
});
