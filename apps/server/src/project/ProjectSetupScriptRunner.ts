// @effect-diagnostics nodeBuiltinImport:off -- The receiver wrapper must use synchronous atomic wx filesystem operations shared with a child shell process.
import { ProjectId } from "@t3tools/contracts";
import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptRunnerResultStarted {
  readonly status: "started";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly terminalId: string;
  readonly cwd: string;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
  readonly invocationId?: string;
  readonly idempotencyStateDir?: string;
}

export class ProjectSetupScriptAmbiguousInvocationError extends Schema.TaggedErrorClass<ProjectSetupScriptAmbiguousInvocationError>()(
  "ProjectSetupScriptAmbiguousInvocationError",
  {
    invocationId: Schema.String,
    requestPath: Schema.String,
    claimPath: Schema.String,
  },
) {
  override get message(): string {
    return "Setup was interrupted before completion. Run it manually.";
  }
}
const isProjectSetupScriptAmbiguousInvocationError = Schema.is(
  ProjectSetupScriptAmbiguousInvocationError,
);

const quotePosixShellArgument = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

function setupInvocationLedger(input: {
  readonly invocationId: string;
  readonly stateDir: string;
}) {
  const digest = NodeCrypto.createHash("sha256").update(input.invocationId).digest("hex");
  const directory = NodePath.join(input.stateDir, "setup-invocations", digest);
  return {
    directory,
    requestPath: NodePath.join(directory, "request.json"),
    claimPath: NodePath.join(directory, "claim"),
    resultPath: NodePath.join(directory, "result.json"),
  };
}

export function makeIdempotentSetupLaunchCommand(input: {
  readonly command: string;
  readonly cwd: string;
  readonly executablePath: string;
  readonly invocationId: string;
  readonly stateDir: string;
}): string {
  const ledger = setupInvocationLedger(input);
  const claimReceiver = [
    'const fs = require("node:fs");',
    `const claim = ${JSON.stringify(ledger.claimPath)};`,
    'try { const claimFd = fs.openSync(claim, "wx"); fs.closeSync(claimFd); } catch (error) {',
    '  if (error && error.code === "EEXIST") process.exit(75);',
    "  throw error;",
    "}",
  ].join(" ");
  const resultReceiver = [
    'const fs = require("node:fs");',
    `const resultPath = ${JSON.stringify(ledger.resultPath)};`,
    "const status = Number(process.argv[1]);",
    'fs.writeFileSync(resultPath, JSON.stringify({ status }), { flag: "wx" });',
  ].join(" ");
  const executable = quotePosixShellArgument(input.executablePath);
  return [
    `if ${executable} -e ${quotePosixShellArgument(claimReceiver)}; then`,
    `  eval ${quotePosixShellArgument(input.command)}`,
    "  __t3_setup_status=$?",
    `  ${executable} -e ${quotePosixShellArgument(resultReceiver)} "$__t3_setup_status"`,
    "  unset __t3_setup_status",
    "fi",
  ].join("\n");
}

export class ProjectSetupScriptOperationError extends Schema.TaggedErrorClass<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals(["resolveProject", "openTerminal", "writeCommand"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedErrorClass<ProjectSetupScriptProjectNotFoundError>()(
  "ProjectSetupScriptProjectNotFoundError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
  },
) {
  override get message(): string {
    return `Project was not found for setup script execution for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export const ProjectSetupScriptRunnerError = Schema.Union([
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
  ProjectSetupScriptAmbiguousInvocationError,
]);
export type ProjectSetupScriptRunnerError = typeof ProjectSetupScriptRunnerError.Type;

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager.TerminalManager;

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const errorContext = {
      threadId: input.threadId,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    const projectById = input.projectId
      ? yield* projectionSnapshotQuery.getProjectShellById(ProjectId.make(input.projectId)).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new ProjectSetupScriptOperationError({
                ...errorContext,
                operation: "resolveProject",
                cause,
              }),
          ),
        )
      : null;
    const project =
      projectById ??
      (input.projectCwd
        ? yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(input.projectCwd).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "resolveProject",
                  cause,
                }),
            ),
          )
        : null);

    if (!project) {
      return yield* new ProjectSetupScriptProjectNotFoundError(errorContext);
    }

    const script = setupProjectScript(project.scripts);
    if (!script) {
      return {
        status: "no-script",
      } as const;
    }

    const terminalId = input.preferredTerminalId ?? `setup-${script.id}`;
    const cwd = input.worktreePath;
    const platform = yield* HostProcessPlatform;
    const executablePath = yield* HostProcessExecutablePath;
    const invocationId = input.invocationId;
    const idempotencyStateDir = input.idempotencyStateDir;
    const command =
      invocationId && idempotencyStateDir
        ? platform === "win32"
          ? yield* new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "writeCommand",
              cause: new Error("Idempotent setup launch is not supported on Windows."),
            })
          : yield* Effect.try({
              try: () => {
                const ledger = setupInvocationLedger({
                  invocationId,
                  stateDir: idempotencyStateDir,
                });
                // @effect-diagnostics-next-line preferSchemaOverJson:off -- Immutable private ledger metadata has a fixed local shape and is compared byte-for-byte.
                const request = JSON.stringify({
                  commandSha256: NodeCrypto.createHash("sha256")
                    .update(script.command)
                    .digest("hex"),
                  cwd,
                  terminalId,
                });
                NodeFS.mkdirSync(ledger.directory, { recursive: true });
                try {
                  NodeFS.writeFileSync(ledger.requestPath, request, { flag: "wx" });
                } catch (error) {
                  if (
                    !error ||
                    typeof error !== "object" ||
                    !("code" in error) ||
                    error.code !== "EEXIST" ||
                    NodeFS.readFileSync(ledger.requestPath, "utf8") !== request
                  ) {
                    throw error;
                  }
                }
                if (NodeFS.existsSync(ledger.resultPath)) return null;
                if (NodeFS.existsSync(ledger.claimPath)) {
                  throw new ProjectSetupScriptAmbiguousInvocationError({
                    invocationId,
                    requestPath: ledger.requestPath,
                    claimPath: ledger.claimPath,
                  });
                }
                return makeIdempotentSetupLaunchCommand({
                  command: script.command,
                  cwd,
                  executablePath,
                  invocationId,
                  stateDir: idempotencyStateDir,
                });
              },
              catch: (cause) =>
                isProjectSetupScriptAmbiguousInvocationError(cause)
                  ? cause
                  : new ProjectSetupScriptOperationError({
                      ...errorContext,
                      operation: "writeCommand",
                      cause,
                    }),
            })
        : script.command;
    if (command === null) {
      return {
        status: "started",
        scriptId: script.id,
        scriptName: script.name,
        terminalId,
        cwd,
      } as const;
    }
    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
    });

    yield* terminalManager
      .open({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        env,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "openTerminal",
              cause,
            }),
        ),
      );
    yield* terminalManager
      .write({
        threadId: input.threadId,
        terminalId,
        data: `${command}\r`,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "writeCommand",
              cause,
            }),
        ),
      );

    return {
      status: "started",
      scriptId: script.id,
      scriptName: script.name,
      terminalId,
      cwd,
    } as const;
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
