import type {
  ClientOrchestrationCommand,
  OrchestrationSession,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeShellInput,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadShell,
  OrchestrationThreadStreamItem,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Stream from "effect/Stream";

import type { PreparedConnection } from "../connection/model.ts";
import type { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type {
  EnvironmentRpcFailure,
  EnvironmentRpcStreamFailure,
  EnvironmentRpcSuccess,
  EnvironmentRpcUnavailableError,
} from "../rpc/client.ts";
type DispatchTag = typeof ORCHESTRATION_WS_METHODS.dispatchCommand;
type ShellTag = typeof ORCHESTRATION_WS_METHODS.subscribeShell;
type ThreadTag = typeof ORCHESTRATION_WS_METHODS.subscribeThread;

export interface UiSessionSourceCapabilities {
  readonly shellResumeCompletionMarker: boolean;
  readonly threadResumeCompletionMarker: boolean;
}

export interface UiSessionSourceSubscriptionOptions<E> {
  readonly onExpectedFailure?: (cause: Cause.Cause<E>) => Effect.Effect<void>;
  readonly retryExpectedFailureAfter?: Duration.Input;
  readonly resubscribe?: Stream.Stream<unknown>;
}

export interface UiSessionListing {
  readonly thread: OrchestrationThreadShell;
  readonly session: OrchestrationSession;
}

export interface UiSessionSourceShape {
  readonly authoritativeShellSnapshot: (
    prepared: PreparedConnection,
  ) => Effect.Effect<Option.Option<OrchestrationShellSnapshot>>;
  readonly authoritativeThreadSnapshot: (
    prepared: PreparedConnection,
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>>;
  readonly subscribeShell: <R>(
    makeInput: (
      capabilities: UiSessionSourceCapabilities,
    ) => Effect.Effect<OrchestrationSubscribeShellInput, never, R>,
    options?: UiSessionSourceSubscriptionOptions<EnvironmentRpcStreamFailure<ShellTag>>,
  ) => Stream.Stream<
    OrchestrationShellStreamItem,
    EnvironmentRpcStreamFailure<ShellTag>,
    EnvironmentSupervisor | R
  >;
  readonly subscribeThread: <R>(
    makeInput: (
      capabilities: UiSessionSourceCapabilities,
    ) => Effect.Effect<OrchestrationSubscribeThreadInput, never, R>,
    options?: UiSessionSourceSubscriptionOptions<EnvironmentRpcStreamFailure<ThreadTag>>,
  ) => Stream.Stream<
    OrchestrationThreadStreamItem,
    EnvironmentRpcStreamFailure<ThreadTag>,
    EnvironmentSupervisor | R
  >;
  readonly dispatch: (
    command: ClientOrchestrationCommand,
  ) => Effect.Effect<
    EnvironmentRpcSuccess<DispatchTag>,
    EnvironmentRpcFailure<DispatchTag> | EnvironmentRpcUnavailableError,
    EnvironmentSupervisor
  >;
  readonly listThreads: (
    prepared: PreparedConnection,
  ) => Effect.Effect<Option.Option<ReadonlyArray<OrchestrationThreadShell>>>;
  readonly listSessions: (
    prepared: PreparedConnection,
  ) => Effect.Effect<Option.Option<ReadonlyArray<UiSessionListing>>>;
}

export class UiSessionSource extends Context.Service<UiSessionSource, UiSessionSourceShape>()(
  "@t3tools/client-runtime/session-source/source/UiSessionSource",
) {}
