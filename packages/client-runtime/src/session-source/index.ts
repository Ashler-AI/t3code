import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ShellSnapshotLoader } from "../state/shellSnapshotHttp.ts";
import { ThreadSnapshotLoader } from "../state/threadSnapshotHttp.ts";
import { makeDirectEnvironmentUiSessionSource } from "./directEnvironment.ts";
import { makeRelaySessionFabricUiSessionSource } from "./relaySessionFabric.ts";
import { UiSessionSource } from "./source.ts";

export const resolveUiSessionSource = Effect.gen(function* () {
  const injected = yield* Effect.serviceOption(UiSessionSource);
  if (Option.isSome(injected)) {
    return injected.value;
  }

  const supervisor = yield* Effect.serviceOption(EnvironmentSupervisor);
  if (
    Option.isSome(supervisor) &&
    supervisor.value.target._tag === "SessionFabricConnectionTarget"
  ) {
    const target = supervisor.value.target;
    return makeRelaySessionFabricUiSessionSource({
      relayBaseUrl: target.relayBaseUrl,
      sessionId: target.sessionId,
      clientId: target.clientId,
      environmentId: target.environmentId,
      environmentLabel: target.label,
    });
  }

  const shellSnapshotLoader = yield* Effect.serviceOption(ShellSnapshotLoader);
  const threadSnapshotLoader = yield* Effect.serviceOption(ThreadSnapshotLoader);
  return makeDirectEnvironmentUiSessionSource({
    shellSnapshotLoader: Option.getOrElse(shellSnapshotLoader, () =>
      ShellSnapshotLoader.of({ load: () => Effect.succeed(Option.none()) }),
    ),
    threadSnapshotLoader: Option.getOrElse(threadSnapshotLoader, () =>
      ThreadSnapshotLoader.of({ load: () => Effect.succeed(Option.none()) }),
    ),
  });
});

export * from "./directEnvironment.ts";
export * from "./relaySessionFabric.ts";
export * from "./sessionFabricDirectory.ts";
export * from "./source.ts";
