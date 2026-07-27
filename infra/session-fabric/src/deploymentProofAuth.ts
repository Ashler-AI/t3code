import * as NodeCrypto from "node:crypto";

import {
  DEPLOYMENT_SMOKE_RUNNER_ID,
  DEPLOYMENT_SMOKE_SCAFFOLD_LIFECYCLE_EPOCH,
  DEPLOYMENT_SMOKE_SCAFFOLD_SESSION_ID,
} from "./deploymentSmoke.ts";

export const DEPLOYMENT_PROOF_CAPABILITY_ISSUER = "https://session-fabric-proof.t3.tools";
export const DEPLOYMENT_PROOF_CAPABILITY_AUDIENCE = "t3code-session-fabric-proof";
export const DEPLOYMENT_PROOF_CAPABILITY_TYP = "ashler-session-fabric-capability+jwt";

export function parseDeploymentProofAllowedOrigins(value: string): readonly string[] {
  const origins = value
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/u, ""))
    .filter(Boolean);
  if (origins.length === 0) {
    throw new Error("SESSION_FABRIC_ALLOWED_ORIGINS must contain a Scaffold origin.");
  }
  for (const origin of origins) {
    const url = new URL(origin);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== origin) {
      throw new Error(`Invalid allowed Scaffold origin: ${origin}`);
    }
  }
  return origins;
}

export function generateDeploymentProofKeyPair(input: {
  readonly runId: string;
  readonly runAttempt: string;
}): {
  readonly keyId: string;
  readonly privateKey: string;
  readonly publicKeysJson: string;
} {
  const keyId = `proof-${input.runId}-${input.runAttempt}`;
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  return {
    keyId,
    privateKey,
    publicKeysJson: JSON.stringify({ [keyId]: publicKey }),
  };
}

const encodeJwtPart = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

function signCapability(input: {
  readonly claims: Readonly<Record<string, unknown>>;
  readonly keyId: string;
  readonly privateKey: string;
}): string {
  const header = encodeJwtPart({
    alg: "EdDSA",
    kid: input.keyId,
    typ: DEPLOYMENT_PROOF_CAPABILITY_TYP,
  });
  const payload = encodeJwtPart(input.claims);
  const signingInput = `${header}.${payload}`;
  const signature = NodeCrypto.sign(null, Buffer.from(signingInput), input.privateKey).toString(
    "base64url",
  );
  return `${signingInput}.${signature}`;
}

export function mintDeploymentProofCapabilities(input: {
  readonly keyId: string;
  readonly privateKey: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly nowEpochSeconds: number;
}): { readonly viewerCapability: string; readonly runnerCapability: string } {
  const base = {
    v: 1,
    iss: DEPLOYMENT_PROOF_CAPABILITY_ISSUER,
    aud: DEPLOYMENT_PROOF_CAPABILITY_AUDIENCE,
    sub: "github-session-fabric-proof",
    iat: input.nowEpochSeconds,
    nbf: input.nowEpochSeconds,
  } as const;
  const viewerCapability = signCapability({
    keyId: input.keyId,
    privateKey: input.privateKey,
    claims: {
      ...base,
      jti: `viewer-${input.runId}-${input.runAttempt}`,
      exp: input.nowEpochSeconds + 300,
      role: "viewer",
      actorId: "github-session-fabric-proof",
      scopes: ["directory:read", "session:read"],
    },
  });
  const runnerCapability = signCapability({
    keyId: input.keyId,
    privateKey: input.privateKey,
    claims: {
      ...base,
      jti: `runner-${input.runId}-${input.runAttempt}`,
      exp: input.nowEpochSeconds + 900,
      role: "runner",
      runnerId: DEPLOYMENT_SMOKE_RUNNER_ID,
      scopes: ["session:publish", "session:execute"],
      scaffoldSessionId: DEPLOYMENT_SMOKE_SCAFFOLD_SESSION_ID,
      scaffoldLifecycleEpoch: DEPLOYMENT_SMOKE_SCAFFOLD_LIFECYCLE_EPOCH,
    },
  });
  return { viewerCapability, runnerCapability };
}
