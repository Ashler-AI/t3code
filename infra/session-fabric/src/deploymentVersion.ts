export const DEPLOYMENT_PROOF_WORKER_NAME = "ashler-session-fabric-proof";

const VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER_NOT_FOUND_PATTERN = /\[code:\s*10007\]/u;

export function isMissingWorkerDeploymentError(stderr: string): boolean {
  return WORKER_NOT_FOUND_PATTERN.test(stderr);
}

export function capturePriorDeploymentVersion(
  value: unknown,
  options: { readonly allowMissingBootstrap: boolean },
): string | null {
  if (!Array.isArray(value)) {
    throw new Error("Wrangler deployments list must return a JSON array.");
  }
  if (value.length === 0) {
    if (options.allowMissingBootstrap) return null;
    throw new Error(
      `Worker ${DEPLOYMENT_PROOF_WORKER_NAME} has no prior deployment; explicit fresh-bootstrap mode is required.`,
    );
  }
  const latest: unknown = value.at(-1);
  if (typeof latest !== "object" || latest === null || Array.isArray(latest)) {
    throw new Error("Wrangler returned an invalid active deployment.");
  }
  const versions = Reflect.get(latest, "versions");
  if (!Array.isArray(versions) || versions.length !== 1) {
    throw new Error("The active proof Worker deployment must contain exactly one version.");
  }
  const active: unknown = versions[0];
  if (typeof active !== "object" || active === null || Array.isArray(active)) {
    throw new Error("Wrangler returned an invalid active Worker version.");
  }
  const versionId = Reflect.get(active, "version_id");
  const percentage = Reflect.get(active, "percentage");
  if (typeof versionId !== "string" || !VERSION_ID_PATTERN.test(versionId)) {
    throw new Error("Wrangler returned an invalid active Worker version ID.");
  }
  if (percentage !== 100) {
    throw new Error("The active proof Worker version must receive 100 percent of traffic.");
  }
  return versionId;
}
