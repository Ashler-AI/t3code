import { describe, expect, it } from "vite-plus/test";

import { scaffoldSessionTransferKind, scaffoldSessionTransferPresentation } from "./index.ts";

describe("Scaffold session transfer classification", () => {
  it("distinguishes exact OMP continuation from contextual native handoff", () => {
    expect(scaffoldSessionTransferKind("omp")).toBe("exact-omp");
    expect(scaffoldSessionTransferKind("Codex")).toBe("contextual-native");
    expect(scaffoldSessionTransferKind("claudeAgent")).toBe("contextual-native");
    expect(scaffoldSessionTransferKind("Claude Agent")).toBe("contextual-native");
    expect(scaffoldSessionTransferKind("opencode")).toBeNull();
    expect(scaffoldSessionTransferKind(null)).toBeNull();
  });

  it("states explicitly that a native handoff is not exact continuation", () => {
    const contextual = scaffoldSessionTransferPresentation("contextual-native");
    expect(contextual.commandTitle).toContain("context only");
    expect(contextual.disclosure).toMatch(/new OMP session/i);
    expect(contextual.disclosure).toMatch(/does not continue/i);

    const exact = scaffoldSessionTransferPresentation("exact-omp");
    expect(exact.commandTitle).toBe("Copy to Scaffold");
    expect(exact.disclosure).toBeNull();
  });
});
