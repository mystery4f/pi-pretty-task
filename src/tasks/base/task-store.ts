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
import type {
  Iteration,
  IterationCall,
  IterationCallStatus,
  IterationStatus,
} from "../loop/iteration.js";
import { previousTaskRecordPath, taskRecordPath } from "./runtime-state.js";
import type { LoopTask, ProcessTask, Task, TaskStatus } from "./task.js";

/**
 * On-disk schema version. One version covers both kinds; a change that older
 * code could not read any more bumps it.
 *
 * Version 2 added `updatedAt` (ADR-0010). A version 1 document still loads: a
 * record from before the field takes its own `createdAt` as the recency, which
 * is the newest change anyone can prove, and the next save writes version 2.
 */
export const TASK_FILE_VERSION = 2;

/** One session's task records as they are stored. */
export interface TaskFile {
  readonly version: number;
  readonly tasks: readonly Task[];
}

const TASK_STATUSES: readonly TaskStatus[] = [
  "running",
  "paused",
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
 * One record, checked for everything shared plus the fields of its arm. Both
 * arms are strict here: a loop record without its schedule or prompt is
 * corruption, not an older generation to guess at.
 */
function parseTask(value: unknown): Task | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.id !== "string" || value.id.length === 0) return undefined;
  if (typeof value.name !== "string") return undefined;
  if (!isStatus(value.status)) return undefined;
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return undefined;
  if (value.updatedAt !== undefined && !isFiniteNumber(value.updatedAt)) return undefined;
  // A version 1 record predates the field; creating it is then the last thing
  // known to have happened to it (ADR-0010).
  const updatedAt = isFiniteNumber(value.updatedAt) ? value.updatedAt : value.createdAt;
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
    return { ...value, updatedAt } as unknown as ProcessTask;
  }

  if (value.kind === "loop") {
    if (typeof value.schedule !== "string" || value.schedule.trim().length === 0) return undefined;
    if (typeof value.prompt !== "string" || value.prompt.trim().length === 0) return undefined;
    if (typeof value.fires !== "number" || !Number.isInteger(value.fires) || value.fires < 0) {
      return undefined;
    }
    if (value.maxFires !== undefined) {
      if (
        typeof value.maxFires !== "number" ||
        !Number.isInteger(value.maxFires) ||
        value.maxFires < 1
      ) {
        return undefined;
      }
    }
    if (value.nextFireAt !== undefined) {
      if (typeof value.nextFireAt !== "number" || !Number.isFinite(value.nextFireAt))
        return undefined;
    }
    if (value.lastFireAt !== undefined) {
      if (typeof value.lastFireAt !== "number" || !Number.isFinite(value.lastFireAt))
        return undefined;
    }
    if (value.expiresAt !== undefined) {
      if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt))
        return undefined;
    }
    if (value.error !== undefined && typeof value.error !== "string") return undefined;
    const iterations = parseIterations(value.iterations);
    if (iterations === undefined) return undefined;
    const droppedIterations = value.droppedIterations;
    if (
      droppedIterations !== undefined &&
      (typeof droppedIterations !== "number" ||
        !Number.isInteger(droppedIterations) ||
        droppedIterations < 0)
    ) {
      return undefined;
    }
    return { ...value, updatedAt, iterations } as unknown as Task;
  }

  return undefined;
}

const ITERATION_STATUSES: readonly IterationStatus[] = [
  "running",
  "completed",
  "aborted",
  "interrupted",
];

const ITERATION_CALL_STATUSES: readonly IterationCallStatus[] = [
  "running",
  "completed",
  "failed",
  "aborted",
  "interrupted",
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The iteration list of a loop record. A record written before iterations
 * existed has no list and reads as empty; anything else is checked as strictly as
 * the rest of the file, because an iteration with a broken call list is
 * corruption rather than an older generation.
 */
function parseIterations(value: unknown): Iteration[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const iterations: Iteration[] = [];
  for (const entry of value) {
    const iteration = parseIteration(entry);
    if (iteration === undefined) return undefined;
    iterations.push(iteration);
  }
  return iterations;
}

function parseIteration(value: unknown): Iteration | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.fire !== "number" || !Number.isInteger(value.fire) || value.fire < 1) {
    return undefined;
  }
  if (!isFiniteNumber(value.startedAt)) return undefined;
  if (value.endedAt !== undefined && !isFiniteNumber(value.endedAt)) return undefined;
  if (!ITERATION_STATUSES.some((status) => status === value.status)) return undefined;
  if (
    typeof value.droppedCalls !== "number" ||
    !Number.isInteger(value.droppedCalls) ||
    value.droppedCalls < 0
  ) {
    return undefined;
  }
  if (!Array.isArray(value.calls)) return undefined;
  const calls: IterationCall[] = [];
  for (const entry of value.calls) {
    const call = parseIterationCall(entry);
    if (call === undefined) return undefined;
    calls.push(call);
  }
  return { ...value, calls } as unknown as Iteration;
}

function parseIterationCall(value: unknown): IterationCall | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.id !== "string" || value.id.length === 0) return undefined;
  if (typeof value.tool !== "string" || value.tool.length === 0) return undefined;
  if (typeof value.subject !== "string") return undefined;
  if (!isFiniteNumber(value.startedAt)) return undefined;
  if (value.endedAt !== undefined && !isFiniteNumber(value.endedAt)) return undefined;
  if (value.durationMs !== undefined && !isFiniteNumber(value.durationMs)) return undefined;
  if (value.error !== undefined && typeof value.error !== "string") return undefined;
  if (!ITERATION_CALL_STATUSES.some((status) => status === value.status)) return undefined;
  return value as unknown as IterationCall;
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
  // Version 1 is readable because its records only lack `updatedAt`, which
  // `parseTask` fills from `createdAt`; any other version may mean something
  // this code cannot see, and the earlier generation is the safer answer.
  if (document.version !== 1 && document.version !== TASK_FILE_VERSION) return undefined;
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
 * A process record can only be `running` while the process that wrote it is
 * alive, and at load time nothing is: this store has just started. Marking it
 * `interrupted` is a statement about the record, never an action on a process —
 * nothing here adopts or signals a pid, and the stale pid is dropped so a later
 * step cannot mistake a reused pid for the old command.
 *
 * A loop record is deliberately left alone: a loop owns no process, so restart
 * does not end it. It keeps its status and next-fire time and resumes when the
 * extension starts pumping again. Its Iterations are different — an iteration is
 * one turn, and no turn survives the process that was running it (see
 * {@link interruptIterations}).
 */
function interrupt(record: Task, at: number): Task {
  if (record.kind === "loop") return interruptIterations(record, at);
  if (record.status !== "running") return record;
  // A restart that ends a record is a state change like any other, so the
  // recency moves with the ending (ADR-0010).
  const interrupted: ProcessTask = { ...record, status: "interrupted", endedAt: at, updatedAt: at };
  delete interrupted.pid;
  return interrupted;
}

/**
 * An iteration that still says `running` cannot: the turn that opened it ended
 * with the process that recorded it, since nothing re-attaches to a session.
 * Marking it `interrupted`, and stopping the calls it left running, keeps a
 * reader from seeing work that can never finish.
 */
function interruptIterations(task: LoopTask, at: number): LoopTask {
  if (!task.iterations.some((iteration) => iteration.status === "running")) return task;
  const iterations = task.iterations.map((iteration) => {
    if (iteration.status !== "running") return iteration;
    return {
      ...iteration,
      status: "interrupted" as const,
      endedAt: at,
      calls: iteration.calls.map((call) =>
        call.status === "running"
          ? {
              ...call,
              status: "interrupted" as const,
              endedAt: at,
              durationMs: Math.max(0, at - call.startedAt),
            }
          : call,
      ),
    };
  });
  // The interrupted turns ended with this restart: that is the loop's newest
  // change, so its row moves up like any other ending (ADR-0010).
  return { ...task, updatedAt: at, iterations };
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
