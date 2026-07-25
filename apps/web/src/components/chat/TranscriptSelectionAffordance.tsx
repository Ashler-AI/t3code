import { CheckIcon, CopyIcon, MessageCircleIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { TranscriptAnnotationContext } from "~/transcriptAnnotation";
import { cn, randomUUID } from "~/lib/utils";

interface TranscriptSelection {
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly range: Range;
  readonly left: number;
  readonly top: number;
}

export function shouldConfirmTranscriptAnnotation(
  event: Pick<
    ReactKeyboardEvent<HTMLTextAreaElement>,
    "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
  >,
): boolean {
  return (
    event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
  );
}

function readTranscriptSelection(root: HTMLElement): TranscriptSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const startElement =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const endElement =
    range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  if (!startElement || !endElement || !root.contains(startElement) || !root.contains(endElement)) {
    return null;
  }
  const startRow = startElement.closest<HTMLElement>("[data-message-id][data-message-role]");
  const endRow = endElement.closest<HTMLElement>("[data-message-id][data-message-role]");
  if (!startRow || startRow !== endRow) return null;
  const role = startRow.dataset.messageRole;
  const messageId = startRow.dataset.messageId;
  const text = selection.toString().trim();
  if (!messageId || (role !== "user" && role !== "assistant") || !text) return null;

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    messageId,
    role,
    text,
    range: range.cloneRange(),
    left: Math.max(12, Math.min(window.innerWidth - 12, rect.left + rect.width / 2)),
    top: Math.max(12, rect.top - 8),
  };
}

function restoreSelection(selection: TranscriptSelection | null) {
  if (!selection) return;
  const browserSelection = window.getSelection();
  browserSelection?.removeAllRanges();
  browserSelection?.addRange(selection.range);
}

export function TranscriptSelectionAffordance(props: {
  rootRef: RefObject<HTMLDivElement | null>;
  onAnnotate: (annotation: TranscriptAnnotationContext) => void;
}) {
  const [selection, setSelection] = useState<TranscriptSelection | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [comment, setComment] = useState("");
  const [copied, setCopied] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const refreshSelection = useCallback(() => {
    const root = props.rootRef.current;
    if (!root) return;
    const next = readTranscriptSelection(root);
    if (next) {
      setSelection(next);
      setAnnotating(false);
      setComment("");
      setCopied(false);
    }
  }, [props.rootRef]);

  useEffect(() => {
    const root = props.rootRef.current;
    if (!root) return;
    const scheduleRefresh = () => window.requestAnimationFrame(refreshSelection);
    root.addEventListener("pointerup", scheduleRefresh);
    root.addEventListener("keyup", scheduleRefresh);
    return () => {
      root.removeEventListener("pointerup", scheduleRefresh);
      root.removeEventListener("keyup", scheduleRefresh);
    };
  }, [props.rootRef, refreshSelection]);

  useEffect(() => {
    if (!selection) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-transcript-selection-ui]")) return;
      window.requestAnimationFrame(() => {
        if (window.getSelection()?.isCollapsed !== false) setSelection(null);
      });
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [selection]);

  if (!selection) return null;

  const confirm = () => {
    props.onAnnotate({
      id: randomUUID(),
      messageId: selection.messageId,
      role: selection.role,
      selectedText: selection.text,
      comment: comment.trim(),
    });
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  return createPortal(
    <div
      data-transcript-selection-ui
      className="fixed z-[90] -translate-x-1/2 -translate-y-full"
      style={{ left: selection.left, top: selection.top }}
    >
      <div className="mb-1 flex items-center gap-1 rounded-lg border border-border/80 bg-popover p-1 text-popover-foreground shadow-lg">
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-accent"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            void navigator.clipboard
              .writeText(selection.text)
              .then(() => setCopied(true))
              .catch(() => undefined)
              .finally(() => restoreSelection(selection));
          }}
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-accent",
            annotating && "bg-accent",
          )}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            setAnnotating(true);
            restoreSelection(selection);
          }}
        >
          <MessageCircleIcon className="size-3.5" />
          Annotate
        </button>
        <button
          type="button"
          aria-label="Close selection actions"
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setSelection(null)}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      {annotating ? (
        <div className="w-80 rounded-xl border border-border/80 bg-popover p-2 shadow-xl">
          <textarea
            ref={editorRef}
            value={comment}
            rows={3}
            aria-label="Annotation comment"
            placeholder="Add a comment…"
            className="w-full resize-none rounded-md border border-border/70 bg-background px-2.5 py-2 text-sm outline-none focus:border-ring"
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (!shouldConfirmTranscriptAnnotation(event)) return;
              event.preventDefault();
              confirm();
            }}
          />
          <div className="mt-1.5 flex items-center justify-between gap-3 px-0.5">
            <span className="text-[11px] text-muted-foreground">
              Enter to add · Shift-Enter for newline
            </span>
            <button
              type="button"
              className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:bg-primary/90"
              onClick={confirm}
            >
              Add annotation
            </button>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
