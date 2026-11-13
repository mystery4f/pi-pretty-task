/**
 * The process-task store: the one place that knows which tasks a session has,
 * how they are identified, and how a running process becomes a finished record.
 *
 * Records live in memory for the lifetime of the extension and are written to
 * disk only through the output files; history recovery is the persistence
 * ticket's job, which is why nothing here reads a task back from disk yet.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { randomInt } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { type OutputTail, readOutputTail } from "../base/output.js";
import { processOutputPath, sessionTaskDirectory } from "../base/runtime-state.js";
import type { ProcessTask } from "../base/task.js";
import { type RunningProcess, startProcess } from "./supervisor.js";

/** Identifies which session's tasks are meant. Both fields come from the turn. */
export interface TaskScope {
  /** Directory the session runs in; its `.pi/` holds runtime state. */
  cwd: string;
  sessionId: string;
}

export interface StartProcessTaskInput extends TaskScope {
  command: string;
  name?: string;
}

/** A task as it looks right now: the record plus the values that keep moving. */
export interface ProcessTaskView {
  task: ProcessTask;
  /** Milliseconds from creation to end, or to now while it runs. */
  elapsedMs: number;
  /** Bytes in the output file, live for a running task. */
  outputBytes: number;
}

export interface ProcessTasksOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Clock seam for tests; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Called once for every task that ends, with the record as it stands after
   * the final status was written. Announcing the task — a session message, a
   * panel refresh — is the caller's business, so this store stays silent.
   */
  onFinish?: (view: ProcessTaskView) => void;
}
interface SessionTasks {
  readonly directory: string;
  readonly tasks: Map<string, ProcessTask>;
  readonly running: Map<string, RunningProcess>;
}

/** No 0/O/1/l: an id is meant to be retyped by a human into a later message. */
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 6;
const NAME_LIMIT = 48;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A readable default name from the command, for when the caller gives none. */
export function deriveTaskName(command: string): string {
  const line = command.split("\n", 1)[0] ?? "";
  const collapsed = line.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return "command";
  if (collapsed.length <= NAME_LIMIT) return collapsed;
  return `${collapsed.slice(0, NAME_LIMIT - 1)}…`;
}

export class ProcessTasks {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionTasks>();
  private readonly onFinish: ((view: ProcessTaskView) => void) | undefined;

  constructor(options: ProcessTasksOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env;
    this.now = options.now ?? Date.now;
    this.onFinish = options.onFinish;
  }

  /** Start a command in the background and return its record immediately. */
  async start(input: StartProcessTaskInput): Promise<ProcessTask> {
    const session = await this.session(input);
    const id = this.createId(session);
    const name = input.name?.trim();
    const task: ProcessTask = {
      id,
      kind: "process",
      name: name !== undefined && name.length > 0 ? name : deriveTaskName(input.command),
      status: "running",
      createdAt: this.now(),
      command: input.command,
      cwd: input.cwd,
      outputPath: processOutputPath(session.directory, id),
      outputBytes: 0,
    };

    session.tasks.set(id, task);

    let running: RunningProcess;
    try {
      running = startProcess({
        command: task.command,
        cwd: task.cwd,
        outputPath: task.outputPath,
        platform: this.platform,
        env: this.env,
      });
    } catch (error) {
      session.tasks.delete(id);
      throw error instanceof Error ? error : new Error(errorMessage(error));
    }

    task.pid = running.pid;
    session.running.set(id, running);
    void running.exit.then(
      (exit) => {
        this.finish(session, task, running, exit.exitCode);
      },
      (error: unknown) => {
        this.finish(session, task, running, null, errorMessage(error));
      },
    );

    return task;
  }

  /** Every task of the session, oldest first. Reads nothing back from disk. */
  list(scope: TaskScope): ProcessTaskView[] {
    const session = this.sessions.get(scope.sessionId);
    if (session === undefined) return [];
    return [...session.tasks.values()].map((task) => this.view(session, task));
  }

  get(scope: TaskScope, id: string): ProcessTaskView | undefined {
    const session = this.sessions.get(scope.sessionId);
    const task = session?.tasks.get(id);
    return session === undefined || task === undefined ? undefined : this.view(session, task);
  }

  /** The tail of a task's output. Undefined when the session has no such task. */
  async logs(
    scope: TaskScope,
    id: string,
    options: { lines: number; maxBytes?: number },
  ): Promise<{ view: ProcessTaskView; tail: OutputTail } | undefined> {
    const session = this.sessions.get(scope.sessionId);
    const task = session?.tasks.get(id);
    if (session === undefined || task === undefined) return undefined;
    const tail = await readOutputTail(task.outputPath, options);
    return { view: this.view(session, task), tail };
  }

  private view(session: SessionTasks, task: ProcessTask): ProcessTaskView {
    const running = session.running.get(task.id);
    const endedAt = task.endedAt ?? this.now();
    return {
      task,
      elapsedMs: Math.max(0, endedAt - task.createdAt),
      outputBytes: running === undefined ? task.outputBytes : running.bytesWritten(),
    };
  }

  private finish(
    session: SessionTasks,
    task: ProcessTask,
    running: RunningProcess,
    exitCode: number | null,
    failure?: string,
  ): void {
    session.running.delete(task.id);
    task.outputBytes = running.bytesWritten();
    task.exitCode = exitCode;
    task.endedAt = this.now();
    if (failure !== undefined) {
      task.status = "failed";
      task.error = failure;
    } else if (exitCode === 0) {
      task.status = "completed";
    } else {
      task.status = "failed";
      task.error =
        exitCode === null
          ? "the command was terminated by a signal"
          : `exited with code ${exitCode}`;
    }
    this.onFinish?.(this.view(session, task));
  }

  private async session(scope: TaskScope): Promise<SessionTasks> {
    const existing = this.sessions.get(scope.sessionId);
    if (existing !== undefined) return existing;

    const directory = sessionTaskDirectory(scope.cwd, scope.sessionId);
    await mkdir(directory, { recursive: true });
    const created: SessionTasks = {
      directory,
      tasks: new Map(),
      running: new Map(),
    };
    this.sessions.set(scope.sessionId, created);
    return created;
  }

  private createId(session: SessionTasks): string {
    for (;;) {
      let id = "";
      for (let index = 0; index < ID_LENGTH; index += 1) {
        id += ID_ALPHABET.charAt(randomInt(ID_ALPHABET.length));
      }
      if (!session.tasks.has(id)) return id;
    }
  }
}
