import { beforeAll, describe, expect, it } from "vite-plus/test";
import { build } from "vite";

const webRoot = decodeURIComponent(new URL("../..", import.meta.url).pathname);
let productionIndex = "";

function bootstrapAssetReferences(html: string): ReadonlyArray<string> {
  const references: Array<string> = [];
  for (const match of html.matchAll(/<(?:link|script|img)\b[^>]*\b(?:href|src)="([^"]+)"[^>]*>/g)) {
    const reference = match[1];
    if (reference && !reference.startsWith("data:")) {
      references.push(reference);
    }
  }
  return references;
}

function bootstrapBaseHref(html: string): string {
  const match = html.match(/<base\b[^>]*\bhref="([^"]+)"[^>]*>/);
  if (!match?.[1]) {
    throw new Error("Production build did not emit a base href.");
  }
  return match[1];
}

beforeAll(async () => {
  const result = await build({
    configFile: `${webRoot}/vite.config.ts`,
    root: webRoot,
    build: {
      sourcemap: false,
      write: false,
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const indexAsset = outputs
    .flatMap((output) => ("output" in output ? output.output : []))
    .find((output) => output.type === "asset" && output.fileName === "index.html");
  if (indexAsset?.type !== "asset" || typeof indexAsset.source !== "string") {
    throw new Error("Production build did not emit index.html as a text asset.");
  }
  productionIndex = indexAsset.source;
}, 120_000);

describe("production bootstrap assets", () => {
  it("emits only document-relative bootstrap asset references", () => {
    const references = bootstrapAssetReferences(productionIndex);

    expect(references.length).toBeGreaterThanOrEqual(5);
    expect(references).toEqual(
      expect.arrayContaining([
        "./ashler-code-mark.svg",
        expect.stringMatching(/^\.\/assets\/.*\.js$/),
        expect.stringMatching(/^\.\/assets\/.*\.css$/),
      ]),
    );
    expect(references.every((reference) => reference.startsWith("./"))).toBe(true);
    expect(bootstrapBaseHref(productionIndex)).toBe("/");
  });

  it.each([
    {
      baseHref: "/",
      documentUrl: "https://app.example.test/settings/general",
      expectedAssetPrefix: "/",
    },
    {
      baseHref: "/",
      documentUrl: "https://app.example.test/thread/thread_123",
      expectedAssetPrefix: "/",
    },
    {
      baseHref: "/",
      documentUrl: "https://app.example.test/connect/callback",
      expectedAssetPrefix: "/",
    },
    {
      baseHref: "/sessions/ses_123/agent/",
      documentUrl: "https://scaffold.example.test/sessions/ses_123/agent/settings/general",
      expectedAssetPrefix: "/sessions/ses_123/agent/",
    },
    {
      baseHref: "/sessions/ses_123/agent/",
      documentUrl: "https://scaffold.example.test/sessions/ses_123/agent/thread/thread_123",
      expectedAssetPrefix: "/sessions/ses_123/agent/",
    },
    {
      baseHref: "/sessions/ses_123/agent/",
      documentUrl: "https://scaffold.example.test/sessions/ses_123/agent/connect/callback",
      expectedAssetPrefix: "/sessions/ses_123/agent/",
    },
  ])(
    "resolves bootstrap assets from $documentUrl through base $baseHref",
    ({ baseHref, documentUrl, expectedAssetPrefix }) => {
      const baseUrl = new URL(baseHref, documentUrl);

      for (const reference of bootstrapAssetReferences(productionIndex)) {
        const resolved = new URL(reference, baseUrl);
        expect(resolved.origin).toBe(new URL(documentUrl).origin);
        expect(resolved.pathname.startsWith(expectedAssetPrefix)).toBe(true);
        expect(resolved.pathname).not.toContain("/settings/");
        expect(resolved.pathname).not.toContain("/thread/");
        expect(resolved.pathname).not.toContain("/connect/");
      }
    },
  );
});
