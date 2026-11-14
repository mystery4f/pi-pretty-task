/**
 * The chain-task store: the queue that turns a series of commands into one task
 * (ADR-0013). A chain holds step ids and a cursor; the steps are ordinary process
 * tasks that run one at a time. This store decides whose turn it is and reads every
 * outcome from the step's own record, so nothing about a step lives in two places
 * (ADR-0014).
 *
 * The chain is a Task like any other: same file, same status vocabulary, same id
 * namespace. What it adds is an order and a place to stand in it.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { TaskScope } from "../base/runtime-state.js";
import type { ChainTask, ProcessTask, Task } from "../base/task.js";
import { type TaskSession, TaskSessions } from "../base/task-sessions.js";
import type {
  ProcessTaskView,
  StartProcessTaskInput,
  StopTaskOptions,
  StopTaskResult,
} from "../process/process-tasks.js";

/** What a chain needs from the process store: queue a step, run it, stop it. */
export interface StepRunner {
  queueStep(input: StartProcessTaskInput): Promise<ProcessTask>;
  launch(session: TaskSession, id: string): Promise<ProcessTask | undefined>;
  stop(
    scope: TaskScope,
    id: string,
    options?: StopTaskOptions,
  ): Promise<StopTaskResult | undefined>;
}

/**
 * One step's start, minus what a chain supplies itself. The chain owns the link and
 * the session; the caller owns the command and how it should run.
 */
export type QueueStepInput = Omit<StartProcessTaskInput, "cwd" | "sessionId" | "parentId" | "fire">;

/** A chain as it looks right now: the record, plus the time it has been alive. */
export interface ChainTaskView {
  task: ChainTask;
  /** Milliseconds from creation to end, or to now while it runs. */
  elapsedMs: number;
}

/** The answer to queueing a step: the queue it joined and the step itself. */
export interface QueuedStep {
  /** The chain the step joined; a fresh one when the anchor was a task of no chain. */
  chain: ChainTask;
  /** The step record: `waiting`, carrying the chain's id in `parentId`. */
  step: ProcessTask;
}

/** How a chain stop answered. */
export interface StopChainResult {
  /** The chain after the stop. */
  view: ChainTaskView;
  outcome: "stopped" | "already-finished";
  /** The step that was running, as it ended: stopped, and no longer the cursor's job. */
  step?: ProcessTaskView;
}

export interface ChainTasksOptions {
  /**
   * The store that runs the steps. A getter, because the two stores are built
   * together: the process store reports every end back into this one.
   */
  processes: () => StepRunner;
  /** Shared session loader; the same instance every other store is given. */
  sessions?: TaskSessions;
  /** Clock seam for tests; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Called once when a chain reaches a final status. A step's end is announced by
   * the process store as it always was; this is the queue's own, coarser ending.
   */
  onFinish?: (view: ChainTaskView) => void;
}

/**
 * The statuses a chain never leaves. A completed chain may still take another step;
 * these may not, because their skipped steps are history a reader was told about.
 */
const ENDED_STATUSES = new Set(["failed", "killed", "interrupted"]);

export class ChainTasks {
  private readonly processes: () => StepRunner;
  private readonly sessions: TaskSessions;
  private readonly now: () => number;
  private readonly onFinish: ((view: ChainTaskView) => void) | undefined;

  constructor(options: ChainTasksOptions) {
    this.processes = options.processes;
    this.now = options.now ?? Date.now;
    this.sessions = options.sessions ?? new TaskSessions({ now: this.now });
    this.onFinish = options.onFinish;
  }

  /**
   * Queue a step behind a task or a chain (ADR-0013). The anchor may be a chain, a
   * step of one, or a process task of no chain — the last is adopted into a new
   * chain, so "queue behind this" always names a queue afterwards and a task that
   * belongs to no chain is never shown as a chain of one. The step record exists,
   * `waiting`, before this returns, and starts when the cursor reaches it.
   */
  async enqueue(scope: TaskScope, after: string, input: QueueStepInput): Promise<QueuedStep> {
    const session = await this.sessions.session(scope);
    const anchor = session.tasks.get(after);
    if (anchor === undefined) throw new Error(`No background task with id ${after}.`);

    const chain = await this.chainOf(session, anchor);
    const step = await this.processes().queueStep({
      ...input,
      cwd: scope.cwd,
      sessionId: scope.sessionId,
      parentId: chain.id,
    });
    chain.steps.push(step.id);
    chain.updatedAt = this.now();
    // The queue reaches the disk before the step can start: an append must never be
    // lost while the step it added is already running.
    await this.sessions.persist(session);
    await this.advanceChain(session, chain);
    return { chain, step };
  }

  /**
   * Move a chain along after one of its steps ended. Called for every process task
   * that ends; a task of no chain, and a loop's fire, are not this store's business.
   */
  async advance(step: ProcessTaskView): Promise<void> {
    const { parentId } = step.task;
    if (parentId === undefined) return;
    const session = await this.sessionOf(parentId);
    if (session === undefined) return;
    const chain = session.tasks.get(parentId);
    // A fire's parent is a loop: only a chain has a queue to move.
    if (chain === undefined || chain.kind !== "chain") return;
    await this.advanceChain(session, chain);
  }

  /** Every chain of the session, oldest first, including loaded history. */
  async list(scope: TaskScope): Promise<ChainTaskView[]> {
    const session = await this.sessions.session(scope);
    return [...session.tasks.values()]
      .filter((task): task is ChainTask => task.kind === "chain")
      .map((task) => this.view(task));
  }

  /** One chain by id. Undefined when the session has no such chain. */
  async get(scope: TaskScope, id: string): Promise<ChainTaskView | undefined> {
    const session = await this.sessions.session(scope);
    const task = session.tasks.get(id);
    return task === undefined || task.kind !== "chain" ? undefined : this.view(task);
  }

  /**
   * Stop a chain: the step at the cursor is stopped through the process store, and
   * every step still waiting is marked `stopped` — not `skipped`, because the queue
   * did not fail, the user ended it (ADR-0013). Undefined when the session has no
   * such chain; a chain that already ended is answered, not stopped twice.
   */
  async stop(
    scope: TaskScope,
    id: string,
    options: StopTaskOptions = {},
  ): Promise<StopChainResult | undefined> {
    const session = await this.sessions.session(scope);
    const task = session.tasks.get(id);
    if (task === undefined || task.kind !== "chain") return undefined;
    const chain = task;
    if (chain.status !== "running") {
      return { view: this.view(chain), outcome: "already-finished" };
    }

    const at = this.now();
    const runningId = chain.steps[chain.cursor];
    // The queue is settled before the step is signalled: the step's end arrives back
    // in `advance`, and a chain that still said `running` would start the next step
    // while the user is stopping it.
    chain.status = "killed";
    chain.killReason = "user";
    chain.endedAt = at;
    chain.updatedAt = at;
    await this.sessions.persist(session);

    let step: ProcessTaskView | undefined;
    if (runningId !== undefined) {
      const stopped = await this.processes().stop(scope, runningId, options);
      if (stopped !== undefined) step = stopped.view;
    }
    // Everything that never got its turn is told so: a reader can see how far the
    // queue got without opening the steps one by one.
    for (const stepId of chain.steps) {
      const waiting = session.tasks.get(stepId);
      if (waiting === undefined || waiting.kind !== "process" || waiting.status !== "waiting") {
        continue;
      }
      waiting.status = "stopped";
      waiting.endedAt = at;
      waiting.updatedAt = at;
    }
    await this.sessions.persist(session);
    this.onFinish?.(this.view(chain));

    return {
      view: this.view(chain),
      outcome: "stopped",
      ...(step === undefined ? {} : { step }),
    };
  }

  /**
   * The queue's next decision, taken at the cursor: launch the step whose turn it
   * is, or settle the chain. A new chain, a chain whose step just ended, and a chain
   * the user just appended to all arrive here, so one rule covers every arrival.
   */
  private async advanceChain(session: TaskSession, chain: ChainTask): Promise<void> {
    for (;;) {
      if (chain.status !== "running") return;
      const id = chain.steps[chain.cursor];
      if (id === undefined) {
        // The queue ran out: every step it held ended with exit 0.
        await this.end(session, chain, "completed");
        return;
      }
      const step = session.tasks.get(id);
      if (step === undefined || step.kind !== "process") {
        await this.end(
          session,
          chain,
          "failed",
          `step ${id} is not a process task of this session`,
        );
        return;
      }
      if (step.status === "waiting") {
        // The cursor reached a step that never started: its turn is now. The launch
        // books the end, which comes back through `advance`; one step at a time.
        await this.processes().launch(session, id);
        return;
      }
      if (step.endedAt === undefined) return;
      if (step.status !== "completed") {
        const outcome = step.error ?? `ended ${step.status}`;
        await this.end(session, chain, "failed", `step ${id} ${outcome}`);
        return;
      }
      chain.cursor += 1;
      chain.updatedAt = this.now();
      // The cursor reaches the disk before the next step starts: a restart between
      // the two must not run the same step again.
      await this.sessions.persist(session);
    }
  }

  /**
   * End a chain, and tell every step that never got its turn why it did not run: a
   * failure skips the rest, and each skipped step names the queue and the step that
   * stopped it (ADR-0013).
   */
  private async end(
    session: TaskSession,
    chain: ChainTask,
    status: "completed" | "failed",
    error?: string,
  ): Promise<void> {
    const at = this.now();
    chain.status = status;
    chain.endedAt = at;
    chain.updatedAt = at;
    if (error !== undefined) chain.error = error;
    if (status === "failed") {
      for (const id of chain.steps.slice(chain.cursor + 1)) {
        const step = session.tasks.get(id);
        if (step === undefined || step.kind !== "process" || step.status !== "waiting") continue;
        step.status = "skipped";
        step.endedAt = at;
        step.updatedAt = at;
        step.error = `parent ${chain.id} did not succeed: ${error ?? "a step failed"}`;
      }
    }
    await this.sessions.persist(session);
    this.onFinish?.(this.view(chain));
  }

  /**
   * The chain an anchor belongs to, adopting a task of no chain into a fresh one.
   * The adoption is what makes `after: <taskId>` mean the same thing as
   * `after: <chainId>` a moment later, without inventing a second kind of queue.
   */
  private async chainOf(session: TaskSession, anchor: Task): Promise<ChainTask> {
    if (anchor.kind === "chain") {
      this.revive(anchor);
      return anchor;
    }
    if (anchor.kind !== "process") {
      throw new Error(`Only process tasks can be queued: ${anchor.id} is a ${anchor.kind}.`);
    }
    if (anchor.parentId !== undefined) {
      const parent = session.tasks.get(anchor.parentId);
      if (parent === undefined || parent.kind !== "chain") {
        throw new Error(
          `Only process tasks can be queued: ${anchor.id} belongs to ${anchor.parentId}, which is not a chain.`,
        );
      }
      this.revive(parent);
      return parent;
    }

    // A task of no chain is adopted as the first step: the user asked for a queue
    // behind it, and a queue needs an addressable row of its own.
    const at = this.now();
    const chain: ChainTask = {
      id: this.sessions.createId(session, "chain"),
      kind: "chain",
      name: anchor.name,
      status: "running",
      createdAt: at,
      updatedAt: at,
      steps: [anchor.id],
      cursor: 0,
    };
    anchor.parentId = chain.id;
    anchor.updatedAt = at;
    session.tasks.set(chain.id, chain);
    await this.sessions.persist(session);
    return chain;
  }

  /**
   * A finished chain may take another step — a successful queue is a thing one can
   * extend — but a chain that failed or was stopped may not: its skipped steps are
   * history, and reviving it would quietly run work the reader was told was lost.
   */
  private revive(chain: ChainTask): void {
    if (ENDED_STATUSES.has(chain.status)) {
      throw new Error(
        `Chain ${chain.id} already ended ${chain.status}; queue behind a running chain or a task of no chain instead.`,
      );
    }
    if (chain.status === "completed") {
      // The queue ran out earlier; the step being appended becomes the next one.
      chain.status = "running";
      chain.updatedAt = this.now();
      delete chain.endedAt;
      delete chain.error;
    }
  }

  /** The loaded session that holds a record, without loading anything new. */
  private async sessionOf(id: string): Promise<TaskSession | undefined> {
    for (const session of await this.sessions.loaded()) {
      if (session.tasks.has(id)) return session;
    }
    return undefined;
  }

  private view(chain: ChainTask): ChainTaskView {
    const endedAt = chain.endedAt ?? this.now();
    return { task: chain, elapsedMs: Math.max(0, endedAt - chain.createdAt) };
  }
}
