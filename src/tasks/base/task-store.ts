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
import type {
  ChainTask,
  CmdLoopTask,
  FireRecord,
  LlmLoopTask,
  ProcessTask,
  Task,
  TaskStatus,
} from "./task.js";

/**
 * On-disk schema version. One version covers every kind; a change that older
 * code could not read any more bumps it.
 *
 * Version 2 added `updatedAt` (ADR-0010). Version 3 split the old `loop` kind
 * into `llm-loop` and reserved `cmd-loop`, so a version 1 or 2 document still
 * loads: a record from before recency takes its own `createdAt`, and an old
 * `loop` reads as an llm loop. Version 4 implemented the `cmd-loop` arm with its
 * fire history and added the parent link a fire child carries. Version 5 adds
 * the `chain` arm and the three statuses its steps use (`waiting`, `skipped`,
 * `stopped`), and separates the parent link from the fire link, so a step can
 * name its chain without claiming to be a fire. Every older version still loads
 * — each one only added arms, fields and statuses, so nothing a reader knew
 * before is spelled differently now — and saving writes version 5.
 */
export const TASK_FILE_VERSION = 5;

/** One session's task records as they are stored. */
export interface TaskFile {
  readonly version: number;
  readonly tasks: readonly Task[];
}

const TASK_STATUSES: readonly TaskStatus[] = [
  // The three a chain's steps reach without ever running (ADR-0013).
  "waiting",
  "stopped",
  "skipped",
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

/** A non-negative whole number, the shape every counter in a loop record has. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The fields every loop arm shares. Both arms check them here, so a cmd loop
 * cannot drift from the schedule rules an llm loop already follows.
 */
function hasLoopFields(value: Record<string, unknown>): boolean {
  if (typeof value.schedule !== "string" || value.schedule.trim().length === 0) return false;
  if (!isCount(value.fires)) return false;
  if (value.maxFires !== undefined && (!isCount(value.maxFires) || value.maxFires < 1))
    return false;
  if (value.nextFireAt !== undefined && !isFiniteNumber(value.nextFireAt)) return false;
  if (value.lastFireAt !== undefined && !isFiniteNumber(value.lastFireAt)) return false;
  if (value.expiresAt !== undefined && !isFiniteNumber(value.expiresAt)) return false;
  if (value.missedFires !== undefined && !isCount(value.missedFires)) return false;
  if (value.consecutiveFailures !== undefined && !isCount(value.consecutiveFailures)) return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  return true;
}

const FIRE_OUTCOMES: readonly FireRecord["outcome"][] = [
  "running",
  "success",
  "failed",
  "skipped",
  "interrupted",
];

/**
 * The fire history of a cmd loop. A record written before the history existed
 * reads as empty; anything malformed invalidates the generation like the rest.
 */
function parseFireHistory(value: unknown): FireRecord[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const fires: FireRecord[] = [];
  for (const entry of value) {
    if (!isObject(entry)) return undefined;
    if (!isCount(entry.fire) || entry.fire < 1) return undefined;
    if (!isFiniteNumber(entry.at)) return undefined;
    if (entry.startedAt !== undefined && !isFiniteNumber(entry.startedAt)) return undefined;
    if (entry.endedAt !== undefined && !isFiniteNumber(entry.endedAt)) return undefined;
    if (!FIRE_OUTCOMES.some((outcome) => outcome === entry.outcome)) return undefined;
    if (
      entry.exitCode !== undefined &&
      entry.exitCode !== null &&
      typeof entry.exitCode !== "number"
    ) {
      return undefined;
    }
    if (entry.durationMs !== undefined && !isFiniteNumber(entry.durationMs)) return undefined;
    if (entry.outputBytes !== undefined && !isCount(entry.outputBytes)) return undefined;
    if (entry.taskId !== undefined && typeof entry.taskId !== "string") return undefined;
    if (entry.error !== undefined && typeof entry.error !== "string") return undefined;
    fires.push(entry as unknown as FireRecord);
  }
  return fires;
}

/**
 * One record, checked for everything shared plus the fields of its arm. Every
 * arm is strict here: a loop record without its schedule, or a cmd loop without
 * its command, is corruption, not an older generation to guess at. `legacyKind`
 * is true only for a version 1 or 2 document, where `loop` still names what is
 * now an llm loop.
 */
function parseTask(value: unknown, legacyKind: boolean): Task | undefined {
  if (!isObject(value)) return undefined;
  // The old kind is translated before the arm checks so the rest of the parser
  // only ever sees the current vocabulary.
  const kind = value.kind === "loop" && legacyKind ? "llm-loop" : value.kind;
  if (typeof value.id !== "string" || value.id.length === 0) return undefined;
  if (typeof value.name !== "string") return undefined;
  if (!isStatus(value.status)) return undefined;
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return undefined;
  if (value.updatedAt !== undefined && !isFiniteNumber(value.updatedAt)) return undefined;
  // A version 1 record predates the field; creating it is then the last thing
  // known to have happened to it (ADR-0010).
  const updatedAt = isFiniteNumber(value.updatedAt) ? value.updatedAt : value.createdAt;
  if (value.endedAt !== undefined && typeof value.endedAt !== "number") return undefined;

  if (kind === "process") {
    if (typeof value.command !== "string") return undefined;
    if (typeof value.cwd !== "string") return undefined;
    if (typeof value.outputPath !== "string") return undefined;
    if (!isFiniteNumber(value.outputBytes) || value.outputBytes < 0) return undefined;
    if (value.pid !== undefined && typeof value.pid !== "number") return undefined;
    if (value.exitCode !== undefined && value.exitCode !== null) {
      if (typeof value.exitCode !== "number") return undefined;
    }
    if (value.error !== undefined && typeof value.error !== "string") return undefined;
    // A child always names its parent, and only a fire child also carries the
    // fire number: a chain step points at its chain and was never a fire
    // (ADR-0013, ADR-0016).
    if (value.fire !== undefined && value.parentId === undefined) return undefined;
    if (value.parentId !== undefined) {
      if (typeof value.parentId !== "string" || value.parentId.length === 0) return undefined;
    }
    if (value.fire !== undefined && (!isCount(value.fire) || value.fire < 1)) return undefined;
    return { ...value, updatedAt } as unknown as ProcessTask;
  }

  if (kind === "llm-loop") {
    if (!hasLoopFields(value)) return undefined;
    if (typeof value.prompt !== "string" || value.prompt.trim().length === 0) return undefined;
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
    return { ...value, kind, updatedAt, iterations } as unknown as Task;
  }

  if (kind === "cmd-loop") {
    if (!hasLoopFields(value)) return undefined;
    if (typeof value.command !== "string" || value.command.trim().length === 0) return undefined;
    if (value.cwd !== undefined && typeof value.cwd !== "string") return undefined;
    if (value.env !== undefined) {
      if (!isObject(value.env)) return undefined;
      for (const entry of Object.values(value.env)) {
        if (typeof entry !== "string") return undefined;
      }
    }
    if (value.wakeOnFailure !== undefined && typeof value.wakeOnFailure !== "boolean") {
      return undefined;
    }
    const fireHistory = parseFireHistory(value.fireHistory);
    if (fireHistory === undefined) return undefined;
    if (
      value.lastExitCode !== undefined &&
      value.lastExitCode !== null &&
      typeof value.lastExitCode !== "number"
    ) {
      return undefined;
    }
    if (value.lastOutputPath !== undefined && typeof value.lastOutputPath !== "string") {
      return undefined;
    }
    if (value.lastOutputBytes !== undefined && !isCount(value.lastOutputBytes)) return undefined;
    return { ...value, kind, updatedAt, fireHistory } as unknown as Task;
  }

  if (kind === "chain") {
    if (!Array.isArray(value.steps)) return undefined;
    const steps: string[] = [];
    for (const step of value.steps) {
      // Ids only: a step is a record of its own, never a copy inside the chain.
      if (typeof step !== "string" || step.length === 0) return undefined;
      steps.push(step);
    }
    // The cursor names a slot in the queue: steps.length means the queue ran out.
    if (!isCount(value.cursor) || value.cursor > steps.length) return undefined;
    if (value.error !== undefined && typeof value.error !== "string") return undefined;
    return { ...value, kind, updatedAt, steps, cursor: value.cursor } as unknown as ChainTask;
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

/**
 * The records of one generation, or `undefined` when the document is unusable.
 * Exported for the retention sweep, which must tell an empty session from an
 * unreadable one but must not repair what it reads.
 */
export function parseTaskFile(text: string): Task[] | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(document)) return undefined;
  // Every earlier version is readable, because each one only added arms, fields
  // and statuses: a version 1 or 2 record takes its own `createdAt` as recency and
  // an old `loop` reads as an llm loop, and versions 3 and 4 are the shapes before
  // cmd loops and before chains. A newer, unknown version cannot be guessed at,
  // so the earlier generation is the safer answer.
  const version = document.version;
  if (!isCount(version) || version < 1 || version > TASK_FILE_VERSION) {
    return undefined;
  }
  if (!Array.isArray(document.tasks)) return undefined;
  // Only a document older than version 3 may still spell the kind `loop`.
  const legacyKind = version < 3;

  const records: Task[] = [];
  for (const entry of document.tasks) {
    const record = parseTask(entry, legacyKind);
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
 * A loop is deliberately left running: it owns no process of its own, so a
 * restart does not end its schedule. An llm loop keeps its status and next-fire
 * time and resumes when the extension starts pumping again. A cmd loop keeps
 * both too, and its in-flight fire is marked interrupted because the child
 * process died with the old pi process. Its Iterations are different — an
 * iteration is one turn, and no turn survives the process that was running it
 * (see {@link interruptIterations}).
 */
function interrupt(record: Task, at: number): Task {
  if (record.kind === "llm-loop") return interruptIterations(record, at);
  if (record.kind === "cmd-loop") return interruptFires(record, at);
  // A chain is settled after every record has been visited, because its ending
  // depends on the steps it holds (see {@link settleOpenChains}).
  if (record.kind === "chain") return record;
  if (record.status !== "running") return record;
  // A restart that ends a record is a state change like any other, so the
  // recency moves with the ending (ADR-0010).
  const interrupted: ProcessTask = { ...record, status: "interrupted", endedAt: at, updatedAt: at };
  delete interrupted.pid;
  return interrupted;
}

/**
 * A chain left running at load ends `interrupted`. The step it had started is
 * already `interrupted` — its process died with the old pi process — so the
 * queue can never move on, and pretending it is still running would leave a
 * reader waiting for a turn nothing will take (ADR-0013).
 *
 * The steps still `waiting` behind the cursor are `stopped`, the same word a
 * user's stop leaves on them: they will never be started. Steps that already
 * ran keep their own endings.
 */
function settleOpenChains(records: readonly Task[], at: number): Task[] {
  const chains = records.filter(
    (record): record is ChainTask => record.kind === "chain" && record.status === "running",
  );
  if (chains.length === 0) return [...records];

  const byId = new Map(records.map((record) => [record.id, record]));
  for (const chain of chains) {
    chain.status = "interrupted";
    chain.endedAt = at;
    chain.updatedAt = at;
    for (const id of chain.steps) {
      const step = byId.get(id);
      if (step === undefined || step.kind !== "process" || step.status !== "waiting") continue;
      step.status = "stopped";
      step.updatedAt = at;
    }
  }
  return [...byId.values()];
}

/**
 * An iteration that still says `running` cannot: the turn that opened it ended
 * with the process that recorded it, since nothing re-attaches to a session.
 * Marking it `interrupted`, and stopping the calls it left running, keeps a
 * reader from seeing work that can never finish.
 */
function interruptIterations(task: LlmLoopTask, at: number): LlmLoopTask {
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
 * A cmd loop survives a restart: its schedule belongs to no process, so it
 * keeps running and fires again. The fire that was in flight does not — the
 * child process is gone with the old pi process (its own record is interrupted
 * by {@link interrupt}), so the loop's copy of that fire is marked interrupted
 * and is never resumed. Marking it ends a fire, so the loop's recency moves.
 */
function interruptFires(task: CmdLoopTask, at: number): CmdLoopTask {
  if (!task.fireHistory.some((fire) => fire.outcome === "running")) return task;
  const fireHistory = task.fireHistory.map((fire) => {
    if (fire.outcome !== "running") return fire;
    return {
      ...fire,
      outcome: "interrupted" as const,
      endedAt: at,
      durationMs: Math.max(0, at - (fire.startedAt ?? at)),
    };
  });
  return { ...task, updatedAt: at, fireHistory };
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
      return settleOpenChains(
        current.records.map((record) => interrupt(record, at)),
        at,
      );
    }

    const previous = await this.readGeneration(previousTaskRecordPath(this.directory));
    if (previous !== undefined) {
      this.lastGeneration = previous.text;
      return settleOpenChains(
        previous.records.map((record) => interrupt(record, at)),
        at,
      );
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
