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
 * Opening, binding and recording an iteration is written out at once, because the
 * record only exists on disk: a reader sees an iteration only after it is written.
 * Closing one is not written here — a settle closes iterations and their loops'
 * schedules together, so the caller writes that one record once (ticket #46).
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { TaskScope } from "../base/runtime-state.js";
import type { PromptLoopTask } from "../base/task.js";
import type { TaskSession, TaskSessions } from "../base/task-sessions.js";
import {
  callErrorText,
  callSubject,
  ITERATION_CALL_LIMIT,
  ITERATION_HISTORY_LIMIT,
  type Iteration,
  type TurnEnd,
  type TurnOutcome,
} from "./iteration.js";
import type { IterationResult, LoopFire } from "./loop-tasks.js";

/** The turn in flight as its own message described it, before the settle. */
interface TurnVerdict {
  /** The session whose run produced the message; a settle of another run is not it. */
  readonly directory: string;
  readonly end: TurnEnd;
  readonly error?: string;
}

/**
 * What one assistant message says about its turn (ticket #46): an error stop is
 * the provider giving up, and every other stop is a turn that ran.
 *
 * The spec names two signals for a fire the provider gave up on —
 * `auto_retry_end` with `success: false`, and a final `stopReason === "error"` —
 * and pi 1.5.2 makes them one: it emits the error message first and then the
 * retry's end, but it does not forward `auto_retry_end` to extensions, so the
 * final message's stop reason is the only observable and covers both cases.
 */
function turnVerdict(attempt: ProviderAttemptEvent): { end: TurnEnd; error?: string } {
  if (attempt.stopReason !== "error") return { end: "healthy" };
  return attempt.errorMessage === undefined
    ? { end: "failed" }
    : { end: "failed", error: attempt.errorMessage };
}

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

/**
 * What one provider attempt of the turn in flight looks like from the outside:
 * the assistant message it ended, and the retry budget the settings allow.
 *
 * pi 1.5.2 forwards no retry event to extensions — `auto_retry_start` and
 * `auto_retry_end` reach public listeners only, and `ExtensionAPI.on` has no
 * retry event to subscribe to — so the attempt is counted from the message that
 * carries the failure (`stopReason === "error"`). The attempt after a failure
 * ends a message too, which is what clears the count.
 */
export interface ProviderAttemptEvent {
  readonly role: string;
  readonly stopReason?: string;
  /** What the provider said; carries the status code when it gave one. */
  readonly errorMessage?: string;
  /** Retries the settings allow; 0 when pi is not retrying, so nothing is counted. */
  readonly maxAttempts: number;
}

/**
 * Retries pi makes after a failed attempt when the settings do not say. pi's
 * `SETTINGS_DEFAULTS` is not exported from the package root, so its default of
 * three is restated here once instead of being spread over the call sites.
 */
export const DEFAULT_RETRY_BUDGET = 3;

/** The retry settings an attempt counter reads; the rest of `Settings` is not its business. */
export interface RetrySettingsLike {
  readonly enabled?: boolean;
  readonly maxRetries?: number;
}

/**
 * Retries pi is configured to make after a failure. Zero — retries disabled, or a
 * budget of zero — means the first failure is final, so no attempt is counted:
 * `retry 1/0` would promise a retry that is never coming.
 */
export function retryBudget(settings: { readonly retry?: RetrySettingsLike } | undefined): number {
  const retry = settings?.retry;
  if (retry?.enabled === false) return 0;
  const maxRetries = retry?.maxRetries;
  if (maxRetries === undefined) return DEFAULT_RETRY_BUDGET;
  return Number.isInteger(maxRetries) && maxRetries >= 1 ? maxRetries : 0;
}

/** The provider status a failure message named, when it named one: `529`. */
function providerStatus(errorMessage: string | undefined): string | undefined {
  if (errorMessage === undefined) return undefined;
  return /\b([45]\d\d)\b/.exec(errorMessage)?.[1];
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
  /**
   * The last word of the turn in flight, waiting for its settle (ticket #46).
   * The assistant message is the only place a turn's outcome is visible, and
   * `settle` is the only event that says the turn is over, so the two facts meet
   * here rather than in the loop record.
   */
  private turn: TurnVerdict | undefined;

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
    this.dropOverflow(task);
    await this.sessions.persist(fire.session);
  }

  /**
   * Bind the iteration to the turn its wake produced: called right after the
   * wake is handed to pi. From here on the turn's tool calls are its own.
   */
  bind(fire: LoopFire): void {
    const iteration = this.resolve(fire.session, fire.task.id, fire.fire);
    if (iteration !== undefined) iteration.bound = true;
  }

  /**
   * Forget a fire that never woke the model — its loop was paused, completed or
   * deleted while the wake waited. The iteration goes with it: a pending record
   * that stays `running` forever would claim a turn that never happened. A bound
   * iteration is left alone: its wake already left for pi, so the turn is real
   * and `settle` owns the record from here on.
   */
  async drop(fire: LoopFire): Promise<void> {
    const task = fire.session.tasks.get(fire.task.id);
    if (task?.kind !== "prompt-loop") return;
    const index = task.iterations.findIndex((iteration) => iteration.fire === fire.fire);
    const found = task.iterations[index];
    if (found === undefined || found.bound === true) return;
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
      if (task.kind !== "prompt-loop") continue;
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
   * Count one provider attempt of the turn in flight against the iteration that
   * opened it (ticket #47). A failed attempt has no event of its own — see
   * `ProviderAttemptEvent` — so it arrives as the assistant message that ended
   * with `stopReason: "error"`, and the attempt after it is what clears the
   * count while the turn is still open.
   *
   * Nothing is counted when the budget is zero: pi gives up at the first failure
   * then, so there is no retry to show.
   */
  async recordAttempt(scope: TaskScope, attempt: ProviderAttemptEvent): Promise<void> {
    if (attempt.role !== "assistant") return;
    const session = await this.sessions.session(scope);
    // The assistant message is the turn's own last word (ticket #46): an error
    // stop is the provider giving up, any other stop is a turn that ran. A later
    // assistant message replaces it, so what is held here is final.
    this.turn = { directory: session.directory, ...turnVerdict(attempt) };
    const iteration = this.newestOpenIteration(session);
    if (iteration === undefined) return;

    if (attempt.stopReason === "error" && attempt.maxAttempts >= 1) {
      const status = providerStatus(attempt.errorMessage);
      iteration.retry = {
        attempt: (iteration.retry?.attempt ?? 0) + 1,
        maxAttempts: attempt.maxAttempts,
        ...(status === undefined ? {} : { status }),
      };
      await this.sessions.persist(session);
      return;
    }

    // The attempt after a failure reached the provider: the turn is retrying no
    // more, but it is still open, so only the retry goes — `settle` ends it.
    if (iteration.retry === undefined) return;
    iteration.retry = undefined;
    await this.sessions.persist(session);
  }

  /**
   * Close every bound iteration still open in the session, because one run
   * settles at a time and a bound fire's turn is that run. Calls still running
   * at that point cannot end any more: `aborted` when the run was aborted,
   * `interrupted` otherwise. Pending iterations stay pending: their wake has not
   * produced a turn yet, so this settle is not theirs.
   *
   * One turn can be several loops' fire — every loop that came due while the agent
   * was busy is bound and delivered before the turn starts — so the caller gets one
   * result per loop that had an iteration closed here, read from that loop's newest
   * one. A loop with two iterations in the same turn is still one fire to charge.
   */
  async settle(scope: TaskScope, aborted: boolean): Promise<IterationResult[]> {
    const session = await this.sessions.session(scope);
    const verdict = this.takeTurn(session.directory);
    const at = this.now();
    // A run that settled without a bound fire belongs to the user, and a stop by
    // the user is not a failed fire (ticket #46). A run nothing was observed about
    // says nothing either way: it is neither a failure nor the healthy round that
    // clears one.
    const end: TurnOutcome = aborted ? "aborted" : (verdict?.end ?? "unobserved");
    const newest = new Map<string, { task: PromptLoopTask; iteration: Iteration }>();
    for (const task of session.tasks.values()) {
      if (task.kind !== "prompt-loop") continue;
      let closed = false;
      for (const iteration of task.iterations) {
        if (iteration.bound !== true || iteration.status !== "running") continue;
        closeIteration(iteration, at, aborted ? "aborted" : "completed");
        const seen = newest.get(task.id);
        if (seen === undefined || iteration.startedAt >= seen.iteration.startedAt) {
          newest.set(task.id, { task, iteration });
        }
        closed = true;
      }
      if (!closed) continue;
      // The turn the loop woke has settled, which is the loop's own change: its
      // row moves on that, not only on the fire that started the turn (ADR-0010).
      task.updatedAt = at;
    }
    if (newest.size === 0) return [];
    return [...newest.values()].map(({ task, iteration }) => ({
      id: task.id,
      fire: iteration.fire,
      end,
      ...(end === "failed" && verdict?.error !== undefined ? { error: verdict.error } : {}),
    }));
  }

  /** Drop the oldest iterations until the history cap holds. */
  private dropOverflow(task: PromptLoopTask): void {
    while (task.iterations.length > this.historyLimit) {
      const oldest = task.iterations.shift();
      if (oldest === undefined) break;
      task.droppedIterations = (task.droppedIterations ?? 0) + 1;
    }
  }

  /**
   * The iteration a start belongs to: the newest open iteration its wake already
   * produced. Read from the session's current records every time, because a loop
   * update replaces the record object and a deleted loop must stop capturing
   * calls. A pending iteration is skipped, not pruned: its turn has not begun,
   * and the current turn belongs to whoever started it.
   */
  private newestOpenIteration(session: TaskSession): Iteration | undefined {
    let newest: Iteration | undefined;
    for (const task of session.tasks.values()) {
      if (task.kind !== "prompt-loop") continue;
      for (const iteration of task.iterations) {
        if (iteration.bound !== true || iteration.status !== "running") continue;
        if (newest === undefined || iteration.startedAt >= newest.startedAt) newest = iteration;
      }
    }
    return newest;
  }

  /**
   * Take the verdict waiting for this session's settle. A verdict from another
   * session belongs to a turn that has not settled yet, so it stays where it is.
   */
  private takeTurn(directory: string): TurnVerdict | undefined {
    const verdict = this.turn;
    if (verdict === undefined || verdict.directory !== directory) return undefined;
    this.turn = undefined;
    return verdict;
  }

  private resolve(session: TaskSession, taskId: string, fire: number): Iteration | undefined {
    const task = session.tasks.get(taskId);
    if (task?.kind !== "prompt-loop") return undefined;
    return task.iterations.find((iteration) => iteration.fire === fire);
  }
}

function closeIteration(iteration: Iteration, at: number, status: "completed" | "aborted"): void {
  iteration.endedAt = at;
  iteration.status = status;
  // This is the turn-ended point ticket #46 shares: nothing is retried once the
  // turn is over, whatever it finally did. #46 decides from its own field
  // whether the turn ended because pi gave up; this one describes flight only.
  iteration.retry = undefined;
  for (const call of iteration.calls) {
    if (call.status !== "running") continue;
    call.endedAt = at;
    call.status = status === "aborted" ? "aborted" : "interrupted";
    call.durationMs = Math.max(0, at - call.startedAt);
  }
}
