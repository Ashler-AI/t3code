// @effect-diagnostics nodeBuiltinImport:off -- These integration-style tests exercise the real filesystem and POSIX receiver boundary.
import { describe, expect, it, vi } from "@effect/vitest";
import { type OrchestrationProject, ProjectId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const isProjectSetupScriptOperationError = Schema.is(
  ProjectSetupScriptRunner.ProjectSetupScriptOperationError,
);

const makeProject = (scripts: OrchestrationProject["scripts"]): OrchestrationProject => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: null,
  scripts,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const makeProjectionSnapshotQueryLayer = (project: OrchestrationProject) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
      ),
    getProjectShellById: (projectId) =>
      Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.succeed({ matches: [] }),
  });

const makeTerminalManagerLayer = (
  overrides: Pick<TerminalManager.TerminalManager["Service"], "open" | "write">,
) =>
  Layer.succeed(TerminalManager.TerminalManager, {
    ...overrides,
    attachStream: () => Effect.die(new Error("unused")),
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: () => Effect.die(new Error("unused")),
    close: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    subscribeMetadata: () => Effect.succeed(() => undefined),
  });

const testLayer = (
  project: OrchestrationProject,
  terminal: Pick<TerminalManager.TerminalManager["Service"], "open" | "write">,
) =>
  ProjectSetupScriptRunner.layer.pipe(
    Layer.provideMerge(makeProjectionSnapshotQueryLayer(project)),
    Layer.provideMerge(makeTerminalManagerLayer(terminal)),
  );

describe("ProjectSetupScriptRunner", () => {
  it.effect("returns no-script when no setup script exists", () => {
    const open = vi.fn(() => Effect.die("unexpected open"));
    const write = vi.fn(() => Effect.die("unexpected write"));
    const project = makeProject([]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result).toEqual({ status: "no-script" });
      expect(open).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer(project, { open, write })));
  });

  it.effect(
    "opens the deterministic setup terminal with worktree env and writes the command",
    () => {
      const open = vi.fn(() =>
        Effect.succeed({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup-setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const write = vi.fn(() => Effect.void);
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);

      return Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const result = yield* runner.runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
        });

        expect(result).toEqual({
          status: "started",
          scriptId: "setup",
          scriptName: "Setup",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
        });
        expect(open).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          env: {
            T3CODE_PROJECT_ROOT: "/repo/project",
            T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
          },
        });
        expect(write).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          data: "bun install\r",
        });
      }).pipe(Effect.provide(testLayer(project, { open, write })));
    },
  );

  it.effect("keeps terminal failures as the exact cause of a structured operation error", () => {
    const rootCause = new Error("stat failed");
    const terminalError = new TerminalManager.TerminalCwdStatError({
      cwd: "/repo/worktrees/a",
      cause: rootCause,
    });
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const error = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        })
        .pipe(Effect.flip);

      expect(isProjectSetupScriptOperationError(error)).toBe(true);
      if (isProjectSetupScriptOperationError(error)) {
        expect(error.operation).toBe("openTerminal");
        expect(error.threadId).toBe("thread-1");
        expect(error.projectId).toBe("project-1");
        expect(error.worktreePath).toBe("/repo/worktrees/a");
        expect(error.cause).toBe(terminalError);
        expect(terminalError.cause).toBe(rootCause);
      }
    }).pipe(
      Effect.provide(
        testLayer(project, {
          open: () => Effect.fail(terminalError),
          write: () => Effect.die("unexpected write"),
        }),
      ),
    );
  });

  it.effect("redelivers a request-only invocation after terminal delivery is interrupted", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-setup-request-"));
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "printf setup",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);
    const input = {
      threadId: "thread-1",
      projectId: "project-1",
      worktreePath: "/repo/worktrees/a",
      invocationId: "invocation-request-only",
      idempotencyStateDir: stateDir,
    };
    const snapshot = {
      threadId: "thread-1",
      terminalId: "setup-setup",
      cwd: "/repo/worktrees/a",
      worktreePath: "/repo/worktrees/a",
      status: "running" as const,
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "setup-setup",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const interruptedWrite = vi.fn(() =>
      Effect.fail(
        new TerminalManager.TerminalWriteError({
          threadId: "thread-1",
          terminalId: "setup-setup",
          terminalPid: 123,
          cause: new Error("interrupted before receiver accepted bytes"),
        }),
      ),
    );
    const replayWrite = vi.fn(() => Effect.void);

    return Effect.gen(function* () {
      yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner.pipe(
        Effect.flatMap((runner) => runner.runForThread(input)),
        Effect.provide(
          testLayer(project, { open: () => Effect.succeed(snapshot), write: interruptedWrite }),
        ),
        Effect.flip,
      );
      const replay = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner.pipe(
        Effect.flatMap((runner) => runner.runForThread(input)),
        Effect.provide(
          testLayer(project, { open: () => Effect.succeed(snapshot), write: replayWrite }),
        ),
      );

      expect(replay.status).toBe("started");
      expect(interruptedWrite).toHaveBeenCalledTimes(1);
      expect(replayWrite).toHaveBeenCalledTimes(1);
    }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(stateDir, { recursive: true }))));
  });

  it.effect("executes once in the live terminal shell across duplicate deliveries", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-setup-receiver-"));
    const outputPath = NodePath.join(stateDir, "executions.txt");
    const command = 'live_setup "$LIVE_SETUP_VALUE"';
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command,
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);
    let delivered = "";
    const terminal = {
      open: () =>
        Effect.succeed({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: stateDir,
          worktreePath: stateDir,
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup-setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      write: (input: { readonly data: string }) =>
        Effect.sync(() => {
          delivered = input.data.trim();
        }),
    };
    const input = {
      threadId: "thread-1",
      projectId: "project-1",
      worktreePath: stateDir,
      invocationId: "invocation-duplicate-delivery",
      idempotencyStateDir: stateDir,
    };

    return Effect.gen(function* () {
      yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner.pipe(
        Effect.flatMap((runner) => runner.runForThread(input)),
        Effect.provide(testLayer(project, terminal)),
      );
      NodeChildProcess.execFileSync(
        "/bin/sh",
        [
          "-c",
          [
            'live_setup() { printf \'%s\\n\' "$1" >> "$LIVE_SETUP_OUTPUT"; }',
            "LIVE_SETUP_VALUE=executed",
            delivered,
          ].join("\n"),
        ],
        {
          env: { ...process.env, LIVE_SETUP_OUTPUT: outputPath },
        },
      );
      NodeChildProcess.execFileSync("/bin/sh", ["-c", delivered]);

      expect(NodeFS.readFileSync(outputPath, "utf8")).toBe("executed\n");
      const [ledgerDir] = NodeFS.readdirSync(NodePath.join(stateDir, "setup-invocations"));
      expect(ledgerDir).toBeDefined();
      expect(
        NodeFS.readFileSync(
          NodePath.join(stateDir, "setup-invocations", ledgerDir!, "result.json"),
          "utf8",
        ),
      ).toBe('{"status":0}');

      const open = vi.fn(() => Effect.die("completed invocation must not reopen terminal"));
      const write = vi.fn(() => Effect.die("completed invocation must not redeliver"));
      const reconciled = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner.pipe(
        Effect.flatMap((runner) => runner.runForThread(input)),
        Effect.provide(testLayer(project, { open, write })),
      );
      expect(reconciled.status).toBe("started");
      expect(open).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(stateDir, { recursive: true }))));
  });

  it.effect("fails closed when an invocation was claimed without a result", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-setup-ambiguous-"));
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "printf setup",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);
    let delivered = "";
    const snapshot = {
      threadId: "thread-1",
      terminalId: "setup-setup",
      cwd: stateDir,
      worktreePath: stateDir,
      status: "running" as const,
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "setup-setup",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const input = {
      threadId: "thread-1",
      projectId: "project-1",
      worktreePath: stateDir,
      invocationId: "invocation-ambiguous",
      idempotencyStateDir: stateDir,
    };

    return Effect.gen(function* () {
      yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner.pipe(
        Effect.flatMap((runner) => runner.runForThread(input)),
        Effect.provide(
          testLayer(project, {
            open: () => Effect.succeed(snapshot),
            write: ({ data }) => Effect.sync(() => void (delivered = data)),
          }),
        ),
      );
      expect(delivered).not.toBe("");
      const [ledgerDir] = NodeFS.readdirSync(NodePath.join(stateDir, "setup-invocations"));
      expect(ledgerDir).toBeDefined();
      NodeFS.writeFileSync(NodePath.join(stateDir, "setup-invocations", ledgerDir!, "claim"), "");

      const error = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner.pipe(
        Effect.flatMap((runner) => runner.runForThread(input)),
        Effect.provide(
          testLayer(project, {
            open: () => Effect.die("ambiguous invocation must not reopen terminal"),
            write: () => Effect.die("ambiguous invocation must not redeliver"),
          }),
        ),
        Effect.flip,
      );
      expect(error._tag).toBe("ProjectSetupScriptAmbiguousInvocationError");
      expect(error.message).toBe("Setup was interrupted before completion. Run it manually.");
    }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(stateDir, { recursive: true }))));
  });

  it.effect("fails closed for idempotent setup delivery on Windows", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-setup-windows-"));
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "npm install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);
    const open = vi.fn(() => Effect.die("unsupported delivery must not open a terminal"));
    const write = vi.fn(() => Effect.die("unsupported delivery must not write a command"));

    return Effect.gen(function* () {
      const error = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner.pipe(
        Effect.flatMap((runner) =>
          runner.runForThread({
            threadId: "thread-1",
            projectId: "project-1",
            worktreePath: "C:\\repo\\worktree",
            invocationId: "invocation-windows",
            idempotencyStateDir: stateDir,
          }),
        ),
        Effect.provide(testLayer(project, { open, write })),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.flip,
      );

      expect(error._tag).toBe("ProjectSetupScriptOperationError");
      expect(open).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(stateDir, { recursive: true }))));
  });
});
