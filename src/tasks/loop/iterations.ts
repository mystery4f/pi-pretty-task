/**
 * The recorder that turns pi's tool events into Iteration records (ADR-0002).
 *
 * The extension cannot see the turn itself, only the events pi emits around it,
 * so this class keeps the small amount of state those events need: which fire is
 * still open, in which session. Three rules follow from the event order and are
 * the whole point of the class:
 *
 * - a fire opens a pending iteration; only once its wake is handed to pi does it
 *   bind, and only then does it capture tool calls (ADR-0009);
 * - `agent_settled` closes the bound iterations, never a pending one;
 * - a call is recorded into the newest bound iteration of its session, because
 *   the events carry no loop id, so an unbound iteration — a wake still waiting
 *   for an idle agent — must not take the calls of a turn it did not wake;
 * - `tool_execution_end` pairs by tool call id across every iteration, so a late
 *   result still lands on the call that produced it.
 *
 * Every write is persisted with the loop record, because the record only exists
 * on disk: a reader sees an iteration only after it has been written out.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { TaskScope } from "../base/runtime-state.js";
import type { LoopTask } from "../base/task.js";
import type { TaskSession, TaskSessions } from "../base/task-sessions.js";
import {
  callErrorText,
  callSubject,
  ITERATION_CALL_LIMIT,
  ITERATION_HISTORY_LIMIT,
  type Iteration,
} from "./iteration.js";
import type { LoopFire } from "./loop-tasks.js";

/** The start event's fields the recorder needs; pi passes the same ones. */
export interface ToolCallStartEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
}

/** The end event's fields the recorder needs. */
export interface ToolCallEndEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: unknown;
  readonly isError: boolean;
  readonly durationMs?: number;
}

export interface IterationsOptions {
  readonly sessions: TaskSessions;
  /** Clock seam for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Tool calls kept per iteration; defaults to `ITERATION_CALL_LIMIT`. */
  readonly callLimit?: number;
  /** Iterations kept per loop; defaults to `ITERATION_HISTORY_LIMIT`. */
  readonly historyLimit?: number;
}

/** A fire whose turn has not settled yet, addressed by record rather than by object. */
interface OpenFire {
  readonly directory: string;
  readonly taskId: string;
  readonly fire: number;
  /** False until the wake was handed to pi: a pending fire captures no calls. */
  bound: boolean;
}

/** Both caps are positive counts: a zero would record nothing and say nothing. */
export function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

export class Iterations {
  private readonly sessions: TaskSessions;
  private readonly now: () => number;
  private readonly callLimit: number;
  private readonly historyLimit: number;
  /** Open fires in the order they opened, so the newest is the one a start joins. */
  private readonly openFires: OpenFire[] = [];

  constructor(options: IterationsOptions) {
    this.sessions = options.sessions;
    this.now = options.now ?? Date.now;
    this.callLimit = positiveLimit(options.callLimit, ITERATION_CALL_LIMIT, "iterationCallLimit");
    this.historyLimit = positiveLimit(
      options.historyLimit,
      ITERATION_HISTORY_LIMIT,
      "iterationHistoryLimit",
    );
  }

  /**
   * Open the iteration for one fire and persist it, so a wake that is still
   * waiting for an idle agent — or a turn that ends before its first tool call —
   * still leaves a record. The iteration stays pending: it takes no calls until
   * `bind` marks the wake as sent.
   */
  async open(fire: LoopFire): Promise<void> {
    const task = fire.task;
    const iteration: Iteration = {
      fire: fire.fire,
      startedAt: fire.at,
      status: "running",
      calls: [],
      droppedCalls: 0,
    };
    task.iterations.push(iteration);
    for (const dropped of this.dropOverflow(task))
      this.forget(fire.session.directory, task.id, dropped);
    this.openFires.push({
      directory: fire.session.directory,
      taskId: task.id,
      fire: iteration.fire,
      bound: false,
    });
    await this.sessions.persist(fire.session);
  }

  /**
   * Bind the iteration to the turn its wake produced: called right after the
   * wake is handed to pi. From here on the turn's tool calls are its own.
   */
  bind(fire: LoopFire): void {
    const entry = this.findOpenFire(fire);
    if (entry !== undefined) entry.bound = true;
  }

  /**
   * Forget a fire that never woke the model — its loop was paused, completed or
   * deleted while the wake waited. The iteration goes with it: a pending record
   * that stays `running` forever would claim a turn that never happened. A bound
   * iteration is left alone: its wake already left for pi, so the turn is real
   * and `settle` owns the record from here on.
   */
  async drop(fire: LoopFire): Promise<void> {
    const entry = this.findOpenFire(fire);
    if (entry === undefined || entry.bound) return;
    this.forget(fire.session.directory, fire.task.id, fire.fire);
    const task = fire.session.tasks.get(fire.task.id);
    if (task?.kind !== "loop") return;
    const index = task.iterations.findIndex((iteration) => iteration.fire === fire.fire);
    if (index < 0) return;
    task.iterations.splice(index, 1);
    await this.sessions.persist(fire.session);
  }

  /** Record one tool call's start into the newest open iteration of the session. */
  async recordStart(scope: TaskScope, start: ToolCallStartEvent): Promise<void> {
    const session = await this.sessions.session(scope);
    const iteration = this.newestOpenIteration(session);
    if (iteration === undefined) return;

    iteration.calls.push({
      id: start.toolCallId,
      tool: start.toolName,
      subject: callSubject(start.args),
      startedAt: this.now(),
      status: "running",
    });
    const excess = iteration.calls.length - this.callLimit;
    if (excess > 0) {
      iteration.calls.splice(0, excess);
      iteration.droppedCalls += excess;
    }
    await this.sessions.persist(session);
  }

  /**
   * Record how one tool call ended, found by its id. A call the recorder never
   * saw is ignored: a turn outside a fire is not an iteration, and its calls
   * must not appear in this loop's record.
   */
  async recordEnd(scope: TaskScope, end: ToolCallEndEvent): Promise<void> {
    const session = await this.sessions.session(scope);
    const at = this.now();
    for (const task of session.tasks.values()) {
      if (task.kind !== "loop") continue;
      for (let index = task.iterations.length - 1; index >= 0; index -= 1) {
        const iteration = task.iterations[index];
        const call = iteration?.calls.find(
          (candidate) => candidate.id === end.toolCallId && candidate.status === "running",
        );
        if (call === undefined) continue;
        call.endedAt = at;
        call.status = end.isError ? "failed" : "completed";
        call.durationMs = end.durationMs ?? Math.max(0, at - call.startedAt);
        if (end.isError) call.error = callErrorText(end.result, "the tool reported an error");
        await this.sessions.persist(session);
        return;
      }
    }
  }

  /**
   * Close every bound iteration still open in the session, because one run
   * settles at a time and a bound fire's turn is that run. Calls still running
   * at that point cannot end any more: `aborted` when the run was aborted,
   * `interrupted` otherwise. Pending iterations stay pending: their wake has not
   * produced a turn yet, so this settle is not theirs.
   */
  async settle(scope: TaskScope, aborted: boolean): Promise<void> {
    const session = await this.sessions.session(scope);
    const at = this.now();
    let changed = false;
    for (let index = this.openFires.length - 1; index >= 0; index -= 1) {
      const entry = this.openFires[index];
      if (entry === undefined || entry.directory !== session.directory) continue;
      if (!entry.bound) continue;
      this.openFires.splice(index, 1);
      const iteration = this.resolve(session, entry.taskId, entry.fire);
      if (iteration === undefined || iteration.status !== "running") continue;
      closeIteration(iteration, at, aborted ? "aborted" : "completed");
      // The turn the loop woke has settled, which is the loop's own change: its
      // row moves on that, not only on the fire that started the turn (ADR-0010).
      const owner = session.tasks.get(entry.taskId);
      if (owner?.kind === "loop") owner.updatedAt = at;
      changed = true;
    }
    if (changed) await this.sessions.persist(session);
  }

  /** Drop the oldest iterations until the history cap holds; return their fire numbers. */
  private dropOverflow(task: LoopTask): number[] {
    const dropped: number[] = [];
    while (task.iterations.length > this.historyLimit) {
      const oldest = task.iterations.shift();
      if (oldest === undefined) break;
      dropped.push(oldest.fire);
      task.droppedIterations = (task.droppedIterations ?? 0) + 1;
    }
    return dropped;
  }

  /**
   * The iteration a start belongs to: the newest open iteration that its wake
   * already produced. Resolved through the session's current record every time,
   * because a loop update replaces the record object and a deleted loop must
   * stop capturing calls. A pending iteration is skipped, not pruned: its turn
   * has not begun, and the current turn belongs to whoever started it.
   */
  private newestOpenIteration(session: TaskSession): Iteration | undefined {
    for (let index = this.openFires.length - 1; index >= 0; index -= 1) {
      const entry = this.openFires[index];
      if (entry === undefined || entry.directory !== session.directory) continue;
      const iteration = this.resolve(session, entry.taskId, entry.fire);
      if (iteration === undefined || iteration.status !== "running") {
        this.openFires.splice(index, 1);
        continue;
      }
      if (entry.bound) return iteration;
    }
    return undefined;
  }

  private resolve(session: TaskSession, taskId: string, fire: number): Iteration | undefined {
    const task = session.tasks.get(taskId);
    if (task?.kind !== "loop") return undefined;
    return task.iterations.find((iteration) => iteration.fire === fire);
  }

  private forget(directory: string, taskId: string, fire: number): void {
    const index = this.openFires.findIndex(
      (entry) => entry.directory === directory && entry.taskId === taskId && entry.fire === fire,
    );
    if (index >= 0) this.openFires.splice(index, 1);
  }

  /** The bookkeeping entry for one fire, if it is still open in memory. */
  private findOpenFire(fire: LoopFire): OpenFire | undefined {
    return this.openFires.find(
      (candidate) =>
        candidate.directory === fire.session.directory &&
        candidate.taskId === fire.task.id &&
        candidate.fire === fire.fire,
    );
  }
}

function closeIteration(iteration: Iteration, at: number, status: "completed" | "aborted"): void {
  iteration.endedAt = at;
  iteration.status = status;
  for (const call of iteration.calls) {
    if (call.status !== "running") continue;
    call.endedAt = at;
    call.status = status === "aborted" ? "aborted" : "interrupted";
    call.durationMs = Math.max(0, at - call.startedAt);
  }
}
