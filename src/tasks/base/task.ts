/**
 * The Task record: the supertype of every tracked unit of work (ADR-0005).
 *
 * A Task carries what both kinds share — id, name, status and timeline. The
 * `kind` discriminator selects the arm, so fields that only mean something for
 * one kind live on that arm instead of being optional on a single flat object.
 * The `process` and `loop` arms are the two kinds, and both live in this one
 * union so the store and the panel can carry them together (ADR-0005).
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { Iteration } from "../loop/iteration.js";

/** Lifecycle of a task, shared by both kinds. */
export type TaskStatus = "running" | "paused" | "completed" | "failed" | "killed" | "interrupted";

/**
 * Why a running task was stopped, in the glossary's four words: the user asked,
 * a timeout ran out, the output cap was reached, or the process is shutting down.
 * A killed task always carries one, so a reader can tell a user's decision from
 * the system's.
 */
export type KillReason = "user" | "timeout" | "output_cap" | "shutdown";

/** Which kind of work a task represents. */
export type TaskKind = "process" | "loop";

/** Fields every task carries, whatever its kind. */
export interface TaskBase {
  /** Short id the user can quote in a later message. */
  readonly id: string;
  readonly kind: TaskKind;
  readonly name: string;
  status: TaskStatus;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Epoch milliseconds; absent while the task is still running. */
  endedAt?: number;
}

/** A task that runs one command and captures its output in a file. */
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
}
/**
 * A schedule that wakes the assistant with a stored prompt (ADR-0001). It owns
 * no command and no output file: a fire is a message, and what the resulting
 * turn does is recorded as an Iteration.
 */
export interface LoopTask extends TaskBase {
  readonly kind: "loop";
  /** Raw schedule expression, kept verbatim for listings (ADR-0006). */
  readonly schedule: string;
  /** Message injected into the session on every fire. */
  readonly prompt: string;
  /** Stop after this many fires; absent means no fire-count limit. */
  readonly maxFires?: number;
  /** Epoch milliseconds after which the schedule stops; absent means no deadline. */
  readonly expiresAt?: number;
  /** Fires handled so far. */
  fires: number;
  /** Epoch milliseconds of the next fire; absent when paused or finished. */
  nextFireAt?: number;
  /** Epoch milliseconds of the most recent fire. */
  lastFireAt?: number;
  /** Why the schedule stopped abnormally, when that is known. */
  error?: string;
  /**
   * The turns this schedule woke, oldest first, each a child record and never a
   * task of its own (ADR-0002). Capped by ITERATION_HISTORY_LIMIT.
   */
  iterations: Iteration[];
  /** Iterations the history cap dropped; non-zero means the loop's list is truncated. */
  droppedIterations?: number;
}

/** One tracked unit of work: a process task or a loop task, never a second list. */
export type Task = ProcessTask | LoopTask;
