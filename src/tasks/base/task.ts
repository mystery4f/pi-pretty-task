/**
 * The Task record: the supertype of every tracked unit of work (ADR-0005).
 *
 * A Task carries what both kinds share — id, name, status and timeline. The
 * `kind` discriminator selects the arm, so fields that only mean something for
 * one kind live on that arm instead of being optional on a single flat object.
 * Today only the `process` arm exists; the loop arm lands with the loop ticket
 * and joins the same union.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

/** Lifecycle of a task, shared by both kinds. */
export type TaskStatus = "running" | "completed" | "failed" | "killed" | "interrupted";

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
}

/** One tracked unit of work. Grows an arm per kind; never a second list. */
export type Task = ProcessTask;
