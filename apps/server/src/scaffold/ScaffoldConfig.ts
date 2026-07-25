// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ScaffoldDeployment } from "@t3tools/contracts";

export type ScaffoldAuthMode = "iap" | "oauth";

export interface ScaffoldTargetConfig {
  readonly deployment: ScaffoldDeployment;
  readonly baseUrl: string;
  readonly authMode: ScaffoldAuthMode;
  readonly collectionPath: "/api/sessions" | "/api/code-sandboxes/agent-sessions";
  readonly authorization: string;
}

const REQUIRED_REMOTE_CODE_SCOPES = [
  "remote_code:create",
  "remote_code:read",
  "remote_code:write",
  "remote_code:exec",
  "remote_code:lifecycle",
] as const;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function oauthTokenFile(
  deployment: ScaffoldDeployment,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const prefix =
    deployment === "staging" ? "T3CODE_SCAFFOLD_STAGING" : "T3CODE_SCAFFOLD_PRODUCTION";
  return (
    environment[`${prefix}_OAUTH_TOKEN_FILE`]?.trim() ||
    NodePath.join(
      NodeOS.homedir(),
      ".config",
      "scaffold",
      deployment === "staging" ? "remote-code-oauth-staging.json" : "remote-code-oauth.json",
    )
  );
}

function oauthAuthorization(
  deployment: ScaffoldDeployment,
  baseUrl: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const tokenFile = oauthTokenFile(deployment, environment);
  try {
    const metadata = NodeFS.statSync(tokenFile);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("unsafe permissions");
    const cache = JSON.parse(NodeFS.readFileSync(tokenFile, "utf8")) as Record<string, unknown>;
    const token = text(cache.accessToken);
    const resource = text(cache.resource);
    const tokenType = text(cache.tokenType)?.toLowerCase();
    const scopes = new Set((text(cache.scope) ?? "").split(/\s+/u).filter(Boolean));
    if (
      !token ||
      tokenType !== "bearer" ||
      !resource ||
      new URL(resource).origin !== new URL(baseUrl).origin ||
      !REQUIRED_REMOTE_CODE_SCOPES.every((scope) => scopes.has(scope))
    ) {
      throw new Error("invalid credential");
    }
    return `Bearer ${token}`;
  } catch {
    throw new ScaffoldConfigurationError();
  }
}

export class ScaffoldConfigurationError extends Error {
  constructor() {
    super("Scaffold is not configured for the requested deployment.");
    this.name = "ScaffoldConfigurationError";
  }
}

function secureOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      return undefined;
    }
    return `${url.origin}/`;
  } catch {
    return undefined;
  }
}

export function resolveScaffoldTarget(
  deployment: ScaffoldDeployment,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ScaffoldTargetConfig {
  const prefix =
    deployment === "staging" ? "T3CODE_SCAFFOLD_STAGING" : "T3CODE_SCAFFOLD_PRODUCTION";
  const baseUrl = secureOrigin(environment[`${prefix}_URL`]);
  if (!baseUrl) throw new ScaffoldConfigurationError();
  const configuredMode = environment[`${prefix}_AUTH_MODE`]?.trim().toLowerCase();
  const rawAuthorization = environment[`${prefix}_AUTHORIZATION`]?.trim();
  const authMode = configuredMode || (rawAuthorization ? "iap" : "oauth");
  if (authMode !== "iap" && authMode !== "oauth") throw new ScaffoldConfigurationError();
  const authorization =
    authMode === "oauth" ? oauthAuthorization(deployment, baseUrl, environment) : rawAuthorization;
  if (!authorization) throw new ScaffoldConfigurationError();
  return {
    deployment,
    baseUrl,
    authMode,
    collectionPath: authMode === "oauth" ? "/api/code-sandboxes/agent-sessions" : "/api/sessions",
    authorization,
  };
}
