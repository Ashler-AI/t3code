import { describe, expect, it } from "vite-plus/test";
import {
  appendTranscriptAnnotationsToPrompt,
  parseTranscriptAnnotationMessageSegments,
  type TranscriptAnnotationContext,
} from "./transcriptAnnotation";

const annotation: TranscriptAnnotationContext = {
  id: "selection-1",
  messageId: "message-1",
  role: "assistant",
  selectedText: "Keep this exact selected text.",
  comment: "Use this as the next-turn constraint.",
};

describe("transcript annotations", () => {
  it("appends structured transcript context after the user's prompt", () => {
    const value = appendTranscriptAnnotationsToPrompt("Please revise it.", [annotation]);
    expect(value).toContain("Please revise it.\n\n<transcript_annotation");
    expect(value).toContain("<selected_text>\nKeep this exact selected text.\n</selected_text>");
  });

  it("round-trips annotation text and escaped attributes", () => {
    const escaped = { ...annotation, id: 'selection-"<&' };
    const segments = parseTranscriptAnnotationMessageSegments(
      appendTranscriptAnnotationsToPrompt("Next prompt", [escaped]),
    );
    expect(segments).toEqual([
      { kind: "text", id: "transcript-text:0", text: "Next prompt\n\n" },
      { kind: "transcript-annotation", annotation: escaped },
    ]);
  });
});
