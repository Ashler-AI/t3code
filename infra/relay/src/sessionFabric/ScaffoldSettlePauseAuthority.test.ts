import { describe, expect, it, vi } from "vitest";

import {
  pauseSettledScaffoldSession,
  validateScaffoldSettlePauseAuthorityConfig,
} from "./ScaffoldSettlePauseAuthority.ts";

const request = {
  fabricSessionId: "sf:pre-migration-environment:thread-1",
  settlementEventId: "event-1",
  environmentId: "post-migration-environment",
  threadId: "thread-1",
  scaffoldSessionId: "scaffold-1",
  expectedLifecycleEpoch: 7,
};

const config = () =>
  validateScaffoldSettlePauseAuthorityConfig({
    endpoint: "https://scaffold.example/api/session-fabric/settle-pause",
    sharedSecret: "shared-secret",
  })!;

describe("ScaffoldSettlePauseAuthority", () => {
  it("sends a migrated fabric ID with its current identity binding and accepts only E+1", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        version: 1,
        ...request,
      });
      return Response.json({
        ok: true,
        version: 1,
        ...request,
        targetLifecycleEpoch: 8,
        outcome: "paused",
        deduplicated: false,
      });
    });
    await expect(pauseSettledScaffoldSession(config(), request, { fetch })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("rejects a stale or skipped lifecycle response", async () => {
    for (const targetLifecycleEpoch of [7, 9]) {
      await expect(
        pauseSettledScaffoldSession(config(), request, {
          fetch: vi.fn(async () =>
            Response.json({
              ok: true,
              version: 1,
              ...request,
              targetLifecycleEpoch,
              outcome: "paused",
              deduplicated: false,
            }),
          ),
        }),
      ).resolves.toMatchObject({ ok: false, code: "response_mismatch" });
    }
  });

  it.each(["environmentId", "threadId"] as const)(
    "rejects a response with a mismatched %s binding",
    async (field) => {
      await expect(
        pauseSettledScaffoldSession(config(), request, {
          fetch: vi.fn(async () =>
            Response.json({
              ok: true,
              version: 1,
              ...request,
              [field]: `different-${request[field]}`,
              targetLifecycleEpoch: 8,
              outcome: "paused",
              deduplicated: false,
            }),
          ),
        }),
      ).resolves.toMatchObject({ ok: false, code: "response_mismatch" });
    },
  );
});
