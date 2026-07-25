// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { resolveScaffoldTarget, ScaffoldConfigurationError } from "./ScaffoldConfig.ts";

describe("resolveScaffoldTarget", () => {
  it("selects only the explicitly requested validated deployment", () => {
    const environment = {
      T3CODE_SCAFFOLD_STAGING_URL: "https://scaffold-staging.example.com/",
      T3CODE_SCAFFOLD_STAGING_AUTH_MODE: "iap",
      T3CODE_SCAFFOLD_STAGING_AUTHORIZATION: "Bearer staging-secret",
      T3CODE_SCAFFOLD_PRODUCTION_URL: "https://scaffold.example.com/",
      T3CODE_SCAFFOLD_PRODUCTION_AUTH_MODE: "iap",
      T3CODE_SCAFFOLD_PRODUCTION_AUTHORIZATION: "Bearer production-secret",
    };
    expect(resolveScaffoldTarget("staging", environment)).toEqual({
      deployment: "staging",
      baseUrl: "https://scaffold-staging.example.com/",
      authMode: "iap",
      collectionPath: "/api/sessions",
      authorization: "Bearer staging-secret",
    });
    expect(resolveScaffoldTarget("production", environment)).toEqual({
      deployment: "production",
      baseUrl: "https://scaffold.example.com/",
      authMode: "iap",
      collectionPath: "/api/sessions",
      authorization: "Bearer production-secret",
    });
  });

  it("loads a deployment-matched 0600 OAuth machine credential for the agent collection", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-scaffold-auth-"));
    const tokenFile = NodePath.join(directory, "oauth.json");
    try {
      NodeFS.writeFileSync(
        tokenFile,
        JSON.stringify({
          accessToken: "machine-secret",
          resource: "https://scaffold-staging.example.com",
          tokenType: "Bearer",
          scope:
            "remote_code:create remote_code:read remote_code:write remote_code:exec remote_code:lifecycle",
        }),
        { mode: 0o600 },
      );
      expect(
        resolveScaffoldTarget("staging", {
          T3CODE_SCAFFOLD_STAGING_URL: "https://scaffold-staging.example.com/",
          T3CODE_SCAFFOLD_STAGING_AUTH_MODE: "oauth",
          T3CODE_SCAFFOLD_STAGING_OAUTH_TOKEN_FILE: tokenFile,
        }),
      ).toEqual({
        deployment: "staging",
        baseUrl: "https://scaffold-staging.example.com/",
        authMode: "oauth",
        collectionPath: "/api/code-sandboxes/agent-sessions",
        authorization: "Bearer machine-secret",
      });
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects OAuth caches with unsafe permissions or a mismatched resource", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-scaffold-auth-"));
    const tokenFile = NodePath.join(directory, "oauth.json");
    const environment = {
      T3CODE_SCAFFOLD_STAGING_URL: "https://scaffold-staging.example.com/",
      T3CODE_SCAFFOLD_STAGING_AUTH_MODE: "oauth",
      T3CODE_SCAFFOLD_STAGING_OAUTH_TOKEN_FILE: tokenFile,
    };
    try {
      NodeFS.writeFileSync(
        tokenFile,
        JSON.stringify({
          accessToken: "machine-secret",
          resource: "https://scaffold.example.com",
          tokenType: "Bearer",
          scope:
            "remote_code:create remote_code:read remote_code:write remote_code:exec remote_code:lifecycle",
        }),
        { mode: 0o600 },
      );
      expect(() => resolveScaffoldTarget("staging", environment)).toThrow(
        ScaffoldConfigurationError,
      );
      NodeFS.writeFileSync(
        tokenFile,
        NodeFS.readFileSync(tokenFile, "utf8").replace(
          "https://scaffold.example.com",
          "https://scaffold-staging.example.com",
        ),
      );
      NodeFS.chmodSync(tokenFile, 0o644);
      expect(() => resolveScaffoldTarget("staging", environment)).toThrow(
        ScaffoldConfigurationError,
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects missing, insecure, or credential-bearing control-plane URLs", () => {
    expect(() => resolveScaffoldTarget("staging", {})).toThrow(ScaffoldConfigurationError);
    expect(() =>
      resolveScaffoldTarget("staging", { T3CODE_SCAFFOLD_STAGING_URL: "http://example.com" }),
    ).toThrow(ScaffoldConfigurationError);
    expect(() =>
      resolveScaffoldTarget("staging", {
        T3CODE_SCAFFOLD_STAGING_URL: "https://user:pass@example.com/",
      }),
    ).toThrow(ScaffoldConfigurationError);
  });
});
