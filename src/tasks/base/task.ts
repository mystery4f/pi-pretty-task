/**
 * The Task record: the supertype of every tracked unit of work (ADR-0005).
 *
 * A Task carries what the kinds share — id, name, status and timeline. The
 * `kind` discriminator selects the arm, so fields that only mean something for
 * one kind live on that arm instead of being optional on a single flat object.
 * The `process`, `llm-loop`, `cmd-loop` and `chain` arms are the four implemented
 * kinds, and all of them live in this one union so the store and the panel can
 * carry them together (ADR-0005).
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { Iteration } from "../loop/iteration.js";

/**
 * Lifecycle of a task, shared by every kind.
 *
 * `waiting`, `skipped` and `stopped` exist for a chain's steps, which are queued
 * before they run and can end without ever being started (ADR-0013): a step
 * waits its turn, is skipped when the step ahead of it failed, and is stopped
 * when the user stops the chain.
 */
export type TaskStatus =
  /** Queued but not started: a chain step whose turn has not come yet. */
  | "waiting"
  | "running"
  | "paused"
  /** Ended at exit 0, or a chain whose queue ran out. */
  | "completed"
  | "failed"
  /** Ended without running: a queued step the user's stop settled (never started). */
  | "stopped"
  /** Never ran, because the step ahead of it did not succeed. */
  | "skipped"
  | "killed"
  | "interrupted";

/**
 * Why a running task was stopped, in the glossary's four words: the user asked,
 * a timeout ran out, the output cap was reached, or the process is shutting down.
 * A killed task always carries one, so a reader can tell a user's decision from
 * the system's.
 */
export type KillReason = "user" | "timeout" | "output_cap" | "shutdown";

/** Which kind of work a task represents. */
export type TaskKind = "process" | "llm-loop" | "cmd-loop" | "chain";

/** Fields every task carries, whatever its kind. */
export interface TaskBase {
  /** Short id the user can quote in a later message. */
  readonly id: string;
  readonly kind: TaskKind;
  readonly name: string;
  status: TaskStatus;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /**
   * Epoch milliseconds of the last change a reader cares about, and the panel's
   * sort key (ADR-0010). Starts equal to `createdAt` and moves only on a real
   * transition: start, finish, kill and interrupt of a task, a loop fire, one of
   * that loop's iterations settling, and pause/resume/complete/retune. Output growth
   * never moves it — a running command writes bytes every tick, which would pin
   * the order to whichever task wrote last instead of which one changed.
   */
  updatedAt: number;
  /** Epoch milliseconds; absent while the task is still running. */
  endedAt?: number;
}

/**
 * A background process: the kind `bg_run` starts and the only kind a cmd-loop
 * fire produces (ADR-0014). A child process carries the link back to its loop
 * and nothing more — its id stays an ordinary process id (ADR-0016).
 */
export interface ProcessTask extends TaskBase {
  readonly kind: "process";
  readonly command: string;
  /** Directory the command runs in. */
  readonly cwd: string;
  /** Output file holding stdout and stderr in emission order. */
  readonly outputPath: string;
  pid?: number;
  exitCode?: number | null;
  /** Bytes written to the output file so far. */
  outputBytes: number;
  /** Why the task ended abnormally, when that is known. */
  error?: string;
  /** Present exactly when the task was killed, naming who asked for the kill. */
  killReason?: KillReason;
  /**
   * The record this process belongs to, when it is a child rather than a row of
   * its own (ADR-0014): the cmd loop when a fire started it, or the chain when
   * it is one of its steps (ADR-0013). Mutable on purpose — a queued step is
   * adopted into a chain while it may still be running, and replacing the
   * record would lose the process the supervisor is watching.
   */
  parentId?: string;
  /** One-based fire number of the owning loop; present exactly with a loop's `parentId`. */
  readonly fire?: number;
}

/**
 * One fire of a cmd loop: a child process task plus how that fire ended. The
 * record lives on the loop so the panel can show the last fires without loading
 * their process records (ADR-0015); `taskId` points at the child when it exists.
 */
export type FireOutcome = "running" | "success" | "failed" | "skipped" | "interrupted";

/** How one fire of a cmd loop ended, as the loop's history keeps it. */
export interface FireRecord {
  /** One-based fire number, the same number the child process carries. */
  readonly fire: number;
  /** Epoch milliseconds the pump handled the fire. */
  readonly at: number;
  /** Epoch milliseconds the child process started; absent for a skipped fire. */
  startedAt?: number;
  /** Epoch milliseconds the child process ended; absent while it runs or was skipped. */
  endedAt?: number;
  outcome: FireOutcome;
  /** Process exit code; null when a signal ended the child. */
  exitCode?: number | null;
  /** Milliseconds from start to end of the child process. */
  durationMs?: number;
  /** Bytes the child wrote to its output file. */
  outputBytes?: number;
  /** The child process task id; absent for a skipped fire and before a start returns. */
  taskId?: string;
  /** Why the fire failed to start, when the process never ran. */
  error?: string;
}

/**
 * Fields a loop keeps whatever it fires. The scheduler only sees this shape, so
 * an llm loop and a cmd loop share one pump, one pause/resume/complete set of
 * transitions and one fire counter.
 */
export interface LoopBase extends TaskBase {
  /**
   * Raw schedule expression, kept verbatim for listings (ADR-0006). `loop_update`
   * rewrites it in place when the user retunes the loop.
   */
  schedule: string;
  /** Stop after this many fires; absent means no fire-count limit. */
  readonly maxFires?: number;
  /** Epoch milliseconds after which the schedule stops; absent means no deadline. */
  readonly expiresAt?: number;
  /** Fires handled so far, skipped ones included: the next fire number is this + 1. */
  fires: number;
  /** Epoch milliseconds of the next fire; absent when paused or finished. */
  nextFireAt?: number;
  /** Epoch milliseconds of the most recent fire. */
  lastFireAt?: number;
  /**
   * Due fires that were not started, the cmd-loop overlap policy: the previous
   * fire was still running, so this one was skipped rather than queued.
   */
  missedFires?: number;
  /** Consecutive failed fires; drives the schedule's failure backoff and resets on success. */
  consecutiveFailures?: number;
  /** Why the schedule stopped abnormally, when that is known. */
  error?: string;
}
/**
 * An llm loop: a schedule that wakes the assistant with a stored prompt
 * (ADR-0001). It owns no command and no output file: a fire is a message, and
 * what the resulting turn does is recorded as an Iteration.
 */
export interface LlmLoopTask extends LoopBase {
  readonly kind: "llm-loop";
  /** Message injected into the session on every fire. */
  readonly prompt: string;
  /**
   * The turns this schedule woke, oldest first, each a child record and never a
   * task of its own (ADR-0002). Capped by ITERATION_HISTORY_LIMIT.
   */
  iterations: Iteration[];
  /** Iterations the history cap dropped; non-zero means the loop's list is truncated. */
  droppedIterations?: number;
}

/**
 * A cmd loop: a schedule that runs one command in the background on every fire
 * (ADR-0014). Each fire is an ordinary process task with `parentId` pointing
 * back here, so the process supervisor owns spawning, output files, caps and
 * kills; the loop only owns the schedule and the fire history.
 */
export interface CmdLoopTask extends LoopBase {
  readonly kind: "cmd-loop";
  /** Command line started on every fire, through the same path as `bg_run`. */
  readonly command: string;
  /** Working directory override; the fire resolves it against the session's cwd. */
  readonly cwd?: string;
  /** Extra environment variables merged over the process environment. */
  readonly env?: Record<string, string>;
  /** Send a notice when a fire exits non-zero; absent means on, the tool's default. */
  readonly wakeOnFailure?: boolean;
  /**
   * The most recent fires, oldest first, capped by FIRE_HISTORY_LIMIT. The three
   * newest feed the row's strip; the whole list feeds the expansion (ADR-0015).
   */
  fireHistory: FireRecord[];
  /** Exit code of the most recent fire that ran; absent when none has ended. */
  lastExitCode?: number | null;
  /** Output file of the most recent fire, so the loop row can point at it. */
  lastOutputPath?: string;
  /** Bytes the most recent fire wrote; the loop row shows the size. */
  lastOutputBytes?: number;
}

/**
 * A chain: a queue of process steps that run one at a time, in order (ADR-0013).
 *
 * It is a Task, not a separate record type, so it is stored, listed and stopped
 * through the same seams as everything else. It holds ids rather than copies:
 * each step is an ordinary process task with `parentId` pointing back here, so
 * its output, status and exit code stay readable through `bg_status`, `bg_logs`
 * and `bg_wait` (ADR-0014). A chain owns no command and no output file — the
 * steps hold both.
 */
export interface ChainTask extends TaskBase {
  readonly kind: "chain";
  /**
   * The queue, in run order, as task ids. Only `process` steps are queued: a
   * loop brings its own clock, and two clocks behind one queue cannot be
   * ordered (ADR-0013). Ids, never copies, so a step's record stays the one
   * source of its output.
   */
  steps: string[];
  /**
   * The slot the chain is working on: the step that is running, or the step
   * that will run when the current one ends. Equal to `steps.length` once the
   * queue has run out, which is what makes a finished chain `completed`.
   */
  cursor: number;
  /** Why the chain failed, when a step of it did. */
  error?: string;
  /**
   * Present exactly when the chain was killed, naming who asked. A chain the user
   * stops is ended the way a killed process is — its own steps say where it stopped
   * (`stopped`) and what it had already got through.
   */
  killReason?: KillReason;
}

/** How many fires a cmd loop keeps; older ones are counted but no longer listed. */
export const FIRE_HISTORY_LIMIT = 50;

/** One tracked unit of work: a process task, a loop or a chain, never a second list. */
export type Task = ProcessTask | LlmLoopTask | CmdLoopTask | ChainTask;
