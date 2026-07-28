import * as NodeCrypto from "node:crypto";

import {
  DEPLOYMENT_SMOKE_RUNNER_ID,
  DEPLOYMENT_SMOKE_SCAFFOLD_LIFECYCLE_EPOCH,
  DEPLOYMENT_SMOKE_SCAFFOLD_SESSION_ID,
} from "./deploymentSmoke.ts";

export const DEPLOYMENT_PROOF_CAPABILITY_ISSUER = "https://session-fabric-proof.t3.tools";
export const DEPLOYMENT_PROOF_CAPABILITY_AUDIENCE = "t3code-session-fabric-proof";
export const DEPLOYMENT_PROOF_CAPABILITY_TYP = "ashler-session-fabric-capability+jwt";

const normalizePem = (value: string): string => value.replace(/\\n/gu, "\n").trim();

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

export function prepareDeploymentProofVerifier(input: {
  readonly privateKey: string;
  readonly additionalPublicKeysJson?: string;
}): {
  readonly keyId: string;
  readonly privateKey: string;
  readonly publicKeysJson: string;
} {
  const privateKeyObject = parseEd25519PrivateKey(input.privateKey);
  const privateKey = privateKeyObject.export({ format: "pem", type: "pkcs8" }).toString().trim();
  const publicKeyObject = NodeCrypto.createPublicKey(privateKeyObject);
  const publicKey = publicKeyObject.export({ format: "pem", type: "spki" }).toString().trim();
  const publicKeyDer = publicKeyObject.export({ format: "der", type: "spki" });
  const keyId = `proof-${NodeCrypto.createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 24)}`;
  const additionalPublicKeys = parseAdditionalPublicKeys(input.additionalPublicKeysJson);
  const conflictingKey = additionalPublicKeys[keyId];
  if (conflictingKey !== undefined && normalizePem(conflictingKey) !== publicKey) {
    throw new Error(`Additional verifier key ${keyId} conflicts with the signing key.`);
  }
  return {
    keyId,
    privateKey,
    publicKeysJson: JSON.stringify({ ...additionalPublicKeys, [keyId]: publicKey }),
  };
}

function parseAdditionalPublicKeys(value: string | undefined): Record<string, string> {
  if (value === undefined || value.trim().length === 0) return {};
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("SESSION_FABRIC_PROOF_ADDITIONAL_PUBLIC_KEYS_JSON must be a JSON object.");
  }
  const entries = Object.entries(parsed);
  for (const [keyId, publicKey] of entries) {
    if (keyId.length === 0 || typeof publicKey !== "string" || publicKey.trim().length === 0) {
      throw new Error(
        "SESSION_FABRIC_PROOF_ADDITIONAL_PUBLIC_KEYS_JSON must map key IDs to public keys.",
      );
    }
  }
  return Object.fromEntries(
    entries.map(([keyId, publicKey]) => [
      keyId,
      parseEd25519PublicKey(publicKey as string)
        .export({ format: "pem", type: "spki" })
        .toString()
        .trim(),
    ]),
  );
}

function parseEd25519PrivateKey(value: string): NodeCrypto.KeyObject {
  let key: NodeCrypto.KeyObject;
  try {
    key = NodeCrypto.createPrivateKey(normalizePem(value));
  } catch {
    throw new Error(
      "SESSION_FABRIC_PROOF_SIGNING_PRIVATE_KEY must be a valid Ed25519 private key.",
    );
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("SESSION_FABRIC_PROOF_SIGNING_PRIVATE_KEY must be an Ed25519 private key.");
  }
  return key;
}

function parseEd25519PublicKey(value: string): NodeCrypto.KeyObject {
  const normalized = normalizePem(value);
  if (
    !normalized.startsWith("-----BEGIN PUBLIC KEY-----\n") ||
    !normalized.endsWith("\n-----END PUBLIC KEY-----")
  ) {
    throw new Error(
      "SESSION_FABRIC_PROOF_ADDITIONAL_PUBLIC_KEYS_JSON must contain valid Ed25519 public keys.",
    );
  }
  let key: NodeCrypto.KeyObject;
  try {
    key = NodeCrypto.createPublicKey(normalized);
  } catch {
    throw new Error(
      "SESSION_FABRIC_PROOF_ADDITIONAL_PUBLIC_KEYS_JSON must contain valid Ed25519 public keys.",
    );
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      "SESSION_FABRIC_PROOF_ADDITIONAL_PUBLIC_KEYS_JSON must contain only Ed25519 public keys.",
    );
  }
  return key;
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
