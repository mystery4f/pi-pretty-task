/**
 * Loop tasks: the schedule store, the pump that turns a due schedule into a
 * wake-up or a fire, and the pause/resume/complete/retune/delete transitions.
 *
 * A loop is a {@link LlmLoopTask} or a {@link CmdLoopTask} record like a process
 * task is a {@link ProcessTask}; all of them live in one session record file
 * through {@link TaskSessions}. Nothing here starts a timer. The caller owns the
 * clock and calls {@link LoopTasks.pump} with the instant it wants handled, which
 * is what lets tests push a fake clock.
 *
 * An llm loop's fire is a wake-up the caller delivers into the session. A cmd
 * loop's fire is a process task started through `onCommandFire`; this file never
 * spawns it, so a fire reuses the one process path instead of a second one.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { resolve } from "node:path";

import type { TaskScope } from "../base/runtime-state.js";
import { sessionTaskDirectory } from "../base/runtime-state.js";
import type {
  CmdLoopTask,
  FireRecord,
  KillReason,
  LlmLoopTask,
  LoopBase,
  TaskStatus,
} from "../base/task.js";
import { FIRE_HISTORY_LIMIT } from "../base/task.js";
import type { TaskSession, TaskSessions } from "../base/task-sessions.js";
import type { Recurrence } from "./schedule.js";
import {
  parseDurationMs,
  parseSchedule,
  resolveSchedule,
  type ScheduleProblem,
} from "./schedule.js";

/** Either kind of loop record; everything the panel and the tool share is on {@link LoopBase}. */
export type LoopTask = LlmLoopTask | CmdLoopTask;

/** One due wake-up; the caller sends its prompt into the session. */
export interface LoopFire {
  readonly task: LlmLoopTask;
  /** Epoch ms the pump handled the fire at. */
  readonly at: number;
  /** One-based fire number, already recorded on the task. */
  readonly fire: number;
  /** The session the fire belongs to, so the iteration can be persisted as it opens. */
  readonly session: TaskSession;
  /**
   * This fire used the last of `maxFires`, so the loop is already completed.
   * The wake still belongs to the model even though the loop stopped.
   */
  readonly final: boolean;
}

/** One due cmd-loop fire; the caller starts a process task for it. */
export interface CommandFire {
  readonly task: CmdLoopTask;
  /** Epoch ms the pump handled the fire at. */
  readonly at: number;
  /** One-based fire number, already recorded on the task as running. */
  readonly fire: number;
  readonly session: TaskSession;
  /** The scope the loop was created in, so the child lands in the same session. */
  readonly scope: TaskScope;
}

/** What the process runner reports back when a fire's child ends. */
export interface FireResult {
  /** The loop that owns the child. */
  readonly parentId: string;
  readonly taskId: string;
  readonly fire: number;
  readonly status: TaskStatus;
  readonly exitCode?: number | null;
  readonly outputPath: string;
  readonly outputBytes: number;
  readonly durationMs: number;
  readonly killReason?: KillReason;
  readonly error?: string;
  /** When the child ended; defaults to now. */
  readonly endedAt?: number;
}

/** A fire that just got its outcome, for the caller that reports failures. */
export interface CompletedFire {
  readonly loop: CmdLoopTask;
  readonly fire: FireRecord;
  /** Exit code non-zero, killed by the output cap, or never started. */
  readonly failed: boolean;
}

export interface CreateLoopInput extends TaskScope {
  /**
   * Raw recurrence text: interval shorthand such as `30s`, `10m`, `2h`, or a
   * five-field cron expression such as `0 9 * * 1-5` read in local time.
   */
  schedule: string;
  /** Text sent into the session on each fire; mutually exclusive with `command`. */
  prompt?: string;
  /** Shell command run as a background process on each fire; exclusive with `prompt`. */
  command?: string;
  /** Working directory of a command loop; only valid with `command`. */
  workingDirectory?: string;
  /** Extra environment variables of a command loop; only valid with `command`. */
  env?: Record<string, string>;
  /** Send a notice when a fire fails; only valid with `command`. Defaults to on. */
  wakeOnFailure?: boolean;
  name?: string;
  /** Stop after this many fires; omitted means no limit. */
  maxFires?: number;
  /** Stop at this much time after creation, in the same shorthand. */
  expiresIn?: string;
}

/**
 * What one `loop_update` call asks for: a transition, a retune, or both. The
 * retune is applied first, so resuming onto a new schedule is one call.
 */
export interface UpdateLoopInput extends TaskScope {
  readonly id: string;
  /** Transition to apply; omit it to change only the schedule. */
  readonly action?: LoopUpdateAction;
  /** New schedule expression; a running loop re-arms from this moment. */
  readonly schedule?: string;
}

/** A loop as the tools and the panel read it. */
export interface LoopTaskView {
  readonly task: LoopTask;
  /** Time left before the next fire; absent while paused or finished. */
  readonly untilNextFireMs?: number;
}

/** A transition `loop_update` can apply. A retune travels in `schedule`, not here. */
export type LoopUpdateAction = "pause" | "resume" | "complete";

export type LoopUpdateOutcome =
  | "paused"
  | "resumed"
  | "completed"
  /** The schedule changed; `rescheduled` is not a status, the loop keeps its own. */
  | "rescheduled"
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

/**
 * The one refusal for a schedule that cannot be resolved, worded once so
 * `loop_create` and `loop_update` cannot drift apart (ADR-0006): name both
 * accepted shapes and one correct example, never guess at what was meant.
 */
function invalidScheduleError(expression: string, problem: ScheduleProblem): LoopInputError {
  const remedy =
    problem === "six-field"
      ? "six fields were given: a cron expression here has five (minute, hour, day of month, month, day of week) and no seconds column — for second-level timing use the interval shorthand such as 30s, 10m or 2h; for a calendar schedule drop the seconds field, for example 0 9 * * 1-5."
      : "use the interval shorthand such as 30s, 10m or 2h, or a five-field cron expression such as 0 9 * * 1-5 (every workday at 09:00).";
  return new LoopInputError(`Invalid schedule "${expression.trim()}": ${remedy}`);
}

/** The session limit from the product scope. Finished loops do not count. */
export const MAX_LOOPS = 50;

/** Same rule and limit as process task names. */
const NAME_LIMIT = 48;

/**
 * A failing loop waits longer every time, so a broken command cannot burn a
 * short schedule all night. Four doublings and one hour is the cap (ADR-0015).
 */
const BACKOFF_DOUBLINGS = 4;
const MAX_BACKOFF_MS = 3_600_000;

export interface LoopTasksOptions {
  readonly sessions: TaskSessions;
  /** Clock seam for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Called once per due fire, after the record with its new count is persisted.
   * Awaited, so the caller's own record of the fire (its iteration) is durable
   * before the pump returns and before any flush can deliver the wake.
   */
  readonly onFire?: (fire: LoopFire) => Promise<void> | void;
  /**
   * Called once per due cmd-loop fire, after the fire is recorded as running and
   * persisted. Returns the id of the process task it started, or nothing when no
   * runner is configured; a throw or a missing id marks the fire failed and backs
   * the schedule off exactly like a non-zero exit.
   */
  readonly onCommandFire?:
    | ((fire: CommandFire) => Promise<{ taskId: string } | undefined>)
    | ((fire: CommandFire) => { taskId: string } | undefined);
  /**
   * Called when a loop stopped before waking the model for a recorded fire: it
   * was paused, completed or deleted while the wake waited. The caller drops
   * that queued wake — pi's follow-up queue cannot be recalled once sent — and
   * stops any child a cmd loop still has running.
   */
  readonly onCancel?: (taskId: string) => Promise<void> | void;
}

/** First line of the prompt or command, collapsed and capped, so a loop has a readable name. */
function deriveLoopName(text: string): string {
  const collapsed = (text.split("\n", 1)[0] ?? "").trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return "loop";
  if (collapsed.length <= NAME_LIMIT) return collapsed;
  return `${collapsed.slice(0, NAME_LIMIT - 1)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LoopTasks {
  private readonly sessions: TaskSessions;
  private readonly now: () => number;
  private readonly onFire: ((fire: LoopFire) => Promise<void> | void) | undefined;
  private readonly onCommandFire:
    | ((fire: CommandFire) => Promise<{ taskId: string } | undefined>)
    | ((fire: CommandFire) => { taskId: string } | undefined)
    | undefined;
  private readonly onCancel: ((taskId: string) => Promise<void> | void) | undefined;
  /**
   * The scope each loaded session was opened with, keyed by state directory. A
   * fire starts a process task in the same session, and a {@link TaskSession}
   * holds directory and records but not the cwd and session id the process store
   * is keyed by.
   */
  private readonly scopes = new Map<string, TaskScope>();
  /** The pump in flight, so a timer tick and a turn end cannot interleave. */
  private inFlight: Promise<void> | undefined;

  constructor(options: LoopTasksOptions) {
    this.sessions = options.sessions;
    this.now = options.now ?? Date.now;
    this.onFire = options.onFire;
    this.onCommandFire = options.onCommandFire;
    this.onCancel = options.onCancel;
  }

  /** Load the session so the pump sees it even before the first loop-tool call. */
  async attach(scope: TaskScope): Promise<void> {
    this.rememberScope(scope);
    await this.sessions.session(scope);
  }

  async create(input: CreateLoopInput): Promise<LoopTaskView> {
    const resolution = resolveSchedule(input.schedule);
    if (resolution.kind === "rejected") {
      throw invalidScheduleError(input.schedule, resolution.problem);
    }
    const recurrence = resolution.recurrence;

    const prompt = input.prompt?.trim() ?? "";
    const command = input.command?.trim() ?? "";
    // A loop fires exactly one thing. Both or neither is a mistake to name, not
    // to resolve by guessing which one the user meant (ADR-0006).
    if (prompt.length > 0 && command.length > 0) {
      throw new LoopInputError(
        "A loop fires either a prompt or a command, not both: drop the prompt to run a command in the background, or drop the command to wake the model with a message.",
      );
    }
    if (prompt.length === 0 && command.length === 0) {
      throw new LoopInputError(
        "A loop needs a prompt or a command: the prompt is the text sent into the session each time it fires, the command is run as a background process like bg_run.",
      );
    }
    if (prompt.length > 0) {
      // Silently ignoring these would leave the user believing a working
      // directory or a wake-on-failure notice applies to a loop that runs nothing.
      const misplaced = [
        input.workingDirectory !== undefined ? "cwd" : undefined,
        input.env !== undefined ? "env" : undefined,
        input.wakeOnFailure !== undefined ? "wakeOnFailure" : undefined,
      ].filter((option): option is string => option !== undefined);
      if (misplaced.length > 0) {
        throw new LoopInputError(
          `Invalid ${misplaced.join(", ")} for a prompt loop: only a command loop has a working directory, extra environment variables and a wake-on-failure notice. This loop has a prompt and runs no command.`,
        );
      }
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

    this.rememberScope(input);
    const session = await this.sessions.session(input);
    const active = [...session.tasks.values()].filter(
      (task) =>
        (task.kind === "llm-loop" || task.kind === "cmd-loop") &&
        (task.status === "running" || task.status === "paused"),
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
    const loopName =
      name !== undefined && name.length > 0 ? name : deriveLoopName(prompt || command);
    const shared = {
      name: loopName,
      status: "running" as const,
      createdAt,
      updatedAt: createdAt,
      schedule: recurrence.expression,
      fires: 0,
      nextFireAt,
      ...(input.maxFires !== undefined ? { maxFires: input.maxFires } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };

    const task: LoopTask =
      prompt.length > 0
        ? {
            ...shared,
            id: this.sessions.createId(session, "llm-loop"),
            kind: "llm-loop",
            prompt,
            iterations: [],
          }
        : {
            ...shared,
            id: this.sessions.createId(session, "cmd-loop"),
            kind: "cmd-loop",
            command,
            // Recorded absolute so the panel and a later fire agree on the
            // directory even though the record outlives the turn that made it.
            ...(input.workingDirectory !== undefined
              ? { cwd: resolve(input.cwd, input.workingDirectory) }
              : {}),
            ...(input.env !== undefined ? { env: { ...input.env } } : {}),
            ...(input.wakeOnFailure !== undefined ? { wakeOnFailure: input.wakeOnFailure } : {}),
            fireHistory: [],
          };

    session.tasks.set(task.id, task);
    await this.sessions.persist(session);
    return this.view(task);
  }

  /** Loops of the session, in record order, finished ones included as history. */
  async list(scope: TaskScope): Promise<LoopTaskView[]> {
    this.rememberScope(scope);
    const session = await this.sessions.session(scope);
    return [...session.tasks.values()]
      .filter((task) => task.kind === "llm-loop" || task.kind === "cmd-loop")
      .map((task) => this.view(task));
  }

  async get(scope: TaskScope, id: string): Promise<LoopTaskView | undefined> {
    this.rememberScope(scope);
    const session = await this.sessions.session(scope);
    const task = this.findLoop(session, id);
    return task === undefined ? undefined : this.view(task);
  }

  /**
   * Change one loop: a pause/resume/complete transition, a retune, or both in one
   * call. A retune re-arms a running loop from `now` — never from the slot the old
   * schedule had already picked — and only stores the expression on a paused one,
   * which arms onto it when resumed. Nothing is rebuilt, so the id, the fire count
   * and every recorded iteration survive. An unusable expression is refused before
   * the record changes, on the same message `loop_create` gives (ADR-0006).
   */
  async update(input: UpdateLoopInput): Promise<LoopUpdateResult | undefined> {
    this.rememberScope(input);
    const session = await this.sessions.session(input);
    const task = this.findLoop(session, input.id);
    if (task === undefined) return undefined;

    const now = this.now();
    let outcome: LoopUpdateOutcome | undefined;
    let changed = false;

    if (input.schedule !== undefined) {
      const resolution = resolveSchedule(input.schedule);
      if (resolution.kind === "rejected") {
        throw invalidScheduleError(input.schedule, resolution.problem);
      }
      const recurrence = resolution.recurrence;
      const nextFireAt = recurrence.nextFire(now);
      if (nextFireAt === null) {
        throw new LoopInputError(`Schedule "${recurrence.expression}" has no next fire time.`);
      }
      // A finished loop keeps the schedule it finished on: there is nothing left to
      // arm, and rewriting the record would misreport how it ended.
      if (task.status === "running" || task.status === "paused") {
        task.schedule = recurrence.expression;
        // The old slot is abandoned; a paused loop keeps no next fire to move.
        if (task.status === "running") task.nextFireAt = nextFireAt;
        outcome = "rescheduled";
        changed = true;
      } else {
        outcome = "already-completed";
      }
    }

    switch (input.action) {
      case undefined:
        // A retune alone; the schedule branch above owns the outcome.
        break;

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

    if (outcome === undefined) {
      throw new LoopInputError(
        "Give an action or a schedule: action pauses, resumes or completes the loop, while schedule retunes when it fires.",
      );
    }

    if (changed) {
      // Pause, resume, complete and retune are the user-visible changes of a loop,
      // so each one moves the record up in the panel (ADR-0010).
      task.updatedAt = now;
      await this.sessions.persist(session);
    }
    // A loop that this call stopped must not wake the model for a fire it recorded
    // while the agent was busy: the queued wake is dropped before this call returns.
    // A cmd loop's running fire is stopped here too, by the same callback. A retune
    // on its own never stops a loop, so it never drops a wake.
    const stopped = input.action !== undefined && changed && task.status !== "running";
    if (stopped) await this.onCancel?.(task.id);
    return { view: this.view(task), outcome };
  }

  async delete(scope: TaskScope, id: string): Promise<LoopTaskView | undefined> {
    this.rememberScope(scope);
    const session = await this.sessions.session(scope);
    const task = this.findLoop(session, id);
    if (task === undefined) return undefined;
    const view = this.view(task);
    session.tasks.delete(task.id);
    await this.sessions.persist(session);
    await this.onCancel?.(task.id);
    return view;
  }

  /**
   * Handle every loop whose next fire is due at `at`, across every session this
   * extension has loaded. Each due loop fires at most once per call: a pump that
   * arrives late drops the missed fires instead of replaying them in a storm.
   * The new count is persisted before `onFire` is called, so a crash cannot
   * wake the model twice for the same fire.
   *
   * Calls are serialized: a timer tick and a `turn_end` can ask at the same
   * moment, and two pumps reading the same `nextFireAt` would fire one loop
   * twice. A pump that arrives while another runs waits for it and then sees the
   * advanced `nextFireAt`.
   *
   * Returns the llm wakes only; a cmd fire is started through `onCommandFire`
   * before this promise resolves, so the caller never sees a fire unstarted.
   */
  async pump(at: number): Promise<LoopFire[]> {
    const run = (this.inFlight ?? Promise.resolve()).then(
      () => this.pumpOnce(at),
      () => this.pumpOnce(at),
    );
    this.inFlight = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Record the end of a fire's child process: outcome, exit code, bytes and the
   * failure backoff. Returns nothing when the loop or its fire is already gone
   * (deleted, or history trimmed), so a late child can never resurrect a record.
   */
  async completeFire(result: FireResult): Promise<CompletedFire | undefined> {
    for (const session of await this.sessions.loaded()) {
      const loop = this.findCmdLoop(session, result.parentId);
      if (loop === undefined) continue;
      const fire = loop.fireHistory.find((entry) => entry.fire === result.fire);
      if (fire === undefined) return undefined;

      const at = this.now();
      fire.outcome =
        result.status === "completed"
          ? "success"
          : result.killReason === "user"
            ? "interrupted"
            : "failed";
      if (result.exitCode !== undefined && result.exitCode !== null) {
        fire.exitCode = result.exitCode;
      }
      fire.endedAt = result.endedAt ?? at;
      fire.durationMs = Math.max(0, result.durationMs);
      fire.outputBytes = result.outputBytes;
      if (result.error !== undefined) fire.error = result.error;

      loop.lastExitCode = result.exitCode ?? null;
      loop.lastOutputPath = result.outputPath;
      loop.lastOutputBytes = result.outputBytes;
      loop.updatedAt = at;

      if (fire.outcome === "failed") {
        this.noteFailure(loop, at);
      } else if (fire.outcome === "success") {
        loop.consecutiveFailures = 0;
      }

      await this.sessions.persist(session);
      return { loop, fire, failed: fire.outcome === "failed" };
    }
    return undefined;
  }

  private async pumpOnce(at: number): Promise<LoopFire[]> {
    const fires: LoopFire[] = [];
    const commandFires: CommandFire[] = [];

    for (const session of await this.sessions.loaded()) {
      let changed = false;

      for (const record of session.tasks.values()) {
        if (record.kind !== "llm-loop" && record.kind !== "cmd-loop") continue;
        if (record.status !== "running") continue;

        const common = this.commonDueCheck(record, at);
        if (common === "finished") {
          changed = true;
          continue;
        }
        if (common === "rearmed") {
          changed = true;
          continue;
        }
        if (common === "skip") continue;
        const recurrence = common.recurrence;

        if (record.kind === "llm-loop") {
          const final = record.maxFires !== undefined && record.fires + 1 >= record.maxFires;
          record.fires += 1;
          record.lastFireAt = at;
          // A fire is the loop's own transition, so the panel's sort key follows it
          // even when the resulting turn records no tool calls (ADR-0010).
          record.updatedAt = at;
          fires.push({ task: record, at, fire: record.fires, session, final });
          changed = true;

          this.advanceSchedule(record, recurrence, at);
          continue;
        }

        const fire = record.fires + 1;
        record.fires = fire;
        record.lastFireAt = at;
        record.updatedAt = at;
        changed = true;

        if (record.fireHistory.some((entry) => entry.outcome === "running")) {
          // The previous command is still going. Starting a second copy would
          // race two writes on one output file; the slot is consumed and shown
          // as skipped, never silently dropped (ADR-0015).
          record.missedFires = (record.missedFires ?? 0) + 1;
          this.pushFire(record, { fire, at, outcome: "skipped" });
          this.advanceSchedule(record, recurrence, at);
          continue;
        }

        this.pushFire(record, { fire, at, outcome: "running", startedAt: at });
        const scope = this.scopes.get(session.directory);
        if (scope === undefined) {
          // Every loaded session came through a scope, so this is a hole, not a
          // policy: fail the fire loudly instead of guessing a directory.
          const entry = record.fireHistory.at(-1);
          if (entry !== undefined) {
            entry.outcome = "failed";
            entry.endedAt = at;
            entry.error = "the loop's session scope is unknown";
          }
          this.noteFailure(record, at);
        } else {
          commandFires.push({ task: record, at, fire, session, scope });
        }
        this.advanceSchedule(record, recurrence, at);
      }

      if (changed) await this.sessions.persist(session);
    }

    for (const fire of fires) await this.onFire?.(fire);
    // Persisted above, so the child's start can never be lost by a crash that
    // keeps the fire record: a fire that was recorded always gets an outcome.
    for (const fire of commandFires) await this.startCommandFire(fire);
    return fires;
  }

  /**
   * The checks both kinds share: the cap, expiry, a schedule that no longer
   * parses, a record with no due time, and the due test itself.
   */
  private commonDueCheck(
    record: LoopBase,
    at: number,
  ): "finished" | "rearmed" | "skip" | { recurrence: Recurrence } {
    if (record.maxFires !== undefined && record.fires >= record.maxFires) {
      this.finish(record, at, "completed");
      return "finished";
    }
    if (record.expiresAt !== undefined && at >= record.expiresAt) {
      this.finish(record, at, "completed");
      return "finished";
    }

    const recurrence = parseSchedule(record.schedule);
    if (recurrence === undefined) {
      record.status = "failed";
      record.error = `invalid schedule "${record.schedule}"`;
      record.endedAt = at;
      delete record.nextFireAt;
      record.updatedAt = at;
      return "finished";
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
      return "rearmed";
    }

    if (record.nextFireAt > at) return "skip";
    return { recurrence };
  }

  /** Cap, then the next due time; a schedule with no future fire ends the loop. */
  private advanceSchedule(task: LoopBase, recurrence: Recurrence, at: number): void {
    if (task.maxFires !== undefined && task.fires >= task.maxFires) {
      this.finish(task, at, "completed");
      return;
    }
    const nextFireAt = recurrence.nextFire(at);
    if (nextFireAt === null) {
      this.finish(task, at, "completed");
    } else {
      task.nextFireAt = nextFireAt;
    }
  }

  private async startCommandFire(fire: CommandFire): Promise<void> {
    const loop = fire.task;
    const record = loop.fireHistory.find((entry) => entry.fire === fire.fire);
    if (record === undefined) return;

    let started: { taskId: string } | undefined;
    let error: string | undefined;
    try {
      started = await this.onCommandFire?.(fire);
      if (started === undefined) error = "no process runner is configured for this command loop";
    } catch (caught) {
      error = messageOf(caught);
    }

    const at = this.now();
    if (started === undefined) {
      // The child never existed, so this fire is a failure with no output; it
      // backs the schedule off like any other failure and shows as such.
      record.outcome = "failed";
      record.endedAt = at;
      record.durationMs = 0;
      record.error = error;
      this.noteFailure(loop, at);
    } else {
      record.taskId = started.taskId;
    }
    loop.updatedAt = at;
    await this.sessions.persist(fire.session);
  }

  private pushFire(loop: CmdLoopTask, fire: FireRecord): void {
    loop.fireHistory.push(fire);
    // Oldest first, newest at the right: the strip in the row reads left to
    // right in time, and trimming the left keeps that direction stable.
    const overflow = loop.fireHistory.length - FIRE_HISTORY_LIMIT;
    if (overflow > 0) loop.fireHistory.splice(0, overflow);
  }

  /**
   * A failed fire doubles the wait, up to one hour, counting from the failure.
   * The next natural fire time is never pulled earlier: a long schedule keeps
   * its spacing and a short one gets the room the failure asked for.
   */
  private noteFailure(loop: CmdLoopTask, at: number): void {
    loop.consecutiveFailures = (loop.consecutiveFailures ?? 0) + 1;
    if (loop.status !== "running" || loop.nextFireAt === undefined) return;
    const base = Math.max(1, loop.nextFireAt - (loop.lastFireAt ?? loop.nextFireAt));
    const factor = 2 ** Math.min(loop.consecutiveFailures, BACKOFF_DOUBLINGS);
    const delay = Math.min(base * factor, MAX_BACKOFF_MS);
    loop.nextFireAt = Math.max(loop.nextFireAt, at + delay);
  }

  private rememberScope(scope: TaskScope): void {
    // Keyed exactly as TaskSessions keys its map, so a fire finds its scope
    // from the session alone.
    this.scopes.set(sessionTaskDirectory(scope.cwd, scope.sessionId), scope);
  }

  private findLoop(session: TaskSession, id: string): LoopTask | undefined {
    const task = session.tasks.get(id);
    return task?.kind === "llm-loop" || task?.kind === "cmd-loop" ? task : undefined;
  }

  private findCmdLoop(session: TaskSession, id: string): CmdLoopTask | undefined {
    const task = session.tasks.get(id);
    return task?.kind === "cmd-loop" ? task : undefined;
  }

  private finish(task: LoopBase, at: number, status: "completed" | "failed"): void {
    task.status = status;
    task.endedAt = at;
    delete task.nextFireAt;
    // Every status change ends here, so this is the one place the loop's
    // recency moves with it (ADR-0010).
    task.updatedAt = at;
  }

  private view(task: LoopTask): LoopTaskView {
    if (task.status !== "running" || task.nextFireAt === undefined) return { task };
    return { task, untilNextFireMs: Math.max(0, task.nextFireAt - this.now()) };
  }
}
