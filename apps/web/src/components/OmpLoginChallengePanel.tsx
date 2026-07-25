"use client";

import type { OmpLoginChallenge } from "@t3tools/contracts";
import { ExternalLinkIcon, KeyRoundIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { normalizeOmpLoginChallengeResponse, providerDisplayName } from "./OmpAccountPalette.logic";

export function OmpLoginChallengePanel(props: {
  readonly challenge: OmpLoginChallenge | null;
  readonly authorizationUrl?: string | null;
  readonly onSubmit: (response: string) => void;
  readonly onCancel: () => void;
}) {
  const { authorizationUrl = null, challenge, onCancel, onSubmit } = props;
  const [response, setResponse] = useState("");

  if (challenge === null) return null;

  const provider = providerDisplayName(challenge.provider);
  const normalizedResponse = normalizeOmpLoginChallengeResponse(response);
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (normalizedResponse !== null) onSubmit(normalizedResponse);
  };

  return (
    <aside
      aria-label={`Finish adding ${provider}`}
      aria-modal="false"
      className="fixed right-4 bottom-4 z-[60] w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border/80 bg-popover text-popover-foreground shadow-xl"
      role="dialog"
    >
      <form onSubmit={handleSubmit}>
        <div className="flex items-start gap-3 border-b border-border/70 px-4 py-3.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/60">
            <KeyRoundIcon aria-hidden className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 space-y-1">
            <h2 className="font-heading font-semibold text-base">Finish adding {provider}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {challenge.prompt ??
                challenge.message ??
                "Paste the redirect URL or authorization code."}
            </p>
          </div>
        </div>
        <div className="space-y-3 px-4 py-4">
          {authorizationUrl !== null ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/35 px-3 py-2.5">
              <p className="text-sm text-muted-foreground">Sign-in page didn’t open?</p>
              <Button
                render={<a href={authorizationUrl} rel="noopener noreferrer" target="_blank" />}
                size="sm"
                variant="outline"
              >
                <ExternalLinkIcon aria-hidden />
                Open sign-in
              </Button>
            </div>
          ) : null}
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Redirect URL or code</span>
            <Input
              autoFocus
              nativeInput
              autoComplete="off"
              value={response}
              onChange={(event) => setResponse(event.currentTarget.value)}
              placeholder="Paste redirect URL or code"
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button disabled={normalizedResponse === null} type="submit">
              Continue
            </Button>
          </div>
        </div>
      </form>
    </aside>
  );
}
