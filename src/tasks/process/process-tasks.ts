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

import { randomInt } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { type OutputTail, readOutputTail } from "../base/output.js";
import type { TaskScope } from "../base/runtime-state.js";
import { processOutputPath, sessionTaskDirectory } from "../base/runtime-state.js";
import type { ProcessTask, Task } from "../base/task.js";
import { TaskStore } from "../base/task-store.js";
import { type RunningProcess, startProcess } from "./supervisor.js";

export type { TaskScope };

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
}

interface SessionTasks {
  readonly directory: string;
  readonly store: TaskStore;
  /**
   * Every record of the session, both kinds. Process tasks put their own records
   * here; loaded loop records stay in the map so a process-task save never drops
   * them, and the loop kind's tools arrive with its ticket.
   */
  readonly tasks: Map<string, Task>;
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
  /**
   * Keyed by state directory, not session id: the directory already encodes cwd
   * and session, and the promise keeps two turns from loading the same history
   * twice.
   */
  private readonly sessions = new Map<string, Promise<SessionTasks>>();

  constructor(options: ProcessTasksOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env;
    this.now = options.now ?? Date.now;
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

    return task;
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
    void this.persist(session);
  }

  /**
   * Hand the current records to the store. The store queues its own writes and
   * treats persistence as best effort, so a save never fails a turn and a full
   * disk never fails a task. Callers that need the record durable (a fresh task
   * whose id is about to be handed out) await it; the process exit does not.
   */
  private persist(session: SessionTasks): Promise<void> {
    return session.store.save([...session.tasks.values()]);
  }

  private session(scope: TaskScope): Promise<SessionTasks> {
    const directory = sessionTaskDirectory(scope.cwd, scope.sessionId);
    const existing = this.sessions.get(directory);
    if (existing !== undefined) return existing;

    const opened = this.openSession(directory);
    this.sessions.set(directory, opened);
    return opened;
  }

  private async openSession(directory: string): Promise<SessionTasks> {
    await mkdir(directory, { recursive: true });
    const store = new TaskStore(directory, { now: this.now });
    const tasks = new Map<string, Task>();
    for (const record of await store.load()) {
      tasks.set(record.id, await this.withCurrentOutput(record));
    }
    return { directory, store, tasks, running: new Map() };
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
    for (;;) {
      let id = "";
      for (let index = 0; index < ID_LENGTH; index += 1) {
        id += ID_ALPHABET.charAt(randomInt(ID_ALPHABET.length));
      }
      if (!session.tasks.has(id)) return id;
    }
  }
}
