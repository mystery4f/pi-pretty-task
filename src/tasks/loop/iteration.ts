/**
 * The Iteration record: what one loop fire's turn actually did (ADR-0002).
 *
 * An iteration is a child record of a loop task, never a task: it has no row of
 * its own in the panel and no schedule of its own. It holds the tool calls the
 * turn made — every tool, not just the ones that start background processes —
 * so a reader can answer "what did that wake do" without replaying the
 * transcript.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

/**
 * Tool calls one iteration keeps. A long turn can make hundreds of calls, and
 * the record is written to the session file on every change, so the cap is what
 * keeps one busy wake from filling the disk (ADR-0002).
 */
export const ITERATION_CALL_LIMIT = 100;

/** Iterations one loop keeps; older ones are counted on the loop record instead. */
export const ITERATION_HISTORY_LIMIT = 50;

/** How long a call's identifying argument may be before it is cut. */
const SUBJECT_LIMIT = 200;

/** How much of a failure message the record keeps. */
const ERROR_LIMIT = 300;

/** How a tool call inside an iteration ended. */
export type IterationCallStatus = "running" | "completed" | "failed" | "aborted" | "interrupted";

/**
 * One tool call made during the turn a fire woke. `id` is the model's tool call
 * id: parallel calls start in source order and end in completion order, so the
 * pairing key is the id and never the position (ADR-0002).
 */
export interface IterationCall {
  readonly id: string;
  readonly tool: string;
  /** One line naming what the call acted on: the command, for a shell tool. */
  readonly subject: string;
  readonly startedAt: number;
  endedAt?: number;
  status: IterationCallStatus;
  durationMs?: number;
  /** What the tool said when it failed. */
  error?: string;
}

/**
 * How an iteration ended. `interrupted` means the end of the turn was never
 * observed — the process went away mid-turn — and is only written when a
 * record is read back.
 */
export type IterationStatus = "running" | "completed" | "aborted" | "interrupted";

/**
 * How a fire's turn ended, as the loop's schedule needs to know it (ticket #46):
 * `failed` when the provider gave up on the turn, `healthy` when the turn
 * finished, and `aborted` when the user stopped it. A stop by the user says
 * nothing about the provider, so it is neither a failure nor a success.
 */
export type TurnEnd = "failed" | "healthy" | "aborted";

/**
 * What a settle can tell a loop's schedule about a turn (ticket #46): its
 * {@link TurnEnd}, or `unobserved` when no assistant message described it — a run
 * cut off before the model spoke. An unobserved turn is not a success, so it
 * clears nothing: the streak it might have ended stays until a turn is seen.
 */
export type TurnOutcome = TurnEnd | "unobserved";

/**
 * The provider retry the turn is on (ticket #47). pi retries a transient
 * provider error before giving up, and without this a fire that spent three
 * attempts on a busy provider reads as one ordinary slow turn.
 *
 * It describes the turn in flight only: the field is cleared at the end of the
 * turn, because what the turn finally did is the iteration's `status`.
 */
export interface IterationRetry {
  /** Attempts that have failed in this turn so far; one-based once recorded. */
  readonly attempt: number;
  /** Attempts the settings allow before pi gives up. */
  readonly maxAttempts: number;
  /** The provider status the failure carried, when it named one: `529`. */
  readonly status?: string;
}

/** One fire's turn: the child record of the loop task that fired. */
export interface Iteration {
  /** One-based fire number of the owning loop; unique within that loop. */
  readonly fire: number;
  readonly startedAt: number;
  endedAt?: number;
  status: IterationStatus;
  /**
   * How the turn ended, recorded by the settle that closed it (ticket #53): the
   * same verdict the loop's schedule charges. Absent while the turn is open, on
   * a record the process died on before it settled (interrupted), and on a record
   * written before the field existed — so a settled turn that really ended clean
   * always carries it, and a view that shows a settled turn reads this rather
   * than inferring a verdict from the calls it made.
   */
  end?: TurnOutcome;
  /**
   * The wake reached pi, so this turn is real and its tool calls are its own. A
   * fire that never woke the model keeps this false and records no calls.
   */
  bound?: boolean;
  /** Calls in the order they started; the newest are kept when the cap is hit. */
  calls: IterationCall[];
  /** Calls the cap dropped. Non-zero means the record is truncated, and says so. */
  droppedCalls: number;
  /**
   * The provider retry the turn in flight is on; absent once it ended. Only ever
   * set while `status` is `running`.
   */
  retry?: IterationRetry;
}

/**
 * How a view of one turn reads it (ticket #53). The lifecycle says what the
 * record did — a turn that closed is `completed` — while {@link Iteration.end}
 * says what the turn's verdict was, so a failed turn reads `failed` everywhere
 * instead of only in the loop's own failure count.
 */
export type IterationVerdict = IterationStatus | "failed";

/** The word every view prints for this iteration; see {@link IterationVerdict}. */
export function iterationVerdict(iteration: Iteration): IterationVerdict {
  return iteration.end === "failed" ? "failed" : iteration.status;
}

/** Argument names that identify a call, in the order they are tried. */
const SUBJECT_KEYS = [
  "command",
  "cmd",
  "path",
  "file_path",
  "pattern",
  "query",
  "url",
  "name",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One line, cut to the limit: the head of the argument is what identifies it. */
function oneLine(value: string, limit: number): string {
  const collapsed = value.replace(/\s*\n\s*/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, Math.max(1, limit - 1))}…`;
}

/**
 * The identifying argument of a call, as one readable line. A shell tool's
 * command is the interesting fact; a file tool's path is; anything else falls
 * back to a compact rendering of its arguments rather than to nothing.
 */
export function callSubject(args: unknown): string {
  if (isObject(args)) {
    for (const key of SUBJECT_KEYS) {
      const value = args[key];
      if (typeof value === "string" && value.trim().length > 0)
        return oneLine(value, SUBJECT_LIMIT);
    }
    const rendered = JSON.stringify(args);
    return rendered.length <= 2 ? "" : oneLine(rendered, SUBJECT_LIMIT);
  }
  return typeof args === "string" ? oneLine(args, SUBJECT_LIMIT) : "";
}

/**
 * What a failed tool call said. Results reach an extension untyped, so this
 * reads the common `content` shape and gives up quietly on anything else: the
 * call is already marked failed, the text is a courtesy.
 */
export function callErrorText(result: unknown, fallback: string): string {
  const parts: string[] = [];
  if (isObject(result)) {
    const content = result.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (isObject(item) && typeof item.text === "string") parts.push(item.text);
      }
    } else if (typeof result.message === "string") {
      parts.push(result.message);
    } else if (typeof result.error === "string") {
      parts.push(result.error);
    }
  } else if (typeof result === "string") {
    parts.push(result);
  }

  const joined = parts.join(" ").trim();
  return joined.length === 0 ? oneLine(fallback, ERROR_LIMIT) : oneLine(joined, ERROR_LIMIT);
}
