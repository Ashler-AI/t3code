import { describe, expect, it } from "vite-plus/test";

import {
  serializeComposerFileLink,
  serializeComposerMentionPath,
  serializeComposerSessionReference,
  serializeComposerSkillReference,
} from "./composerTrigger.ts";

describe("serializeComposerMentionPath", () => {
  it("keeps simple mention paths unquoted", () => {
    expect(serializeComposerMentionPath("src/index.ts")).toBe("src/index.ts");
  });

  it("quotes mention paths containing whitespace", () => {
    expect(serializeComposerMentionPath("docs/My File.md")).toBe('"docs/My File.md"');
  });

  it("escapes quoted mention path content", () => {
    expect(serializeComposerMentionPath('docs/My "File".md')).toBe('"docs/My \\"File\\".md"');
  });
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

describe("typed composer references", () => {
  it("serializes provider-qualified skill references", () => {
    expect(serializeComposerSkillReference("omp", "code-review")).toBe("@[skill|omp|code-review]");
  });

  it("serializes session identity and worktree metadata", () => {
    expect(
      serializeComposerSessionReference({
        environmentId: "local:primary",
        threadId: "thread 1",
        worktreePath: "/tmp/work tree",
      }),
    ).toBe("@[session|local%3Aprimary|thread%201|%2Ftmp%2Fwork%20tree]");
  });
});
