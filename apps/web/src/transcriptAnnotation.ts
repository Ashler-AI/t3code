import * as Schema from "effect/Schema";

export const TranscriptAnnotationContextSchema = Schema.Struct({
  id: Schema.String,
  messageId: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  selectedText: Schema.String,
  comment: Schema.String,
});

export type TranscriptAnnotationContext = typeof TranscriptAnnotationContextSchema.Type;

export type TranscriptAnnotationMessageSegment =
  | { readonly kind: "text"; readonly id: string; readonly text: string }
  | { readonly kind: "transcript-annotation"; readonly annotation: TranscriptAnnotationContext };

const TRANSCRIPT_ANNOTATION_PATTERN =
  /<transcript_annotation\b([^>]*)>\s*([\s\S]*?)<selected_text>\n([\s\S]*?)\n<\/selected_text>\s*<\/transcript_annotation>/g;
const ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g;

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function parseAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(ATTRIBUTE_PATTERN)) {
    attributes[match[1]!] = unescapeAttribute(match[2] ?? "");
  }
  return attributes;
}

export function formatTranscriptAnnotation(annotation: TranscriptAnnotationContext): string {
  return [
    `<transcript_annotation id="${escapeAttribute(annotation.id)}" messageId="${escapeAttribute(annotation.messageId)}" role="${annotation.role}">`,
    annotation.comment.trim(),
    "<selected_text>",
    annotation.selectedText.trim(),
    "</selected_text>",
    "</transcript_annotation>",
  ].join("\n");
}

export function appendTranscriptAnnotationsToPrompt(
  prompt: string,
  annotations: ReadonlyArray<TranscriptAnnotationContext>,
): string {
  if (annotations.length === 0) return prompt;
  const blocks = annotations.map(formatTranscriptAnnotation);
  const trimmedPrompt = prompt.trim();
  return trimmedPrompt ? `${trimmedPrompt}\n\n${blocks.join("\n\n")}` : blocks.join("\n\n");
}

export function parseTranscriptAnnotationMessageSegments(
  value: string,
): ReadonlyArray<TranscriptAnnotationMessageSegment> {
  const segments: TranscriptAnnotationMessageSegment[] = [];
  let cursor = 0;

  for (const match of value.matchAll(TRANSCRIPT_ANNOTATION_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({
        kind: "text",
        id: `transcript-text:${cursor}`,
        text: value.slice(cursor, index),
      });
    }
    const attributes = parseAttributes(match[1] ?? "");
    const role =
      attributes.role === "user" ? "user" : attributes.role === "assistant" ? "assistant" : null;
    const selectedText = (match[3] ?? "").trim();
    if (attributes.id && attributes.messageId && role && selectedText) {
      segments.push({
        kind: "transcript-annotation",
        annotation: {
          id: attributes.id,
          messageId: attributes.messageId,
          role,
          comment: (match[2] ?? "").trim(),
          selectedText,
        },
      });
    } else {
      segments.push({ kind: "text", id: `transcript-invalid:${index}`, text: match[0] });
    }
    cursor = index + match[0].length;
  }

  if (cursor < value.length) {
    segments.push({ kind: "text", id: `transcript-text:${cursor}`, text: value.slice(cursor) });
  }
  return segments;
}
