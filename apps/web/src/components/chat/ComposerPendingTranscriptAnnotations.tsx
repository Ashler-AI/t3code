import { MessageCircleIcon, XIcon } from "lucide-react";

import type { TranscriptAnnotationContext } from "~/transcriptAnnotation";
import { cn } from "~/lib/utils";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ComposerPendingTranscriptAnnotations(props: {
  annotations: ReadonlyArray<TranscriptAnnotationContext>;
  onRemove: (annotationId: string) => void;
  className?: string;
}) {
  if (props.annotations.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", props.className)}>
      {props.annotations.map((annotation) => {
        const label = `${annotation.role === "assistant" ? "Agent" : "You"}: ${annotation.selectedText}`;
        return (
          <Tooltip key={annotation.id}>
            <TooltipTrigger
              render={
                <span className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "max-w-72 pr-1")}>
                  <MessageCircleIcon
                    className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "size-3.5")}
                  />
                  <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
                  <button
                    type="button"
                    aria-label="Remove transcript annotation"
                    className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      props.onRemove(annotation.id);
                    }}
                  >
                    <XIcon className="size-3" aria-hidden />
                  </button>
                </span>
              }
            />
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
              {annotation.comment
                ? `${annotation.comment}\n\n${annotation.selectedText}`
                : annotation.selectedText}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
