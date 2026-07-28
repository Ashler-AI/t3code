#!/usr/bin/env node
// @effect-diagnostics globalDate:off nodeBuiltinImport:off - This GitHub Actions helper manages an ephemeral host-side key file and timestamps short-lived proof tokens.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  mintDeploymentProofCapabilities,
  parseDeploymentProofAllowedOrigins,
  prepareDeploymentProofVerifier,
} from "../src/deploymentProofAuth.ts";

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
};

const command = process.argv[2];
if (command === "verifier") {
  const origins = parseDeploymentProofAllowedOrigins(requiredEnv("SESSION_FABRIC_ALLOWED_ORIGINS"));
  const additionalPublicKeysJson = process.env.SESSION_FABRIC_PROOF_ADDITIONAL_PUBLIC_KEYS_JSON;
  const keyPair = prepareDeploymentProofVerifier({
    privateKey: requiredEnv("SESSION_FABRIC_PROOF_SIGNING_PRIVATE_KEY"),
    ...(additionalPublicKeysJson === undefined ? {} : { additionalPublicKeysJson }),
  });
  const privateKeyPath = NodePath.join(requiredEnv("RUNNER_TEMP"), "session-fabric-proof-key.pem");
  NodeFS.writeFileSync(privateKeyPath, keyPair.privateKey, { mode: 0o600 });
  NodeFS.appendFileSync(
    requiredEnv("GITHUB_ENV"),
    [
      `SESSION_FABRIC_CAPABILITY_PUBLIC_KEYS_JSON=${keyPair.publicKeysJson}`,
      `SESSION_FABRIC_PROOF_KEY_ID=${keyPair.keyId}`,
      `SESSION_FABRIC_PROOF_PRIVATE_KEY_PATH=${privateKeyPath}`,
      `SESSION_FABRIC_SMOKE_SCAFFOLD_ORIGIN=${origins[0]}`,
    ].join("\n") + "\n",
  );
} else if (command === "capabilities") {
  const capabilities = mintDeploymentProofCapabilities({
    keyId: requiredEnv("SESSION_FABRIC_PROOF_KEY_ID"),
    privateKey: NodeFS.readFileSync(requiredEnv("SESSION_FABRIC_PROOF_PRIVATE_KEY_PATH"), "utf8"),
    runId: requiredEnv("GITHUB_RUN_ID"),
    runAttempt: requiredEnv("GITHUB_RUN_ATTEMPT"),
    nowEpochSeconds: Math.floor(Date.now() / 1_000),
  });
  process.stdout.write(
    `::add-mask::${capabilities.viewerCapability}\n` +
      `::add-mask::${capabilities.runnerCapability}\n`,
  );
  NodeFS.appendFileSync(
    requiredEnv("GITHUB_ENV"),
    `SESSION_FABRIC_SMOKE_VIEWER_CAPABILITY=${capabilities.viewerCapability}\n` +
      `SESSION_FABRIC_SMOKE_RUNNER_CAPABILITY=${capabilities.runnerCapability}\n`,
  );
} else {
  throw new Error("Usage: deployment-proof-auth.ts <verifier|capabilities>");
}
