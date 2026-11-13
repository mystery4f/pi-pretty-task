/**
 * Loop tasks: the schedule store, the pump that turns a due schedule into a
 * wake-up, and the pause/resume/complete/delete transitions.
 *
 * A loop is a {@link LoopTask} record like a process task is a {@link ProcessTask};
 * both live in one session record file through {@link TaskSessions}. Nothing here
 * starts a timer or a process. The caller owns the clock and calls {@link LoopTasks.pump}
 * with the instant it wants handled, which is what lets tests push a fake clock.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { TaskScope } from "../base/runtime-state.js";
import type { LoopTask } from "../base/task.js";
import type { TaskSession, TaskSessions } from "../base/task-sessions.js";
import { parseDurationMs, parseSchedule } from "./schedule.js";

/** One due wake-up; the caller sends its prompt into the session. */
export interface LoopFire {
  readonly task: LoopTask;
  /** Epoch ms the pump handled the fire at. */
  readonly at: number;
  /** One-based fire number, already recorded on the task. */
  readonly fire: number;
}

export interface CreateLoopInput extends TaskScope {
  /** Raw recurrence text, currently interval shorthand such as `30s`, `10m`, `2h`. */
  schedule: string;
  prompt: string;
  name?: string;
  /** Stop after this many fires; omitted means no limit. */
  maxFires?: number;
  /** Stop at this much time after creation, in the same shorthand. */
  expiresIn?: string;
}

/** A loop as the tools and the panel read it. */
export interface LoopTaskView {
  readonly task: LoopTask;
  /** Time left before the next fire; absent while paused or finished. */
  readonly untilNextFireMs?: number;
}

export type LoopUpdateAction = "pause" | "resume" | "complete";

export type LoopUpdateOutcome =
  | "paused"
  | "resumed"
  | "completed"
  | "already-paused"
  | "already-running"
  | "already-completed"
  | "completed-at-limit"
  | "completed-expired"
  | "failed";

export interface LoopUpdateResult {
  readonly view: LoopTaskView;
  readonly outcome: LoopUpdateOutcome;
}

/** A loop input the user can correct; the message is meant to be shown as-is. */
export class LoopInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopInputError";
  }
}

/** The session limit from the product scope. Finished loops do not count. */
export const MAX_LOOPS = 50;

/** Same rule and limit as process task names. */
const NAME_LIMIT = 48;

export interface LoopTasksOptions {
  readonly sessions: TaskSessions;
  /** Clock seam for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Called once per due fire, after the record with its new count is persisted. */
  readonly onFire?: (fire: LoopFire) => void;
}

/** First line of the prompt, collapsed and capped, so a loop has a readable name. */
function deriveLoopName(prompt: string): string {
  const collapsed = (prompt.split("\n", 1)[0] ?? "").trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return "loop";
  if (collapsed.length <= NAME_LIMIT) return collapsed;
  return `${collapsed.slice(0, NAME_LIMIT - 1)}…`;
}

export class LoopTasks {
  private readonly sessions: TaskSessions;
  private readonly now: () => number;
  private readonly onFire: ((fire: LoopFire) => void) | undefined;

  constructor(options: LoopTasksOptions) {
    this.sessions = options.sessions;
    this.now = options.now ?? Date.now;
    this.onFire = options.onFire;
  }

  /** Load the session so the pump sees it even before the first loop-tool call. */
  async attach(scope: TaskScope): Promise<void> {
    await this.sessions.session(scope);
  }

  async create(input: CreateLoopInput): Promise<LoopTaskView> {
    const recurrence = parseSchedule(input.schedule);
    if (recurrence === undefined) {
      throw new LoopInputError(
        `Invalid schedule "${input.schedule.trim()}": use a whole number followed by s, m or h, for example 30s, 10m or 2h.`,
      );
    }

    const prompt = input.prompt.trim();
    if (prompt.length === 0) {
      throw new LoopInputError(
        "A loop needs a prompt: the text sent into the session each time it fires.",
      );
    }

    if (input.maxFires !== undefined && (!Number.isInteger(input.maxFires) || input.maxFires < 1)) {
      throw new LoopInputError(
        `Invalid maxFires ${String(input.maxFires)}: use a whole number of at least 1.`,
      );
    }

    let expiresAt: number | undefined;
    if (input.expiresIn !== undefined) {
      const duration = parseDurationMs(input.expiresIn);
      if (duration === undefined) {
        throw new LoopInputError(
          `Invalid expiresIn "${input.expiresIn}": use a whole number followed by s, m or h, for example 30s, 10m or 2h.`,
        );
      }
      expiresAt = this.now() + duration;
    }

    const session = await this.sessions.session(input);
    const active = [...session.tasks.values()].filter(
      (task) => task.kind === "loop" && (task.status === "running" || task.status === "paused"),
    );
    if (active.length >= MAX_LOOPS) {
      throw new LoopInputError(
        `This session already has ${String(MAX_LOOPS)} active loop tasks; complete or delete one with loop_delete before creating another.`,
      );
    }

    const createdAt = this.now();
    const nextFireAt = recurrence.nextFire(createdAt);
    if (nextFireAt === null) {
      throw new LoopInputError(`Schedule "${recurrence.expression}" has no next fire time.`);
    }

    const name = input.name?.trim();
    const task: LoopTask = {
      id: this.sessions.createId(session),
      kind: "loop",
      name: name !== undefined && name.length > 0 ? name : deriveLoopName(prompt),
      status: "running",
      createdAt,
      schedule: recurrence.expression,
      prompt,
      fires: 0,
      nextFireAt,
      ...(input.maxFires !== undefined ? { maxFires: input.maxFires } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };

    session.tasks.set(task.id, task);
    await this.sessions.persist(session);
    return this.view(task);
  }

  /** Loops of the session, in record order, finished ones included as history. */
  async list(scope: TaskScope): Promise<LoopTaskView[]> {
    const session = await this.sessions.session(scope);
    return [...session.tasks.values()]
      .filter((task) => task.kind === "loop")
      .map((task) => this.view(task));
  }

  async get(scope: TaskScope, id: string): Promise<LoopTaskView | undefined> {
    const session = await this.sessions.session(scope);
    const task = this.findLoop(session, id);
    return task === undefined ? undefined : this.view(task);
  }

  async update(
    scope: TaskScope,
    id: string,
    action: LoopUpdateAction,
  ): Promise<LoopUpdateResult | undefined> {
    const session = await this.sessions.session(scope);
    const task = this.findLoop(session, id);
    if (task === undefined) return undefined;

    const now = this.now();
    let outcome: LoopUpdateOutcome;
    let changed = false;

    switch (action) {
      case "pause":
        if (task.status === "paused") {
          outcome = "already-paused";
        } else if (task.status !== "running") {
          outcome = "already-completed";
        } else {
          task.status = "paused";
          delete task.nextFireAt;
          outcome = "paused";
          changed = true;
        }
        break;

      case "resume":
        if (task.status === "running") {
          outcome = "already-running";
        } else if (task.status !== "paused") {
          outcome = "already-completed";
        } else if (task.maxFires !== undefined && task.fires >= task.maxFires) {
          this.finish(task, now, "completed");
          outcome = "completed-at-limit";
          changed = true;
        } else if (task.expiresAt !== undefined && now >= task.expiresAt) {
          this.finish(task, now, "completed");
          outcome = "completed-expired";
          changed = true;
        } else {
          const recurrence = parseSchedule(task.schedule);
          if (recurrence === undefined) {
            task.status = "failed";
            task.error = `invalid schedule "${task.schedule}"`;
            task.endedAt = now;
            delete task.nextFireAt;
            outcome = "failed";
            changed = true;
          } else {
            const nextFireAt = recurrence.nextFire(now);
            if (nextFireAt === null) {
              this.finish(task, now, "completed");
              outcome = "completed";
            } else {
              task.status = "running";
              task.nextFireAt = nextFireAt;
              outcome = "resumed";
            }
            changed = true;
          }
        }
        break;

      case "complete":
        if (task.status === "running" || task.status === "paused") {
          this.finish(task, now, "completed");
          outcome = "completed";
          changed = true;
        } else {
          outcome = "already-completed";
        }
        break;
    }

    if (changed) await this.sessions.persist(session);
    return { view: this.view(task), outcome };
  }

  async delete(scope: TaskScope, id: string): Promise<LoopTaskView | undefined> {
    const session = await this.sessions.session(scope);
    const task = this.findLoop(session, id);
    if (task === undefined) return undefined;
    const view = this.view(task);
    session.tasks.delete(task.id);
    await this.sessions.persist(session);
    return view;
  }

  /**
   * Handle every loop whose next fire is due at `at`, across every session this
   * extension has loaded. Each due loop fires at most once per call: a pump that
   * arrives late drops the missed fires instead of replaying them in a storm.
   * The new count is persisted before `onFire` is called, so a crash cannot
   * wake the model twice for the same fire.
   */
  async pump(at: number): Promise<LoopFire[]> {
    const fires: LoopFire[] = [];

    for (const session of await this.sessions.loaded()) {
      let changed = false;

      for (const record of session.tasks.values()) {
        if (record.kind !== "loop" || record.status !== "running") continue;

        if (record.maxFires !== undefined && record.fires >= record.maxFires) {
          this.finish(record, at, "completed");
          changed = true;
          continue;
        }

        if (record.expiresAt !== undefined && at >= record.expiresAt) {
          this.finish(record, at, "completed");
          changed = true;
          continue;
        }

        const recurrence = parseSchedule(record.schedule);
        if (recurrence === undefined) {
          record.status = "failed";
          record.error = `invalid schedule "${record.schedule}"`;
          record.endedAt = at;
          delete record.nextFireAt;
          changed = true;
          continue;
        }

        if (record.nextFireAt === undefined) {
          // A running record without a due time (for example from an older
          // generation) is armed from now rather than fired immediately.
          const nextFireAt = recurrence.nextFire(at);
          if (nextFireAt === null) {
            this.finish(record, at, "completed");
          } else {
            record.nextFireAt = nextFireAt;
          }
          changed = true;
          continue;
        }

        if (record.nextFireAt > at) continue;

        record.fires += 1;
        record.lastFireAt = at;
        fires.push({ task: record, at, fire: record.fires });
        changed = true;

        if (record.maxFires !== undefined && record.fires >= record.maxFires) {
          this.finish(record, at, "completed");
          continue;
        }

        const nextFireAt = recurrence.nextFire(at);
        if (nextFireAt === null) {
          this.finish(record, at, "completed");
        } else {
          record.nextFireAt = nextFireAt;
        }
      }

      if (changed) await this.sessions.persist(session);
    }

    for (const fire of fires) this.onFire?.(fire);
    return fires;
  }

  private findLoop(session: TaskSession, id: string): LoopTask | undefined {
    const task = session.tasks.get(id);
    return task?.kind === "loop" ? task : undefined;
  }

  private finish(task: LoopTask, at: number, status: "completed" | "failed"): void {
    task.status = status;
    task.endedAt = at;
    delete task.nextFireAt;
  }

  private view(task: LoopTask): LoopTaskView {
    if (task.status !== "running" || task.nextFireAt === undefined) return { task };
    return { task, untilNextFireMs: Math.max(0, task.nextFireAt - this.now()) };
  }
}
