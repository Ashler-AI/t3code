import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  CODEX_PROVIDER_PROBE_TIMEOUT_MS,
  CODEX_STALE_CATALOG_MESSAGE,
  mapCodexModelCapabilities,
  type CodexAppServerProviderSnapshot,
} from "./CodexProvider.ts";

const testCodexSettings = Schema.decodeSync(CodexSettings)({});

const testCodexProbeSnapshot: CodexAppServerProviderSnapshot = {
  account: {
    account: {
      type: "chatgpt",
      email: "test@example.com",
      planType: "pro",
    },
    requiresOpenaiAuth: false,
  },
  version: "0.145.0",
  models: [
    {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6-Sol",
      isCustom: false,
      capabilities: null,
    },
  ],
  skills: [],
};

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("uses a bounded cold-start deadline for Codex app-server discovery", () => {
  assert.strictEqual(CODEX_PROVIDER_PROBE_TIMEOUT_MS, 30_000);
});

it.effect(
  "recovers after a delayed first probe and keeps the verified catalog across a later timeout",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const finalized = yield* Ref.make(0);
      const probe = () =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.flatMap((call) =>
            call === 2
              ? Effect.succeed(testCodexProbeSnapshot)
              : Effect.acquireRelease(Effect.void, () =>
                  Ref.update(finalized, (count) => count + 1),
                ).pipe(Effect.flatMap(() => Effect.never)),
          ),
        );

      const firstFiber = yield* checkCodexProviderStatus(testCodexSettings, probe).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("31 seconds");
      const first = yield* Fiber.join(firstFiber);
      assert.strictEqual(first.status, "error");
      assert.strictEqual(yield* Ref.get(finalized), 1);

      const recovered = yield* checkCodexProviderStatus(testCodexSettings, probe);
      assert.strictEqual(recovered.status, "ready");
      assert.deepStrictEqual(recovered.models, testCodexProbeSnapshot.models);

      const staleFiber = yield* checkCodexProviderStatus(
        testCodexSettings,
        probe,
        undefined,
        recovered,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("31 seconds");
      const stale = yield* Fiber.join(staleFiber);
      assert.strictEqual(stale.status, "ready");
      assert.deepStrictEqual(stale.models, recovered.models);
      assert.strictEqual(stale.auth.status, "authenticated");
      assert.strictEqual(
        stale.message,
        "Codex CLI status refresh could not complete. Using the last verified account and model catalog.",
      );
      assert.strictEqual(yield* Ref.get(finalized), 2);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("custom probe must not spawn a child process")),
      ),
    ),
);

it.effect("retries one cold SQLite contention exit before publishing Codex as unavailable", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const probe = () =>
      Ref.updateAndGet(calls, (count) => count + 1).pipe(
        Effect.flatMap((call) =>
          call === 1
            ? Effect.fail(
                new CodexErrors.CodexAppServerProcessExitedError({
                  code: 1,
                  pid: 123,
                  reason: "sqlite-contention",
                }),
              )
            : Effect.succeed(testCodexProbeSnapshot),
        ),
      );

    const recovered = yield* checkCodexProviderStatus(testCodexSettings, probe);

    assert.strictEqual(yield* Ref.get(calls), 2);
    assert.strictEqual(recovered.status, "ready");
    assert.deepStrictEqual(recovered.models, testCodexProbeSnapshot.models);
  }).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("custom probe must not spawn a child process")),
    ),
  ),
);

it.effect("keeps the last verified Codex catalog across later SQLite contention", () =>
  Effect.gen(function* () {
    const verified = yield* checkCodexProviderStatus(testCodexSettings, () =>
      Effect.succeed(testCodexProbeSnapshot),
    );
    const calls = yield* Ref.make(0);
    const stale = yield* checkCodexProviderStatus(
      testCodexSettings,
      () =>
        Ref.update(calls, (count) => count + 1).pipe(
          Effect.andThen(
            Effect.fail(
              new CodexErrors.CodexAppServerProcessExitedError({
                code: 1,
                pid: 456,
                reason: "sqlite-contention",
              }),
            ),
          ),
        ),
      undefined,
      verified,
    );

    assert.strictEqual(yield* Ref.get(calls), 1);
    assert.strictEqual(stale.status, "ready");
    assert.deepStrictEqual(stale.models, verified.models);
    assert.strictEqual(stale.auth.status, "authenticated");
    assert.strictEqual(stale.message, CODEX_STALE_CATALOG_MESSAGE);
  }).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("custom probe must not spawn a child process")),
    ),
  ),
);

it.effect("publishes an unavailable provider after a non-lock process exit", () =>
  Effect.gen(function* () {
    const verified = yield* checkCodexProviderStatus(testCodexSettings, () =>
      Effect.succeed(testCodexProbeSnapshot),
    );
    const calls = yield* Ref.make(0);
    const unavailable = yield* checkCodexProviderStatus(
      testCodexSettings,
      () =>
        Ref.update(calls, (count) => count + 1).pipe(
          Effect.andThen(
            Effect.fail(new CodexErrors.CodexAppServerProcessExitedError({ code: 78, pid: 789 })),
          ),
        ),
      undefined,
      verified,
    );

    assert.strictEqual(yield* Ref.get(calls), 1);
    assert.strictEqual(unavailable.status, "error");
    assert.deepStrictEqual(unavailable.models, []);
    assert.include(unavailable.message, "exited with code 78");
  }).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("custom probe must not spawn a child process")),
    ),
  ),
);

it.effect("replaces a verified Codex snapshot on explicit logout", () =>
  Effect.gen(function* () {
    const verified = yield* checkCodexProviderStatus(testCodexSettings, () =>
      Effect.succeed(testCodexProbeSnapshot),
    );
    const loggedOut = yield* checkCodexProviderStatus(
      testCodexSettings,
      () =>
        Effect.succeed({
          ...testCodexProbeSnapshot,
          account: { account: null, requiresOpenaiAuth: true },
          models: [],
        }),
      undefined,
      verified,
    );

    assert.strictEqual(loggedOut.status, "error");
    assert.strictEqual(loggedOut.auth.status, "unauthenticated");
    assert.deepStrictEqual(loggedOut.models, []);
  }).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("custom probe must not spawn a child process")),
    ),
  ),
);
