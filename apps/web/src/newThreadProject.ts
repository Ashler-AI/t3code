import type { Project } from "./types";

import productManifest from "../../../ashler/product.json";

const DEFAULT_REPOSITORY_BASENAME = productManifest.defaultRepositoryBasename.toLowerCase();

export function selectDefaultNewThreadProject(
  orderedProjects: ReadonlyArray<Project>,
): Project | null {
  return (
    orderedProjects.find((project) => {
      const normalizedRoot = project.workspaceRoot.replace(/[\\/]+$/, "");
      return normalizedRoot.split(/[\\/]/).at(-1)?.toLowerCase() === DEFAULT_REPOSITORY_BASENAME;
    }) ??
    orderedProjects[0] ??
    null
  );
}
