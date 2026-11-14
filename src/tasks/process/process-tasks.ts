/**
 * The process-task store: the one place that knows which tasks a session has,
 * how they are identified, and how a running process becomes a finished record.
 *
 * Every session owns one `TaskStore` under its state directory, and every change
 * to a record is followed by a save. Loading the first time a session is touched
 * is what makes history survive a restart: records come back from disk, and a
 * record that still says `running` is marked `interrupted` because whatever ran
 * it is gone. Nothing is adopted and nothing is killed on load — the store reads
 * files and leaves every process alone.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type OutputTail, readOutputTail } from "../base/output.js";
import { processOutputPath, sessionTaskDirectory, type TaskScope } from "../base/runtime-state.js";
import type { KillReason, ProcessTask, Task } from "../base/task.js";
import { type TaskSession, TaskSessions } from "../base/task-sessions.js";
import { DEFAULT_OUTPUT_CAP_BYTES } from "./limits.js";
import { resolveShellPolicy, type ShellChoice, type ShellPolicy } from "./shell.js";
import { type RunningProcess, type StopOutcome, startProcess } from "./supervisor.js";

export type { TaskScope };

export interface StartProcessTaskInput extends TaskScope {
  command: string;
  name?: string;
  /**
   * Runtime cap in whole milliseconds, measured from the start. The tool parses
   * seconds; the record and the timer speak milliseconds.
   */
  timeoutMs?: number;
  /** Shell for this command; the configured one unless the call picks another. */
  shell?: ShellChoice;
  /**
   * Directory for this call, relative to the session's cwd unless it is absolute.
   * Resolved once, before a record exists; the record keeps the absolute path.
   */
  workingDirectory?: string;
  /**
   * Variables for the child only, merged over the extension's environment. Not
   * recorded: a task file is not a safe place for a token, and the child already
   * has what it needs.
   */
  env?: Record<string, string>;
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
  /** Bytes a task's output may hold; defaults to the documented 20 MiB. */
  outputCapBytes?: number;
  /**
   * Called once for every task that ends, with the record as it stands after
   * the final status was written. Announcing the task — a session message, a
   * panel refresh — is the caller's business, so this store stays silent.
   */
  onFinish?: (view: ProcessTaskView) => void;
  /** Shared session loader; one instance is passed to every kind of store. */
  sessions?: TaskSessions;
  /**
   * Shell resolved at load time. Absent, the store resolves one from `env`: a task
   * started by a test still runs in the platform's default shell.
   */
  shellPolicy?: ShellPolicy;
}
/**
 * The process store's view of a shared session: the loaded records plus the
 * processes this store is supervising.
 */
interface SessionTasks extends TaskSession {
  readonly running: Map<string, RunningProcess>;
  /** Why each running task is being stopped, kept until its exit is booked. */
  readonly killReasons: Map<string, KillReason>;
  /**
   * The limits that have already ended tasks. Separate from `killReasons`
   * because a limit ends the task whether or not a signal reached it: a capped
   * command can exit on the same tick as the dropped byte.
   */
  readonly limitReasons: Map<string, KillReason>;
  /** Pending runtime caps, kept so a natural end can cancel its timer. */
  readonly runtimeCaps: Map<string, ReturnType<typeof setTimeout>>;
}

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
  /**
   * Keyed by state directory, not session id: the directory already encodes cwd
   * and session, and the promise keeps two turns from loading the same history
   * twice.
   */
  private readonly sessions = new Map<string, Promise<SessionTasks>>();
  private readonly killGraceMs: number | undefined;
  private readonly killConfirmMs: number | undefined;
  private readonly outputCapBytes: number;
  private readonly onFinish: ((view: ProcessTaskView) => void) | undefined;
  /** The shell every task starts in, resolved once so a bad config fails at load. */
  private readonly shellPolicy: ShellPolicy;

  /** Loads and saves the shared record set; both kinds write through it. */
  private readonly hub: TaskSessions;
  constructor(options: ProcessTasksOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env;
    this.now = options.now ?? Date.now;
    this.hub = options.sessions ?? new TaskSessions({ now: this.now });
    this.killGraceMs = options.killGraceMs;
    this.killConfirmMs = options.killConfirmMs;
    this.outputCapBytes = options.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES;
    this.onFinish = options.onFinish;
    this.shellPolicy =
      options.shellPolicy ?? resolveShellPolicy({ platform: this.platform, env: this.env });
  }

  /** Start a command in the background and return its record immediately. */
  async start(input: StartProcessTaskInput): Promise<ProcessTask> {
    const session = await this.session(input);
    // The directory is settled before the record exists: a cwd that cannot be
    // used rejects the call instead of leaving a task that never started.
    const cwd = await this.resolveWorkingDirectory(input.cwd, input.workingDirectory);
    const id = this.createId(session);
    const name = input.name?.trim();
    const task: ProcessTask = {
      id,
      kind: "process",
      name: name !== undefined && name.length > 0 ? name : deriveTaskName(input.command),
      status: "running",
      createdAt: this.now(),
      command: input.command,
      cwd,
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
        maxOutputBytes: this.outputCapBytes,
        onOutputCap: () => {
          // The reason is recorded here, before the stop is asked for: a command
          // can exit on the same tick as the dropped byte, and that exit must
          // not turn a capped task back into a completed one.
          session.limitReasons.set(id, "output_cap");
          void this.stop(input, id, { reason: "output_cap" });
        },
        platform: this.platform,
        env: this.env,
        envOverrides: input.env,
        shellPolicy: this.shellPolicy,
        shell: input.shell,
      });
    } catch (error) {
      session.tasks.delete(id);
      throw error instanceof Error ? error : new Error(errorMessage(error));
    }

    task.pid = running.pid;
    session.running.set(id, running);
    // The id is about to reach the model, so the record reaches the disk first:
    // an extension that crashes right after this turn still knows the task.
    await this.persist(session);
    void running.exit.then(
      (exit) => {
        this.finish(session, task, running, exit.exitCode);
      },
      (error: unknown) => {
        this.finish(session, task, running, null, errorMessage(error));
      },
    );
    this.scheduleRuntimeCap(session, input, id, input.timeoutMs);

    return task;
  }
  /**
   * Start one task's command again as a new record. The old row stays: rerunning
   * adds history rather than rewriting it, so the reader keeps both outcomes.
   */
  async rerun(scope: TaskScope, id: string): Promise<ProcessTaskView | undefined> {
    const previous = await this.get(scope, id);
    if (previous === undefined || previous.task.kind !== "process") return undefined;
    const task = await this.start({
      cwd: scope.cwd,
      sessionId: scope.sessionId,
      command: previous.task.command,
      name: previous.task.name,
      workingDirectory: previous.task.cwd,
    });
    return this.view(await this.session(scope), task);
  }
  /** Every process task of the session, oldest first, including loaded history. */
  async list(scope: TaskScope): Promise<ProcessTaskView[]> {
    const session = await this.session(scope);
    return [...session.tasks.values()]
      .filter((task): task is ProcessTask => task.kind === "process")
      .map((task) => this.view(session, task));
  }

  async get(scope: TaskScope, id: string): Promise<ProcessTaskView | undefined> {
    const session = await this.session(scope);
    const task = session.tasks.get(id);
    return task === undefined || task.kind !== "process" ? undefined : this.view(session, task);
  }

  /** The tail of a task's output. Undefined when the session has no such task. */
  async logs(
    scope: TaskScope,
    id: string,
    options: { lines: number; maxBytes?: number },
  ): Promise<{ view: ProcessTaskView; tail: OutputTail } | undefined> {
    const session = await this.session(scope);
    const task = session.tasks.get(id);
    if (task === undefined || task.kind !== "process") return undefined;
    // Every reader of a task's output comes through here, so one decoder serves
    // `bg_logs`, the panel and a completion notice alike (ADR-0008).
    const tail = await readOutputTail(task.outputPath, { ...options, platform: this.platform });
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
    const session = await this.session(scope);
    const loaded = session.tasks.get(id);
    if (loaded === undefined) return undefined;
    // A record of the loop kind is not this store's to stop.
    if (loaded.kind !== "process") return undefined;
    const task: ProcessTask = loaded;

    const running = session.running.get(id);
    if (running === undefined) {
      return { view: this.view(session, task), outcome: "already-finished", tookMs: 0 };
    }

    // The reason rides with the task, not with the signal: the supervisor only
    // reports whether anything was signalled, the store knows who asked. The
    // first ask wins — a second stop joins the one already in flight instead of
    // relabelling its end.
    if (!session.killReasons.has(id)) session.killReasons.set(id, options.reason ?? "user");
    this.clearRuntimeCap(session, id);
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
    this.clearRuntimeCap(session, task.id);
    // A limit ends the task whether or not a signal reached it: the dropped byte
    // is the end of the story even when the command exits on the same tick.
    const limitReason = session.limitReasons.get(task.id);
    // A stop of our own only counts when a signal actually went out: a task that
    // ended on its own during a stop keeps its natural end instead of becoming
    // a kill.
    const stopReason = running.signalled() ? session.killReasons.get(task.id) : undefined;
    const killReason = limitReason ?? stopReason;
    session.killReasons.delete(task.id);
    session.limitReasons.delete(task.id);
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
    } else if (failure !== undefined) {
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
    // The exit does not wait on the disk; the notification does not either.
    void this.persist(session);
    this.onFinish?.(this.view(session, task));
  }

  /**
   * Stop the task when its runtime cap passes. The stop is the same one the user
   * would ask for, with the reason recorded, so a task that outlived its cap ends
   * `killed` / `timeout` rather than `failed`.
   */
  private scheduleRuntimeCap(
    session: SessionTasks,
    scope: TaskScope,
    id: string,
    timeoutMs: number | undefined,
  ): void {
    if (timeoutMs === undefined) return;
    const timer = setTimeout(() => {
      void this.stop(scope, id, { reason: "timeout" });
    }, timeoutMs);
    // A waiting cap must not be the reason the host process stays alive.
    timer.unref();
    session.runtimeCaps.set(id, timer);
  }

  /** Cancel a task's runtime cap; a task that ends on its own leaves no timer. */
  private clearRuntimeCap(session: SessionTasks, id: string): void {
    const timer = session.runtimeCaps.get(id);
    if (timer !== undefined) clearTimeout(timer);
    session.runtimeCaps.delete(id);
  }

  /**
   * Hand the current records to the store. The store queues its own writes and
   * treats persistence as best effort, so a save never fails a turn and a full
   * disk never fails a task. Callers that need the record durable (a fresh task
   * whose id is about to be handed out) await it; the process exit does not.
   */
  private persist(session: SessionTasks): Promise<void> {
    return this.hub.persist(session);
  }

  private session(scope: TaskScope): Promise<SessionTasks> {
    const directory = sessionTaskDirectory(scope.cwd, scope.sessionId);
    const existing = this.sessions.get(directory);
    if (existing !== undefined) return existing;

    const opened = this.openSession(scope);
    this.sessions.set(directory, opened);
    return opened;
  }

  private async openSession(scope: TaskScope): Promise<SessionTasks> {
    const shared = await this.hub.session(scope);
    // A loaded record carries the output size it was last saved with; the file
    // itself is the truth. Refresh once per process store, even when the loop
    // tools loaded the session first.
    for (const record of [...shared.tasks.values()]) {
      shared.tasks.set(record.id, await this.withCurrentOutput(record));
    }
    return {
      ...shared,
      running: new Map(),
      killReasons: new Map(),
      limitReasons: new Map(),
      runtimeCaps: new Map(),
    };
  }

  /**
   * Resolve the directory this call runs in and make sure it is usable. A
   * relative request is resolved against the session's cwd, the same base the
   * task record uses; without a request the session's cwd is used as it is.
   */
  private async resolveWorkingDirectory(
    sessionCwd: string,
    requested: string | undefined,
  ): Promise<string> {
    const cwd = resolve(sessionCwd, requested ?? ".");
    let isDirectory: boolean;
    try {
      isDirectory = (await stat(cwd)).isDirectory();
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new Error(`Working directory ${cwd} does not exist.`);
      }
      throw new Error(`Working directory ${cwd} cannot be used: ${errorMessage(error)}`);
    }
    if (!isDirectory) {
      throw new Error(`Working directory ${cwd} is not a directory.`);
    }
    return cwd;
  }

  /**
   * A record read from disk carries the output size it was last written with. The
   * file itself is the truth: a crash can lose the last save, not the bytes.
   */
  private async withCurrentOutput(record: Task): Promise<Task> {
    if (record.kind !== "process") return record;
    try {
      const info = await stat(record.outputPath);
      return { ...record, outputBytes: info.size };
    } catch {
      return record;
    }
  }

  private createId(session: SessionTasks): string {
    return this.hub.createId(session);
  }
}
