// @effect-diagnostics nodeBuiltinImport:off - static source-boundary contract test
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "../../../..");
const AUTHORITY_BOUNDARY_ROOTS = [
  "apps/server/src/scaffold",
  "apps/server/src/relay",
  "infra/relay/src",
] as const;
const PROVIDER_TURN_AUTHORITY_IMPORT =
  /(?:from\s+|import\s*\(\s*)["'][^"']*provider\/(?:Services\/(?:Provider(?:Adapter|AdapterRegistry|Service)|[A-Za-z]+Adapter)|Layers\/ProviderService)(?:\.ts)?["']/u;

function productionTypeScriptFiles(directory: string): ReadonlyArray<string> {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

describe("Scaffold and relay authority boundaries", () => {
  it("cannot import the provider turn execution services", () => {
    const violations = AUTHORITY_BOUNDARY_ROOTS.flatMap((relativeRoot) =>
      productionTypeScriptFiles(NodePath.join(REPOSITORY_ROOT, relativeRoot)).flatMap((path) => {
        const source = NodeFS.readFileSync(path, "utf8");
        return PROVIDER_TURN_AUTHORITY_IMPORT.test(source)
          ? [NodePath.relative(REPOSITORY_ROOT, path)]
          : [];
      }),
    );

    expect(violations).toEqual([]);
  });
});
