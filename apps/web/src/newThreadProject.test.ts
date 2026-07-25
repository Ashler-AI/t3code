import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import productManifest from "../../../ashler/product.json";

import type { Project } from "./types";
import { selectDefaultNewThreadProject } from "./newThreadProject";

const environmentId = EnvironmentId.make("local");

function makeProject(id: string, workspaceRoot: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("omp"),
      model: "test-model",
    },
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    scripts: [],
  };
}

describe("selectDefaultNewThreadProject", () => {
  it("prefers the product-configured repository regardless of current project order", () => {
    const recent = makeProject("recent", "/tmp/other-repository");
    const ashler = makeProject(
      "ashler",
      `/Users/example/${productManifest.defaultRepositoryBasename}/`,
    );

    expect(selectDefaultNewThreadProject([recent, ashler])).toBe(ashler);
  });

  it("preserves the existing first-project fallback when Ashler is absent", () => {
    const first = makeProject("first", "C:\\src\\another-repository");
    const second = makeProject("second", "/tmp/second");

    expect(selectDefaultNewThreadProject([first, second])).toBe(first);
    expect(selectDefaultNewThreadProject([])).toBeNull();
  });
});
