import { describe, expect, it } from "@effect/vitest";

import {
  DEPLOYMENT_PROOF_WORKER_NAME,
  capturePriorDeploymentVersion,
  isMissingWorkerDeploymentError,
} from "./deploymentVersion.ts";

const VERSION_ID = "75e22d80-7338-4ca9-a97d-c2d24ad63a90";

describe("session fabric deployment rollback version", () => {
  it("captures the single active version from Wrangler's newest deployment", () => {
    expect(
      capturePriorDeploymentVersion(
        [
          { versions: [{ version_id: "f254f64f-a1ec-4420-a166-9bdc7b7bdb64", percentage: 100 }] },
          { versions: [{ version_id: VERSION_ID, percentage: 100 }] },
        ],
        { allowMissingBootstrap: false },
      ),
    ).toBe(VERSION_ID);
    expect(DEPLOYMENT_PROOF_WORKER_NAME).toBe("ashler-session-fabric-proof");
  });

  it("allows no prior version only behind explicit fresh-bootstrap mode", () => {
    expect(() => capturePriorDeploymentVersion([], { allowMissingBootstrap: false })).toThrow(
      "explicit fresh-bootstrap mode is required",
    );
    expect(capturePriorDeploymentVersion([], { allowMissingBootstrap: true })).toBeNull();
  });

  it("recognizes only Wrangler's fixed Worker-not-found API code as fresh bootstrap", () => {
    expect(
      isMissingWorkerDeploymentError(
        "A request to the Cloudflare API failed. workers.api.error.script_not_found [code: 10007]",
      ),
    ).toBe(true);
    expect(isMissingWorkerDeploymentError("Authentication error [code: 10000]")).toBe(false);
    expect(isMissingWorkerDeploymentError("Network connection reset by peer")).toBe(false);
    expect(isMissingWorkerDeploymentError("Worker not found without an API error code")).toBe(
      false,
    );
  });

  it("rejects split traffic, unsafe version IDs, and malformed Wrangler output", () => {
    expect(() =>
      capturePriorDeploymentVersion(
        [
          {
            versions: [
              { version_id: VERSION_ID, percentage: 50 },
              { version_id: "f254f64f-a1ec-4420-a166-9bdc7b7bdb64", percentage: 50 },
            ],
          },
        ],
        { allowMissingBootstrap: false },
      ),
    ).toThrow("exactly one version");
    expect(() =>
      capturePriorDeploymentVersion(
        [{ versions: [{ version_id: "$(unsafe)", percentage: 100 }] }],
        { allowMissingBootstrap: false },
      ),
    ).toThrow("invalid active Worker version ID");
    expect(() => capturePriorDeploymentVersion({}, { allowMissingBootstrap: false })).toThrow(
      "JSON array",
    );
  });
});
