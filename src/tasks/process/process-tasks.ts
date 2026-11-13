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
import type { KillReason, ProcessTask } from "../base/task.js";
import { type RunningProcess, type StopOutcome, startProcess } from "./supervisor.js";

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

/** What a stop is asked for. The reason defaults to the user's own kill. */
export interface StopTaskOptions {
  reason?: KillReason;
  /** Overrides the store's grace period, mostly for tests. */
  graceMs?: number;
  /** Overrides the store's forced-kill confirmation window. */
  confirmMs?: number;
}

/** How `stop` answered. */
export type StopTaskOutcome = "killed" | "already-finished" | "tree-survived";

export interface StopTaskResult {
  /** The record after the stop: finished whenever the outcome is `killed`. */
  view: ProcessTaskView;
  outcome: StopTaskOutcome;
  /** Milliseconds the stop took. */
  tookMs: number;
  /** What the system said, when the tree could not be confirmed gone. */
  detail?: string;
}

export interface ProcessTasksOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Clock seam for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Grace a polite kill gets before it is forced; defaults to the supervisor's. */
  killGraceMs?: number;
  /** How long a forced kill gets to clear the tree; defaults to the supervisor's. */
  killConfirmMs?: number;
}

interface SessionTasks {
  readonly directory: string;
  readonly tasks: Map<string, ProcessTask>;
  readonly running: Map<string, RunningProcess>;
  /** Why each running task is being stopped, kept until its exit is booked. */
  readonly killReasons: Map<string, KillReason>;
}

/** No 0/O/1/l: an id is meant to be retyped by a human into a later message. */
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 6;
const NAME_LIMIT = 48;

/**
 * How long a stop waits for the exit bookkeeping once the tree is confirmed
 * gone. Past that, the stop settles the record itself.
 */
const EXIT_WAIT_MS = 2000;

/** Map the supervisor's answer onto the store's, which speaks of tasks. */
const STOP_OUTCOMES: Record<StopOutcome, StopTaskOutcome> = {
  stopped: "killed",
  "already-exited": "already-finished",
  "tree-survived": "tree-survived",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wait at most `timeoutMs` for a promise to settle. True when it did: a promise
 * that never settles must not hold the kill's answer hostage.
 */
async function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  private readonly killGraceMs: number | undefined;
  private readonly killConfirmMs: number | undefined;

  constructor(options: ProcessTasksOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env;
    this.now = options.now ?? Date.now;
    this.killGraceMs = options.killGraceMs;
    this.killConfirmMs = options.killConfirmMs;
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

  /**
   * Stop one task and everything its command started. Undefined means the
   * session has no such task; every other case is an answer, including a task
   * that had already finished on its own.
   */
  async stop(
    scope: TaskScope,
    id: string,
    options: StopTaskOptions = {},
  ): Promise<StopTaskResult | undefined> {
    const session = this.sessions.get(scope.sessionId);
    const task = session?.tasks.get(id);
    if (session === undefined || task === undefined) return undefined;

    const running = session.running.get(id);
    if (running === undefined) {
      return { view: this.view(session, task), outcome: "already-finished", tookMs: 0 };
    }

    // The reason rides with the task, not with the signal: the supervisor only
    // reports whether anything was signalled, the store knows who asked.
    session.killReasons.set(id, options.reason ?? "user");
    const stopped = await running.stop({
      graceMs: options.graceMs ?? this.killGraceMs,
      confirmMs: options.confirmMs ?? this.killConfirmMs,
    });

    // A stop that got an answer must leave a finished record, never `running`:
    // the exit bookkeeping usually arrives on its own, and when it does not the
    // stop settles the record here. `finish` ignores a record already settled,
    // so a late exit cannot contradict this answer.
    if (stopped.outcome === "stopped" && !(await settledWithin(running.exit, EXIT_WAIT_MS))) {
      this.finish(session, task, running, null);
    }
    session.killReasons.delete(id);

    return {
      view: this.view(session, task),
      outcome: STOP_OUTCOMES[stopped.outcome],
      tookMs: stopped.tookMs,
      detail: stopped.detail,
    };
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
    // A reason only counts when a signal actually went out: a task that ended on
    // its own during a stop keeps its natural end instead of becoming a kill.
    const killReason = running.signalled() ? session.killReasons.get(task.id) : undefined;
    session.killReasons.delete(task.id);
    task.outputBytes = running.bytesWritten();
    // A stop that was already answered settled this record; a late exit may only
    // improve its byte count, never overwrite what the kill said.
    if (task.endedAt !== undefined) return;
    task.exitCode = exitCode;
    task.endedAt = this.now();
    if (killReason !== undefined) {
      // We asked for this end, so it is a kill even when the exit code looks
      // ordinary — and the reason says who asked.
      task.status = "killed";
      task.killReason = killReason;
      return;
    }
    if (failure !== undefined) {
      task.status = "failed";
      task.error = failure;
      return;
    }
    if (exitCode === 0) {
      task.status = "completed";
      return;
    }
    task.status = "failed";
    task.error =
      exitCode === null ? "the command was terminated by a signal" : `exited with code ${exitCode}`;
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
      killReasons: new Map(),
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
