import { EnvironmentId, OmpAccountRef, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getOmpAccountAssignmentPresentation, shouldShowOpenInPicker } from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });
});

describe("OMP account assignment presentation", () => {
  it("shows only the masked account identity with a friendly balancing reason", () => {
    expect(
      getOmpAccountAssignmentPresentation({
        threadId: ThreadId.make("thread-visible"),
        automatic: true,
        reassignmentReason: "load-balanced",
        account: {
          accountRef: OmpAccountRef.make("opaque-account-ref"),
          provider: "anthropic-claude",
          authKind: "oauth",
          displayName: "Claude Max",
          maskedEmail: "cz***en@ashler.ai",
          organization: "Ashler",
          state: "available",
          managed: false,
        },
      }),
    ).toEqual({
      label: "Claude · cz***en@ashler.ai",
      detail: "Automatically assigned to balance usage across accounts.",
    });
  });

  it.each([
    ["quota-exhausted", "Switched accounts because the previous account reached its quota."],
    ["account-unavailable", "Switched accounts because the previous account became unavailable."],
  ] as const)("explains %s failover without exposing raw provider details", (reason, detail) => {
    const presentation = getOmpAccountAssignmentPresentation({
      threadId: ThreadId.make("thread-visible"),
      automatic: true,
      reassignmentReason: reason,
      account: {
        accountRef: OmpAccountRef.make("opaque-account-ref"),
        provider: "openai-codex",
        authKind: "managed",
        displayName: "Team ChatGPT",
        maskedEmail: "zh***er@gmail.com",
        state: "available",
        managed: true,
      },
    });

    expect(presentation).toEqual({
      label: "ChatGPT · zh***er@gmail.com",
      detail,
    });
    expect(JSON.stringify(presentation)).not.toContain("thread-visible");
    expect(JSON.stringify(presentation)).not.toContain("opaque-account-ref");
  });

  it("keeps a sticky assignment visible when no reassignment reason is present", () => {
    expect(
      getOmpAccountAssignmentPresentation({
        threadId: ThreadId.make("thread-sticky"),
        automatic: true,
        account: {
          accountRef: OmpAccountRef.make("opaque-sticky-ref"),
          provider: "anthropic-claude",
          authKind: "oauth",
          displayName: "Claude Max",
          maskedEmail: "cz***en@ashler.ai",
          state: "available",
          managed: false,
        },
      }),
    ).toEqual({
      label: "Claude · cz***en@ashler.ai",
      detail: "Assigned to this session.",
    });
  });

  it("hides unassigned sessions", () => {
    expect(
      getOmpAccountAssignmentPresentation({
        threadId: ThreadId.make("thread-visible"),
        automatic: true,
        account: null,
      }),
    ).toBeNull();
    expect(getOmpAccountAssignmentPresentation(null)).toBeNull();
  });
});
