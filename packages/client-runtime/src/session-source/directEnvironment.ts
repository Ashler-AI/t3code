import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { request, subscribeDynamic } from "../rpc/client.ts";
import type { ShellSnapshotLoader } from "../state/shellSnapshotHttp.ts";
import type { ThreadSnapshotLoader } from "../state/threadSnapshotHttp.ts";
import {
  UiSessionSource,
  type UiSessionSourceCapabilities,
  type UiSessionSourceShape,
} from "./source.ts";

const capabilitiesFromConfig = (config: {
  readonly shellResumeCompletionMarker?: boolean;
  readonly threadResumeCompletionMarker?: boolean;
}): UiSessionSourceCapabilities => ({
  shellResumeCompletionMarker: config.shellResumeCompletionMarker === true,
  threadResumeCompletionMarker: config.threadResumeCompletionMarker === true,
});

export function makeDirectEnvironmentUiSessionSource(input: {
  readonly shellSnapshotLoader: ShellSnapshotLoader["Service"];
  readonly threadSnapshotLoader: ThreadSnapshotLoader["Service"];
}): UiSessionSourceShape {
  return UiSessionSource.of({
    authoritativeShellSnapshot: (prepared) => input.shellSnapshotLoader.load(prepared),
    authoritativeThreadSnapshot: (prepared, threadId) =>
      input.threadSnapshotLoader.load(prepared, threadId),
    subscribeShell: (makeInput, options) =>
      subscribeDynamic(
        ORCHESTRATION_WS_METHODS.subscribeShell,
        (session) =>
          session.initialConfig.pipe(
            Effect.map(capabilitiesFromConfig),
            Effect.orElseSucceed(() => capabilitiesFromConfig({})),
            Effect.flatMap(makeInput),
          ),
        options,
      ),
    subscribeThread: (makeInput, options) =>
      subscribeDynamic(
        ORCHESTRATION_WS_METHODS.subscribeThread,
        (session) =>
          session.initialConfig.pipe(
            Effect.map(capabilitiesFromConfig),
            Effect.orElseSucceed(() => capabilitiesFromConfig({})),
            Effect.flatMap(makeInput),
          ),
        options,
      ),
    dispatch: (command) => request(ORCHESTRATION_WS_METHODS.dispatchCommand, command),
    listThreads: (prepared) =>
      input.shellSnapshotLoader
        .load(prepared)
        .pipe(Effect.map(Option.map((snapshot) => snapshot.threads))),
    listSessions: (prepared) =>
      input.shellSnapshotLoader
        .load(prepared)
        .pipe(
          Effect.map(
            Option.map((snapshot) =>
              snapshot.threads.flatMap((thread) =>
                thread.session === null ? [] : [{ thread, session: thread.session }],
              ),
            ),
          ),
        ),
  });
}
