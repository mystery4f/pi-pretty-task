/**
 * The task record file: one session's Task records — both kinds in one
 * document — written atomically and read with a previous-generation fallback.
 *
 * The file is the only place the panel's history comes from after a restart, so
 * it is written for machines and read defensively: anything that does not parse
 * as a record set is corruption, not an exception to throw at the user.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { open, readFile, rename } from "node:fs/promises";
import { previousTaskRecordPath, taskRecordPath } from "./runtime-state.js";
import type { ProcessTask, Task, TaskStatus } from "./task.js";

/**
 * On-disk schema version. One version covers both kinds; a change that older
 * code could not read any more bumps it.
 */
export const TASK_FILE_VERSION = 1;

/** One session's task records as they are stored. */
export interface TaskFile {
  readonly version: number;
  readonly tasks: readonly Task[];
}

const TASK_STATUSES: readonly TaskStatus[] = [
  "running",
  "completed",
  "failed",
  "killed",
  "interrupted",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is TaskStatus {
  return TASK_STATUSES.some((status) => status === value);
}

/**
 * One record, checked for everything shared plus what the process arm needs.
 * The loop arm's own fields are the loop kind's business when it lands; until
 * then this store accepts a loop record on its shared fields alone.
 */
function parseTask(value: unknown): Task | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.id !== "string" || value.id.length === 0) return undefined;
  if (typeof value.name !== "string") return undefined;
  if (!isStatus(value.status)) return undefined;
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return undefined;
  if (value.endedAt !== undefined && typeof value.endedAt !== "number") return undefined;

  if (value.kind === "process") {
    if (typeof value.command !== "string") return undefined;
    if (typeof value.cwd !== "string") return undefined;
    if (typeof value.outputPath !== "string") return undefined;
    if (typeof value.outputBytes !== "number" || !Number.isFinite(value.outputBytes)) {
      return undefined;
    }
    if (value.outputBytes < 0) return undefined;
    if (value.pid !== undefined && typeof value.pid !== "number") return undefined;
    if (value.exitCode !== undefined && value.exitCode !== null) {
      if (typeof value.exitCode !== "number") return undefined;
    }
    if (value.error !== undefined && typeof value.error !== "string") return undefined;
    return value as unknown as ProcessTask;
  }

  if (value.kind === "loop") return value as unknown as Task;

  return undefined;
}

/** The records of one generation, or `undefined` when the document is unusable. */
function parseTaskFile(text: string): Task[] | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(document)) return undefined;
  if (document.version !== TASK_FILE_VERSION) return undefined;
  if (!Array.isArray(document.tasks)) return undefined;

  const records: Task[] = [];
  for (const entry of document.tasks) {
    const record = parseTask(entry);
    // One unreadable record makes the whole generation untrustworthy: the
    // fallback copy is a complete earlier document, not a patch.
    if (record === undefined) return undefined;
    records.push(record);
  }
  return records;
}

function serialize(tasks: readonly Task[]): string {
  const document: TaskFile = { version: TASK_FILE_VERSION, tasks };
  return `${JSON.stringify(document, null, 2)}\n`;
}

interface Generation {
  readonly text: string;
  readonly records: Task[];
}

/** Write one file in a way a reader never sees half of it. */
async function writeAtomic(path: string, data: string): Promise<void> {
  const tempPath = `${path}.tmp`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(data, "utf8");
    // Rename is atomic, but only fsync makes the bytes durable: without it a
    // crash can leave a renamed file whose content never reached the disk.
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
}

/** Everything a caller may tune about the store; production uses the defaults. */
export interface TaskStoreOptions {
  /** Clock seam for tests; dates the records found still running at load. */
  now?: () => number;
}

/**
 * A record can only be `running` while the process that wrote it is alive, and at
 * load time nothing is: this store has just started. Marking it `interrupted` is a
 * statement about the record, never an action on a process — nothing here adopts
 * or signals a pid, and the stale pid is dropped so a later step cannot mistake a
 * reused pid for the old command.
 */
function interrupt(record: Task, at: number): Task {
  if (record.status !== "running") return record;
  const interrupted: Task = { ...record, status: "interrupted", endedAt: at };
  delete interrupted.pid;
  return interrupted;
}

/**
 * The records of one session as files next to its output: `tasks.json` plus the
 * previous generation beside it.
 */
export class TaskStore {
  private readonly directory: string;
  private readonly now: () => number;
  /**
   * The last generation this store read or wrote. On the next write it becomes
   * `.prev`, so the fallback copy is always a document that once parsed.
   */
  private lastGeneration: string | undefined;
  /** Queued writes; each update waits for the one before it. */
  private writes: Promise<void> = Promise.resolve();

  constructor(directory: string, options: TaskStoreOptions = {}) {
    this.directory = directory;
    this.now = options.now ?? Date.now;
  }

  /**
   * Every record the file holds, oldest first, or an empty list before the first
   * write. A corrupt current file falls back to the previous generation; when
   * neither is readable the session simply has no history, and pi keeps running.
   */
  async load(): Promise<Task[]> {
    const at = this.now();
    const current = await this.readGeneration(taskRecordPath(this.directory));
    if (current !== undefined) {
      this.lastGeneration = current.text;
      return current.records.map((record) => interrupt(record, at));
    }

    const previous = await this.readGeneration(previousTaskRecordPath(this.directory));
    if (previous !== undefined) {
      this.lastGeneration = previous.text;
      return previous.records.map((record) => interrupt(record, at));
    }

    this.lastGeneration = undefined;
    return [];
  }

  /**
   * Replace the file with this set of records, keeping the last good generation
   * as `.prev`. Updates are queued, so two writes in a row cannot interleave
   * their temp files and hand each other a half-written document.
   *
   * Persistence is best effort: a full disk must not fail a task that is already
   * running, so a write error is swallowed rather than thrown at the session.
   */
  save(tasks: readonly Task[]): Promise<void> {
    const generation = serialize(tasks);
    this.writes = this.writes.then(() => this.writeGeneration(generation));
    return this.writes;
  }

  private async writeGeneration(generation: string): Promise<void> {
    try {
      if (this.lastGeneration !== undefined && this.lastGeneration !== generation) {
        await writeAtomic(previousTaskRecordPath(this.directory), this.lastGeneration);
      }
      await writeAtomic(taskRecordPath(this.directory), generation);
      this.lastGeneration = generation;
    } catch {
      // The records stay correct in memory; the next write tries again.
    }
  }

  private async readGeneration(path: string): Promise<Generation | undefined> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return undefined;
    }
    const records = parseTaskFile(text);
    return records === undefined ? undefined : { text, records };
  }
}
