import { describe, expect, it } from "vite-plus/test";
import { shouldConfirmTranscriptAnnotation } from "./TranscriptSelectionAffordance";

describe("transcript annotation keyboard behavior", () => {
  it("confirms with plain Enter", () => {
    expect(
      shouldConfirmTranscriptAnnotation({
        key: "Enter",
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
  });

  it.each(["altKey", "ctrlKey", "metaKey", "shiftKey"] as const)(
    "keeps a newline for modified Enter using %s",
    (modifier) => {
      expect(
        shouldConfirmTranscriptAnnotation({
          key: "Enter",
          altKey: false,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          [modifier]: true,
        }),
      ).toBe(false);
    },
  );
});
