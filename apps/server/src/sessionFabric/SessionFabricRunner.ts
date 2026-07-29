import type {
  ClientOrchestrationCommand,
  EnvironmentId,
  IsoDateTime,
  OrchestrationEvent,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadShell,
  ScaffoldDeployment,
  SessionFabricClientFrame,
  SessionFabricCapabilityGrant,
  SessionFabricCommand,
  SessionFabricCommandReceipt,
  SessionFabricContextPublication,
  SessionFabricEnvironmentKind,
  SessionFabricExecutionLocation,
  SessionFabricPublishedEvent,
  SessionFabricServerFrame,
  SessionFabricSessionId,
  SessionFabricSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import {
  SESSION_FABRIC_PROTOCOL_VERSION,
  SessionFabricCapabilityGrant as SessionFabricCapabilityGrantSchema,
  SessionFabricClientFrame as SessionFabricClientFrameSchema,
  SessionFabricRunnerId,
  SessionFabricServerFrame as SessionFabricServerFrameSchema,
  SessionFabricSessionId as SessionFabricSessionIdSchema,
} from "@t3tools/contracts/session-fabric";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import { recordSessionFabricRunnerState } from "../observability/Metrics.ts";
import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import { requestScaffoldRunnerCapability } from "../scaffold/ScaffoldControlPlaneClient.ts";
import { resolveScaffoldTarget } from "../scaffold/ScaffoldConfig.ts";

const SessionFabricRunnerEnvConfig = Config.all({
  relayUrl: Config.url("T3CODE_SESSION_FABRIC_RELAY_URL").pipe(Config.option),
  environmentKind: Config.literals(
    ["local", "scaffold"],
    "T3CODE_SESSION_FABRIC_ENVIRONMENT_KIND",
  ).pipe(Config.option),
  publication: Config.literals(["public", "local_only"], "T3CODE_SESSION_FABRIC_PUBLICATION").pipe(
    Config.withDefault("public"),
  ),
  runnerGeneration: Config.int("T3CODE_SESSION_FABRIC_RUNNER_GENERATION").pipe(
    Config.withDefault(0),
  ),
  overrideSessionId: Config.string("T3CODE_SESSION_FABRIC_SESSION_ID").pipe(Config.option),
  overrideThreadId: Config.string("T3CODE_SESSION_FABRIC_THREAD_ID").pipe(Config.option),
  scaffoldSessionId: Config.string("SCAFFOLD_SESSION_ID").pipe(Config.option),
  scaffoldSessionUrl: Config.string("SCAFFOLD_SESSION_URL").pipe(Config.option),
  scaffoldCapabilityBaseUrl: Config.url("T3CODE_SESSION_FABRIC_CAPABILITY_BASE_URL").pipe(
    Config.option,
  ),
  scaffoldLifecycleEpoch: Config.int("SCAFFOLD_LIFECYCLE_EPOCH").pipe(Config.option),
  runtimeApiToken: Config.string("SCAFFOLD_RUNTIME_API_TOKEN").pipe(Config.option),
  authMode: Config.literals(["required", "disabled"], "T3CODE_SESSION_FABRIC_AUTH_MODE").pipe(
    Config.withDefault("required"),
  ),
  capabilityDeployment: Config.literals(
    ["staging", "production"],
    "T3CODE_SESSION_FABRIC_CAPABILITY_DEPLOYMENT",
  ).pipe(Config.option),
  scaffoldDefaultDeployment: Config.literals(
    ["staging", "production"],
    "T3CODE_SCAFFOLD_DEFAULT_DEPLOYMENT",
  ).pipe(Config.option),
});

export interface SessionFabricRunnerConfig {
  readonly relayUrl: URL | null;
  readonly environmentKind: SessionFabricEnvironmentKind;
  readonly publication: "public" | "local_only";
  readonly runnerGeneration: number;
  readonly overrideSessionId: SessionFabricSessionId | null;
  readonly overrideThreadId: ThreadId | null;
  readonly scaffoldSessionId: string | null;
  readonly scaffoldSessionUrl: string | null;
  readonly scaffoldCapabilityBaseUrl: URL | null;
  readonly scaffoldLifecycleEpoch: number | null;
  readonly runtimeApiToken: string | null;
  readonly authMode: "required" | "disabled";
  readonly capabilityDeployment: ScaffoldDeployment | null;
}

interface SessionFabricRunnerSession {
  readonly threadId: ThreadId;
  readonly sessionId: SessionFabricSessionId;
  readonly events: Queue.Queue<OrchestrationEvent>;
}

const encodeClientFrame = Schema.encodeSync(Schema.fromJsonString(SessionFabricClientFrameSchema));
const decodeServerFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SessionFabricServerFrameSchema),
);

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const optionValue = <A>(value: Option.Option<A>): A | null =>
  Option.isSome(value) ? value.value : null;

function normalizeScaffoldCapabilityBaseUrl(value: URL | null): URL | null {
  if (value === null) return null;
  if (
    (value.protocol !== "https:" && value.protocol !== "http:") ||
    value.username.length > 0 ||
    value.password.length > 0 ||
    value.pathname !== "/" ||
    value.search.length > 0 ||
    value.hash.length > 0
  ) {
    throw new Error("Scaffold session fabric capability base URL must be an HTTP origin.");
  }
  return new URL(value.origin);
}

export function resolveSessionFabricRunnerConfig(
  config: Config.Success<typeof SessionFabricRunnerEnvConfig>,
): SessionFabricRunnerConfig {
  const scaffoldSessionId = optionValue(config.scaffoldSessionId);
  const configuredEnvironmentKind = optionValue(config.environmentKind);
  const overrideSessionId = optionValue(config.overrideSessionId);
  const overrideThreadId = optionValue(config.overrideThreadId);
  const environmentKind =
    configuredEnvironmentKind ?? (scaffoldSessionId === null ? "local" : "scaffold");
  if (config.authMode === "disabled" && environmentKind !== "local") {
    throw new Error("Session fabric authentication can only be disabled for a local runner.");
  }
  const scaffoldLifecycleEpoch = optionValue(config.scaffoldLifecycleEpoch);
  if (scaffoldLifecycleEpoch !== null && scaffoldLifecycleEpoch < 0) {
    throw new Error("Scaffold lifecycle epoch must be non-negative.");
  }
  const scaffoldSessionUrl = optionValue(config.scaffoldSessionUrl);
  const scaffoldCapabilityBaseUrl = normalizeScaffoldCapabilityBaseUrl(
    optionValue(config.scaffoldCapabilityBaseUrl),
  );
  const runtimeApiToken = optionValue(config.runtimeApiToken);
  if (environmentKind === "scaffold" && scaffoldCapabilityBaseUrl === null) {
    throw new Error("A Scaffold session fabric runner requires a capability base URL.");
  }
  if (
    environmentKind === "local" &&
    (scaffoldSessionId !== null ||
      scaffoldSessionUrl !== null ||
      scaffoldCapabilityBaseUrl !== null ||
      scaffoldLifecycleEpoch !== null ||
      runtimeApiToken !== null)
  ) {
    throw new Error("A local session fabric runner cannot include Scaffold runtime bindings.");
  }
  return {
    relayUrl: optionValue(config.relayUrl),
    environmentKind,
    publication: config.publication,
    runnerGeneration: Math.max(0, config.runnerGeneration),
    overrideSessionId:
      overrideSessionId === null ? null : SessionFabricSessionIdSchema.make(overrideSessionId),
    overrideThreadId: overrideThreadId === null ? null : (overrideThreadId as ThreadId),
    scaffoldSessionId,
    scaffoldSessionUrl,
    scaffoldCapabilityBaseUrl,
    scaffoldLifecycleEpoch,
    runtimeApiToken,
    authMode: config.authMode,
    capabilityDeployment:
      optionValue(config.capabilityDeployment) ?? optionValue(config.scaffoldDefaultDeployment),
  };
}

const decodeCapabilityGrant = Schema.decodeUnknownSync(SessionFabricCapabilityGrantSchema);
const LOCAL_RUNNER_SCOPES = ["session:publish", "session:execute"] as const;

export async function requestLocalSessionFabricRunnerCapability(input: {
  readonly deployment: ScaffoldDeployment;
  readonly fabricSessionId: SessionFabricSessionId;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runnerId: typeof SessionFabricRunnerId.Type;
  readonly fetch?: typeof globalThis.fetch;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly target?: {
    readonly baseUrl: string;
    readonly authorization: string;
    readonly authMode: "oauth" | "iap";
  };
}): Promise<SessionFabricCapabilityGrant> {
  const target =
    input.target ?? resolveScaffoldTarget(input.deployment, input.environment ?? process.env);
  if (target.authMode !== "oauth") {
    throw new Error("Local session fabric capabilities require Scaffold OAuth.");
  }
  const response = await (input.fetch ?? globalThis.fetch.bind(globalThis))(
    new URL("/api/session-fabric/capabilities", target.baseUrl),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: target.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        role: "runner",
        fabricSessionId: input.fabricSessionId,
        environmentKind: "local",
        environmentId: input.environmentId,
        threadId: input.threadId,
        runnerId: input.runnerId,
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
    },
  );
  if (!response.ok) throw new Error(`Scaffold capability request failed (${response.status}).`);
  const grant = decodeCapabilityGrant(await response.json());
  const bindings = grant.bindings;
  if (
    grant.role !== "runner" ||
    grant.scopes.length !== LOCAL_RUNNER_SCOPES.length ||
    !LOCAL_RUNNER_SCOPES.every((scope) => grant.scopes.includes(scope)) ||
    Date.parse(grant.expiresAt) <= (input.now ?? Date.now)() ||
    !("environmentKind" in bindings) ||
    bindings.environmentKind !== "local" ||
    bindings.fabricSessionId !== input.fabricSessionId ||
    bindings.environmentId !== input.environmentId ||
    bindings.threadId !== input.threadId ||
    !("runnerId" in bindings) ||
    bindings.runnerId !== input.runnerId ||
    bindings.actorId.length === 0
  ) {
    throw new Error("Scaffold returned an invalid local session fabric capability.");
  }
  return grant;
}

export async function requestScaffoldSessionFabricRunnerCapability(input: {
  readonly capabilityBaseUrl: URL;
  readonly runtimeApiToken: string;
  readonly scaffoldSessionId: string;
  readonly lifecycleEpoch: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}): Promise<SessionFabricCapabilityGrant> {
  return requestScaffoldRunnerCapability({
    baseUrl: input.capabilityBaseUrl.origin,
    runtimeApiToken: input.runtimeApiToken,
    scaffoldSessionId: input.scaffoldSessionId,
    lifecycleEpoch: input.lifecycleEpoch,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
}

export function resolveSessionFabricSessionId(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly overrideSessionId: SessionFabricSessionId | null;
  readonly overrideThreadId: ThreadId | null;
}): SessionFabricSessionId {
  if (
    input.overrideSessionId !== null &&
    input.overrideThreadId !== null &&
    input.overrideThreadId === input.threadId
  ) {
    return input.overrideSessionId;
  }
  return SessionFabricSessionIdSchema.make(`sf:${input.environmentId}:${input.threadId}`);
}

export function makeSessionFabricWebSocketUrl(
  relayUrl: URL,
  sessionId: SessionFabricSessionId,
): URL | null {
  const url = new URL(relayUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else return null;
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/session-fabric/sessions/${encodeURIComponent(sessionId)}/connect`;
  url.search = "";
  url.hash = "";
  return url;
}

export function makeSessionFabricWebSocketProtocols(
  grant: SessionFabricCapabilityGrant | null,
): ReadonlyArray<string> {
  return grant === null
    ? []
    : ["t3.session-fabric.v1", `t3.session-fabric.capability.${grant.capability}`];
}

export function sessionFabricCapabilityRefreshDelayMs(expiresAt: string, now: number): number {
  return Math.max(0, Date.parse(expiresAt) - now - 30_000);
}

export function orchestrationEventThreadId(event: OrchestrationEvent): ThreadId | null {
  const payload = event.payload as { readonly threadId?: unknown };
  if (typeof payload.threadId === "string") return payload.threadId as ThreadId;
  return event.aggregateKind === "thread" ? (event.aggregateId as ThreadId) : null;
}

function shellForThread(input: {
  readonly shell: OrchestrationShellSnapshot;
  readonly thread: OrchestrationThread;
}): {
  readonly project: OrchestrationProjectShell;
  readonly thread: OrchestrationThreadShell;
  readonly shell: OrchestrationShellSnapshot;
} | null {
  const thread = input.shell.threads.find((candidate) => candidate.id === input.thread.id);
  const project = input.shell.projects.find((candidate) => candidate.id === input.thread.projectId);
  if (thread === undefined || project === undefined) return null;
  return {
    project,
    thread,
    shell: {
      ...input.shell,
      projects: [project],
      threads: [thread],
    },
  };
}

export function buildSessionFabricSnapshot(input: {
  readonly sessionId: SessionFabricSessionId;
  readonly environmentId: EnvironmentId;
  readonly environmentKind: SessionFabricEnvironmentKind;
  readonly scaffoldSessionId: string | null;
  readonly scaffoldSessionUrl: string | null;
  readonly scaffoldLifecycleEpoch: number | null;
  readonly publication: "public" | "local_only";
  readonly acknowledgedEventSequence: number;
  readonly shell: OrchestrationShellSnapshot;
  readonly detail: OrchestrationThreadDetailSnapshot;
}): SessionFabricSnapshot | null {
  const selected = shellForThread({ shell: input.shell, thread: input.detail.thread });
  if (selected === null) return null;
  const firstUserMessage = input.detail.thread.messages.find((message) => message.role === "user");
  const searchableText = [
    input.detail.thread.title,
    ...input.detail.thread.messages.map((message) => message.text),
    ...input.detail.thread.activities.map((activity) => activity.summary),
    ...input.detail.thread.proposedPlans.map((plan) => plan.planMarkdown),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join("\n");
  const location: SessionFabricExecutionLocation = {
    environmentKind: input.environmentKind,
    environmentId: input.environmentId,
    projectId: input.detail.thread.projectId,
    threadId: input.detail.thread.id,
    repositoryRoot: selected.project.workspaceRoot,
    worktreePath: input.detail.thread.worktreePath,
    scaffoldSessionId: input.scaffoldSessionId,
    scaffoldSessionUrl: input.scaffoldSessionUrl,
    scaffoldLifecycleEpoch: input.scaffoldLifecycleEpoch,
  };
  return {
    session: {
      sessionId: input.sessionId,
      title: input.detail.thread.title,
      publication: input.publication,
      runnerState: "online",
      location,
      initialPrompt: firstUserMessage?.text ?? null,
      searchableText,
      summary: null,
      cursor: {
        eventSequence: input.acknowledgedEventSequence,
        snapshotSequence: input.detail.snapshotSequence,
      },
      lastEventAt: input.detail.thread.updatedAt,
      createdAt: input.detail.thread.createdAt,
      updatedAt: input.detail.thread.updatedAt,
    },
    shell: selected.shell,
    thread: input.detail,
    compactedThroughEventSequence: input.acknowledgedEventSequence,
  };
}

export function sessionFabricCommandReceipt(input: {
  readonly command: SessionFabricCommand;
  readonly resultSequence: number | null;
  readonly accepted: boolean;
  readonly updatedAt: IsoDateTime;
}): SessionFabricCommandReceipt {
  return input.accepted && input.resultSequence !== null
    ? {
        sessionId: input.command.sessionId,
        commandId: input.command.commandId,
        status: "accepted",
        resultSequence: input.resultSequence,
        detail: null,
        updatedAt: input.updatedAt,
      }
    : {
        sessionId: input.command.sessionId,
        commandId: input.command.commandId,
        status: "rejected",
        resultSequence: null,
        detail: "The session runner rejected this command.",
        updatedAt: input.updatedAt,
      };
}

export function buildSessionFabricContextPublication(input: {
  readonly sessionId: SessionFabricSessionId;
  readonly runnerId: typeof SessionFabricRunnerId.Type;
  readonly runnerGeneration: number;
  readonly codeDiff: string | null;
  readonly publishedAt: IsoDateTime;
}): SessionFabricContextPublication {
  return {
    sessionId: input.sessionId,
    runnerId: input.runnerId,
    runnerGeneration: input.runnerGeneration,
    codeDiff: input.codeDiff,
    continuationRef: `session-fabric:${input.sessionId}`,
    publishedAt: input.publishedAt,
  };
}

function commandTargetsThread(command: ClientOrchestrationCommand, threadId: ThreadId): boolean {
  return "threadId" in command && command.threadId === threadId;
}

export class SessionFabricRunner extends Context.Service<
  SessionFabricRunner,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/sessionFabric/SessionFabricRunner") {}

class SessionFabricRunnerCapabilityError extends Data.TaggedError(
  "SessionFabricRunnerCapabilityError",
)<{
  readonly reason: "configuration" | "unavailable";
}> {}

export const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const config = resolveSessionFabricRunnerConfig(yield* SessionFabricRunnerEnvConfig);
  const environmentId = yield* environment.getEnvironmentId;
  const runnerId = SessionFabricRunnerId.make(`runner:${environmentId}`);
  const sessionsRef = yield* Ref.make(new Map<ThreadId, SessionFabricRunnerSession>());
  const runnerMetricAttributes = {
    authMode: config.authMode,
    environmentKind: config.environmentKind,
  } as const;

  const loadSnapshot = Effect.fn("session_fabric_runner.load_snapshot")(function* (
    sessionId: SessionFabricSessionId,
    threadId: ThreadId,
    acknowledgedEventSequence: number,
  ) {
    const [shell, detail] = yield* Effect.all([
      snapshots.getShellSnapshot(),
      snapshots.getThreadDetailSnapshot(threadId),
    ]);
    if (Option.isNone(detail)) return null;
    return buildSessionFabricSnapshot({
      sessionId,
      environmentId,
      environmentKind: config.environmentKind,
      scaffoldSessionId: config.scaffoldSessionId,
      scaffoldSessionUrl: config.scaffoldSessionUrl,
      scaffoldLifecycleEpoch: config.scaffoldLifecycleEpoch,
      publication: config.publication,
      acknowledgedEventSequence,
      shell,
      detail: detail.value,
    });
  });

  const runConnection = Effect.fn("session_fabric_runner.run_connection")(function* (
    session: SessionFabricRunnerSession,
  ) {
    if (config.relayUrl === null) return;
    const socketUrl = makeSessionFabricWebSocketUrl(config.relayUrl, session.sessionId);
    if (socketUrl === null) {
      yield* Effect.logWarning("session fabric relay URL must use http or https", {
        relayUrl: config.relayUrl.toString(),
      });
      return;
    }
    const initialSnapshot = yield* loadSnapshot(session.sessionId, session.threadId, 0);
    if (initialSnapshot === null) return;

    const capability =
      config.authMode === "disabled"
        ? null
        : yield* Effect.gen(function* () {
            if (config.environmentKind === "local") {
              if (config.capabilityDeployment === null) {
                return yield* new SessionFabricRunnerCapabilityError({
                  reason: "configuration",
                });
              }
              return yield* Effect.tryPromise({
                try: () =>
                  requestLocalSessionFabricRunnerCapability({
                    deployment: config.capabilityDeployment!,
                    fabricSessionId: session.sessionId,
                    environmentId,
                    threadId: session.threadId,
                    runnerId,
                  }),
                catch: () => new SessionFabricRunnerCapabilityError({ reason: "unavailable" }),
              });
            }
            if (
              config.scaffoldSessionId === null ||
              config.scaffoldSessionUrl === null ||
              config.scaffoldCapabilityBaseUrl === null ||
              config.scaffoldLifecycleEpoch === null ||
              config.runtimeApiToken === null
            ) {
              return yield* new SessionFabricRunnerCapabilityError({
                reason: "configuration",
              });
            }
            const scaffoldCapabilityBaseUrl = config.scaffoldCapabilityBaseUrl;
            const runtimeApiToken = config.runtimeApiToken;
            const scaffoldSessionId = config.scaffoldSessionId;
            const scaffoldLifecycleEpoch = config.scaffoldLifecycleEpoch;
            return yield* Effect.tryPromise({
              try: () =>
                requestScaffoldSessionFabricRunnerCapability({
                  capabilityBaseUrl: scaffoldCapabilityBaseUrl,
                  runtimeApiToken,
                  scaffoldSessionId,
                  lifecycleEpoch: scaffoldLifecycleEpoch,
                }),
              catch: () => new SessionFabricRunnerCapabilityError({ reason: "unavailable" }),
            });
          });

    const acknowledgedEventSequence = yield* Ref.make(0);
    const contextCache = yield* Ref.make<{
      readonly checkpointTurnCount: number;
      readonly codeDiff: string | null;
    } | null>(null);
    const socket = yield* Socket.makeWebSocket(socketUrl.toString(), {
      closeCodeIsError: () => true,
      openTimeout: "10 seconds",
      protocols: [...makeSessionFabricWebSocketProtocols(capability)],
    });
    const write = yield* socket.writer;
    const ready = yield* Deferred.make<void>();
    const send = (frame: SessionFabricClientFrame) => write(encodeClientFrame(frame));

    const loadCodeDiff = Effect.fn("session_fabric_runner.load_code_diff")(function* (
      snapshot: SessionFabricSnapshot,
    ) {
      const checkpointTurnCount = snapshot.thread.thread.checkpoints.reduce(
        (latest, checkpoint) => Math.max(latest, checkpoint.checkpointTurnCount),
        0,
      );
      const cached = yield* Ref.get(contextCache);
      if (cached?.checkpointTurnCount === checkpointTurnCount) return cached.codeDiff;
      const codeDiff =
        checkpointTurnCount === 0
          ? ""
          : yield* checkpointDiffQuery
              .getFullThreadDiff({
                threadId: session.threadId,
                toTurnCount: checkpointTurnCount,
                ignoreWhitespace: true,
              })
              .pipe(
                Effect.map((result) => result.diff),
                Effect.catchCause((cause) =>
                  Effect.logWarning("session fabric runner could not compute code context", {
                    sessionId: session.sessionId,
                    checkpointTurnCount,
                    cause: Cause.pretty(cause),
                  }).pipe(Effect.as(null)),
                ),
              );
      yield* Ref.set(contextCache, { checkpointTurnCount, codeDiff });
      return codeDiff;
    });

    const sendContext = Effect.fn("session_fabric_runner.send_context")(function* (
      snapshot: SessionFabricSnapshot,
    ) {
      const published = buildSessionFabricContextPublication({
        sessionId: session.sessionId,
        runnerId,
        runnerGeneration: config.runnerGeneration,
        codeDiff: yield* loadCodeDiff(snapshot),
        publishedAt: yield* nowIso,
      });
      yield* send({ type: "session.publish-context", published });
    });

    const sendSnapshot = Effect.gen(function* () {
      const snapshot = yield* loadSnapshot(
        session.sessionId,
        session.threadId,
        yield* Ref.get(acknowledgedEventSequence),
      );
      if (snapshot === null) return;
      yield* send({
        type: "session.publish-snapshot",
        published: {
          sessionId: session.sessionId,
          runnerId,
          runnerGeneration: config.runnerGeneration,
          snapshot,
        },
      });
      yield* sendContext(snapshot);
    });

    const publishEvent = (event: OrchestrationEvent) =>
      send({
        type: "session.publish-event",
        published: {
          sessionId: session.sessionId,
          runnerId,
          runnerGeneration: config.runnerGeneration,
          event,
        } satisfies SessionFabricPublishedEvent,
      });

    const publishLiveEvent = (event: OrchestrationEvent) =>
      publishEvent(event).pipe(Effect.andThen(sendSnapshot));

    const sendCommandReceipt = Effect.fn("session_fabric_runner.send_command_receipt")(function* (
      command: SessionFabricCommand,
    ) {
      const updatedAt = yield* nowIso;
      if (
        command.sessionId !== session.sessionId ||
        !commandTargetsThread(command.command, session.threadId)
      ) {
        yield* send({
          type: "command.receipt",
          receipt: sessionFabricCommandReceipt({
            command,
            resultSequence: null,
            accepted: false,
            updatedAt,
          }),
        });
        return;
      }
      const result = yield* Effect.exit(
        normalizeDispatchCommand(command.command).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ServerConfig.ServerConfig, serverConfig),
          Effect.provideService(WorkspacePaths.WorkspacePaths, workspacePaths),
          Effect.flatMap((value) => engine.dispatch(value)),
        ),
      );
      yield* send({
        type: "command.receipt",
        receipt: Exit.isSuccess(result)
          ? sessionFabricCommandReceipt({
              command,
              resultSequence: result.value.sequence,
              accepted: true,
              updatedAt,
            })
          : sessionFabricCommandReceipt({
              command,
              resultSequence: null,
              accepted: false,
              updatedAt,
            }),
      });
    });

    const handleServerFrame = (frame: SessionFabricServerFrame) => {
      switch (frame.type) {
        case "session.event-receipt":
          if (frame.pointer.sessionId !== session.sessionId) return Effect.void;
          return Ref.update(acknowledgedEventSequence, (current) =>
            Math.max(current, frame.pointer.sequence),
          );
        case "command.dispatch":
          return sendCommandReceipt(frame.command);
        default:
          return Effect.void;
      }
    };

    const onOpen = Effect.gen(function* () {
      yield* recordSessionFabricRunnerState("connected", runnerMetricAttributes);
      const latestSequence = yield* engine.latestSequence;
      yield* send({
        type: "runner.hello",
        hello: {
          protocolVersion: SESSION_FABRIC_PROTOCOL_VERSION,
          sessionId: session.sessionId,
          runnerId,
          runnerGeneration: config.runnerGeneration,
          location: initialSnapshot.session.location,
          publication: config.publication,
          lastCommittedEventSequence: latestSequence,
          connectedAt: yield* nowIso,
        },
      });
      yield* sendSnapshot;
      yield* engine.readEvents(0, Number.MAX_SAFE_INTEGER).pipe(
        Stream.filter((event) => orchestrationEventThreadId(event) === session.threadId),
        Stream.runForEach(publishEvent),
      );
    });
    const onOpenSafe = onOpen.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("session fabric runner initial synchronization failed", {
          sessionId: session.sessionId,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.ensuring(Deferred.succeed(ready, undefined).pipe(Effect.orDie)),
    );

    const incoming = socket.runString(
      (message) =>
        decodeServerFrame(message).pipe(
          Effect.flatMap(handleServerFrame),
          Effect.catchCause((cause) =>
            Effect.logWarning("session fabric runner ignored an invalid server frame", {
              sessionId: session.sessionId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      { onOpen: onOpenSafe },
    );
    const outgoing = Deferred.await(ready).pipe(
      Effect.andThen(
        Effect.forever(Queue.take(session.events).pipe(Effect.flatMap(publishLiveEvent))),
      ),
    );
    const connection = Effect.raceFirst(incoming, outgoing);
    const currentTimeMillis = yield* Clock.currentTimeMillis;
    yield* capability === null
      ? connection
      : Effect.raceFirst(
          connection,
          Effect.sleep(
            sessionFabricCapabilityRefreshDelayMs(capability.expiresAt, currentTimeMillis),
          ),
        );
  });

  const runSession = (session: SessionFabricRunnerSession) =>
    Effect.forever(
      recordSessionFabricRunnerState("connecting", runnerMetricAttributes).pipe(
        Effect.andThen(runConnection(session)),
        Effect.provide(Socket.layerWebSocketConstructorGlobal),
        Effect.catchCause((cause) =>
          recordSessionFabricRunnerState("connection_failed", runnerMetricAttributes).pipe(
            Effect.andThen(
              Effect.logWarning("session fabric runner connection failed", {
                sessionId: session.sessionId,
                threadId: session.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        ),
        Effect.andThen(recordSessionFabricRunnerState("reconnect_wait", runnerMetricAttributes)),
        Effect.andThen(Effect.sleep("1 second")),
      ),
    );

  const ensureSession = Effect.fn("session_fabric_runner.ensure_session")(function* (
    threadId: ThreadId,
  ) {
    const sessions = yield* Ref.get(sessionsRef);
    const existing = sessions.get(threadId);
    if (existing !== undefined) return existing;
    const session = {
      threadId,
      sessionId: resolveSessionFabricSessionId({
        environmentId,
        threadId,
        overrideSessionId: config.overrideSessionId,
        overrideThreadId: config.overrideThreadId,
      }),
      events: yield* Queue.unbounded<OrchestrationEvent>(),
    } satisfies SessionFabricRunnerSession;
    yield* Ref.update(sessionsRef, (current) => new Map(current).set(threadId, session));
    yield* Effect.forkScoped(runSession(session));
    return session;
  });

  const start: SessionFabricRunner["Service"]["start"] = Effect.fn("session_fabric_runner.start")(
    function* () {
      if (config.relayUrl === null) {
        yield* recordSessionFabricRunnerState("disabled", runnerMetricAttributes);
        yield* Effect.logDebug("session fabric runner disabled; relay URL is not configured");
        return;
      }
      const liveEvents = yield* Stream.toQueue(engine.streamDomainEvents, {
        capacity: "unbounded",
      });
      const shell = yield* snapshots.getShellSnapshot().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("session fabric runner could not load initial threads", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
        ),
      );
      if (shell !== null) {
        yield* Effect.forEach(shell.threads, (thread) => ensureSession(thread.id), {
          concurrency: 1,
          discard: true,
        });
      }
      yield* Effect.logInfo("session fabric runner enabled", {
        environmentId,
        environmentKind: config.environmentKind,
        relayUrl: config.relayUrl.origin,
      });
      yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(liveEvents).pipe(
            Effect.flatMap((event) => {
              const threadId = orchestrationEventThreadId(event);
              if (threadId === null) return Effect.void;
              return ensureSession(threadId).pipe(
                Effect.flatMap((session) => Queue.offer(session.events, event)),
              );
            }),
          ),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("session fabric runner domain stream stopped", {
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      );
    },
  );

  return SessionFabricRunner.of({ start });
});

export const layer = Layer.effect(SessionFabricRunner, make);
