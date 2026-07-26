import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "effect/unstable/cli";

import type { CliServerFlags } from "./config.ts";
import { makeServeCommand } from "./server.ts";

it.layer(NodeServices.layer)("serve command", (it) => {
  it.effect("forwards an explicit auto-bootstrap opt-in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let observedFlags: CliServerFlags | undefined;
        let observedOptions:
          | {
              readonly startupPresentation?: "browser" | "headless";
              readonly forceAutoBootstrapProjectFromCwd?: boolean;
            }
          | undefined;
        const command = makeServeCommand((flags, options) =>
          Effect.sync(() => {
            observedFlags = flags;
            observedOptions = options;
          }),
        );

        yield* Command.runWith(command, { version: "0.0.0" })([
          "--auto-bootstrap-project-from-cwd",
        ]);

        assert.isDefined(observedFlags);
        assert.isTrue(Option.getOrUndefined(observedFlags.autoBootstrapProjectFromCwd));
        assert.deepEqual(observedOptions, {
          startupPresentation: "headless",
          forceAutoBootstrapProjectFromCwd: false,
        });
      }),
    ),
  );
});
