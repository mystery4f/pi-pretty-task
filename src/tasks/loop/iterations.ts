/**
 * The recorder that turns pi's tool events into Iteration records (ADR-0002).
 *
 * The extension cannot see the turn itself, only the events pi emits around it,
 * so this class keeps the small amount of state those events need: which fire is
 * still open, in which session. Three rules follow from the event order and are
 * the whole point of the class:
 *
 * - a fire opens the iteration, and `agent_settled` closes it;
 * - a call is recorded into the newest open iteration of its session, because the
 *   events carry no loop id;
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
   * Open the iteration for one fire and persist it before the wake message is
   * sent, so a turn that ends before its first tool call still leaves a record.
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
    for (const dropped of this.dropOverflow(task)) this.forget(task.id, dropped);
    this.openFires.push({
      directory: fire.session.directory,
      taskId: task.id,
      fire: iteration.fire,
    });
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
   * Close every iteration still open in the session, because one run settles at a
   * time and a fire's turn is that run. Calls still running at that point cannot
   * end any more: `aborted` when the run was aborted, `interrupted` otherwise.
   */
  async settle(scope: TaskScope, aborted: boolean): Promise<void> {
    const session = await this.sessions.session(scope);
    const at = this.now();
    let changed = false;
    for (let index = this.openFires.length - 1; index >= 0; index -= 1) {
      const entry = this.openFires[index];
      if (entry === undefined || entry.directory !== session.directory) continue;
      this.openFires.splice(index, 1);
      const iteration = this.resolve(session, entry.taskId, entry.fire);
      if (iteration === undefined || iteration.status !== "running") continue;
      closeIteration(iteration, at, aborted ? "aborted" : "completed");
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
   * The iteration a start belongs to. Resolved through the session's current
   * record every time: a loop update replaces the record object, and a deleted
   * loop must stop capturing calls.
   */
  private newestOpenIteration(session: TaskSession): Iteration | undefined {
    for (let index = this.openFires.length - 1; index >= 0; index -= 1) {
      const entry = this.openFires[index];
      if (entry === undefined || entry.directory !== session.directory) continue;
      const iteration = this.resolve(session, entry.taskId, entry.fire);
      if (iteration !== undefined && iteration.status === "running") return iteration;
      this.openFires.splice(index, 1);
    }
    return undefined;
  }

  private resolve(session: TaskSession, taskId: string, fire: number): Iteration | undefined {
    const task = session.tasks.get(taskId);
    if (task?.kind !== "loop") return undefined;
    return task.iterations.find((iteration) => iteration.fire === fire);
  }

  private forget(taskId: string, fire: number): void {
    const index = this.openFires.findIndex(
      (entry) => entry.taskId === taskId && entry.fire === fire,
    );
    if (index >= 0) this.openFires.splice(index, 1);
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
