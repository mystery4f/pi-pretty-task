/**
 * Text the panel draws: columns, colours and the words behind each cell. Pure
 * functions over records — no terminal, no clock, no store — so a renderer can
 * be read and tested without the panel around it.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  fireLabel,
  formatBytes,
  formatClockTime,
  formatDuration,
} from "../../tasks/base/format.js";
import type {
  CmdLoopTask,
  FireOutcome,
  FireRecord,
  LoopBase,
  PromptLoopTask,
  Task,
  TaskKind,
  TaskStatus,
} from "../../tasks/base/task.js";
import type {
  Iteration,
  IterationCall,
  IterationCallStatus,
  IterationRetry,
  IterationStatus,
} from "../../tasks/loop/iteration.js";
import type { PromptPreview } from "../../tasks/loop/prompt-file.js";
import { STATUS_COLOUR } from "../status-colour.js";
import { DETAIL_OUTPUT_LINES, type PanelTaskView } from "./model.js";

/** Size column: output bytes for a process task; a loop task has no output file. */
export function formatSize(row: PanelTaskView): string {
  return row.task.kind === "process" ? formatBytes(row.outputBytes) : "—";
}

/** The live dot: running is loud, a stopped task is a hollow ring, paused is a warning. */
export function dotColour(task: Task): ThemeColor {
  if (task.status === "running") return STATUS_COLOUR.running;
  if (task.status === "paused") return STATUS_COLOUR.paused;
  return task.status === "completed" ? "dim" : STATUS_COLOUR[task.status];
}

/** Exit column: a process has a code, a loop has fires instead, a chain has steps. */
export function exitText(task: Task): string {
  if (task.kind === "prompt-loop") return "";
  if (task.kind === "chain") return "";
  // A command loop carries the code of its newest fire; the fires themselves are
  // rows in its detail (ADR-0015).
  const code = task.kind === "cmd-loop" ? task.lastExitCode : task.exitCode;
  return code === undefined ? "" : `exit ${String(code)}`;
}

/**
 * The provider retry as one phrase: `retry 2/4`, and the status the failure named
 * when it named one. The denominator is every attempt the turn is allowed — pi's
 * retry budget plus the first try — because `attempt` counts the first try too: a
 * budget of 3 gives four attempts, and the fourth failure is the one pi gives up
 * on. A fire that spent those attempts on a busy provider otherwise reads as one
 * ordinary slow turn (ticket #47).
 */
export function retryText(retry: IterationRetry): string {
  const count = `retry ${String(retry.attempt)}/${String(retry.maxAttempts + 1)}`;
  return retry.status === undefined ? count : `${count} · ${retry.status}`;
}

/**
 * The retry a loop is on right now: only an open turn can be retrying, so a record
 * left behind by a turn that ended — a process that died mid-turn — is not shown as
 * in flight. What a finished turn's retry was is read on its own iteration page.
 */
export function openRetry(task: PromptLoopTask): IterationRetry | undefined {
  const newest = task.iterations[task.iterations.length - 1];
  return newest?.status === "running" ? newest.retry : undefined;
}

/**
 * Right-hand numbers: a process reports runtime, output size and how long ago it last
 * changed; a loop its fires, schedule and the same age. Recency sits on the right so a
 * row that just moved to the top says why (ADR-0010).
 */
// pi-lens-ignore: no-flag-argument -- the flag swaps one cell's text; a second function would repeat the whole layout
export function rightText(
  row: PanelTaskView,
  now: number,
  room = Number.POSITIVE_INFINITY,
  foreign = false,
): string {
  const task = row.task;
  const elapsed = formatDuration(row.elapsedMs);
  const age = ` · ${formatDuration(Math.max(0, now - task.updatedAt))} ago`;
  // Another session's row is here to be read, not managed: the tag that names its
  // session already costs the row width, so its numbers are the runtime and the age,
  // and the runtime alone still fits a narrow terminal (ticket #27).
  if (foreign) {
    const candidates = [`${elapsed}${age}`, elapsed];
    // No candidate fits: the row keeps the room and drops the numbers, because a
    // number drawn past the border costs more than a missing one (ticket #34).
    return candidates.find((candidate) => visibleWidth(candidate) <= room) ?? "";
  }
  if (task.kind === "process") {
    // The numbers give way in the order they matter: the age first, then the size,
    // and the runtime last, so a narrow terminal still says how long it ran. The
    // row is never wrapped and never pushed past its border (ADR-0015).
    const size = formatSize(row);
    const candidates = [`${elapsed} ${size}${age}`, `${elapsed} ${size}`, elapsed];
    return candidates.find((candidate) => visibleWidth(candidate) <= room) ?? "";
  }
  if (task.kind === "chain") {
    // A chain reports its place in the queue: the step it is on, and how many it holds.
    // The steps' own bytes and exit codes read on the step lines of its detail.
    const at = Math.min(task.cursor + 1, task.steps.length);
    const place = `${String(at)}/${String(task.steps.length)}`;
    // The elapsed time and the queue's place outrank the age, which goes first on a
    // narrow row, so a chain still says where it is when the numbers must give way.
    const candidates = [`${elapsed} · ${place}${age}`, `${elapsed} · ${place}`, place, elapsed];
    return candidates.find((candidate) => visibleWidth(candidate) <= room) ?? "";
  }
  // A loop has no exit code and no bytes: it reports the fires it made and how
  // long until the next one, which is the whole question while it is running. A
  // failure streak sits next to the count, and the wait it pushed out is labelled
  // a backoff so the two read together (ADR-0017).
  const streak = failureStreak(task);
  // The streak without its separator, so it can stand alone once the count is gone.
  const streakText = streak === 0 ? "" : `${String(streak)} failed`;
  const failed = streakText === "" ? "" : ` · ${streakText}`;
  // A turn pi is retrying is the loudest thing the row can say about right now: a
  // fire that spent three attempts on a busy provider is not an ordinary slow one
  // (ticket #47). Only prompt loops wake a model, so only they can be retrying.
  const retry = task.kind === "prompt-loop" ? openRetry(task) : undefined;
  const retrying = retry === undefined ? "" : ` · ${retryText(retry)}`;
  const state = `${elapsed} · ${firesText(task)} fires${failed}${retrying}`;
  const backingOff = streak > 0 ? " (backoff)" : "";
  const next =
    row.untilNextFireMs === undefined
      ? undefined
      : ` · next ${formatDuration(row.untilNextFireMs)}`;
  // The state the ticket asks the row to carry is the streak, the retry and the
  // backoff, so the age gives way first, then the word marking the wait a backoff,
  // then the wait itself, and then the fire count. The streak outlives the count: a
  // row that kept `4 fires` and dropped `2 failed` would make a failing loop read as
  // a working one at the very width a reader is skimming, so it is the last thing to
  // go — and a row too narrow even for it drops the numbers instead of crossing the
  // border (ADR-0015, spec story 10, tickets #34 and #50).
  const fires = `${firesText(task)} fires`;
  const keep = streakText === "" ? fires : streakText;
  const candidates = [
    `${state}${next ?? ""}${backingOff}${age}`,
    `${state}${next ?? ""}${backingOff}`,
    ...(next === undefined ? [] : [`${state}${next}`, state]),
    `${fires}${failed}${retrying}`,
    `${keep}${retrying}`,
    keep,
  ];
  return candidates.find((candidate) => visibleWidth(candidate) <= room) ?? "";
}

/** Name colour, as the replaced panel had it: the ending decides, not the kind. */
export function nameColour(task: Task): ThemeColor {
  switch (task.status) {
    case "failed":
      return "error";
    case "killed":
    case "interrupted":
      return "warning";
    case "completed":
      return "success";
    case "paused":
      return "muted";
    default:
      return "text";
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tools whose subject is a command line, so the panel can make them stand out. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["bash", "pretty_task_bg_run"]);

/** Iteration states, read from the one task-status palette. */
export const ITERATION_COLOUR = {
  running: STATUS_COLOUR.running,
  completed: STATUS_COLOUR.completed,
  aborted: STATUS_COLOUR.killed,
  interrupted: STATUS_COLOUR.interrupted,
} satisfies Record<IterationStatus, ThemeColor>;

/** Tool-call states, read from the same palette. */
export const CALL_COLOUR = {
  running: STATUS_COLOUR.running,
  completed: STATUS_COLOUR.completed,
  failed: STATUS_COLOUR.failed,
  aborted: STATUS_COLOUR.killed,
  interrupted: STATUS_COLOUR.interrupted,
} satisfies Record<IterationCallStatus, ThemeColor>;

export function isCommandCall(call: IterationCall): boolean {
  return COMMAND_TOOLS.has(call.tool);
}

export function firesText(task: LoopBase): string {
  if (task.maxFires === undefined) return String(task.fires);
  return `${String(task.fires)} / ${String(task.maxFires)}`;
}
/**
 * Failed fires in a row: a command loop counts a fire that exited non-zero, and a
 * prompt loop one whose turn the provider gave up on (ticket #46) — the same count
 * on the same backoff curve, cleared by the same healthy fire (ADR-0017). A process
 * and a chain have no schedule to fail, so they answer zero.
 */
export function failureStreak(task: Task): number {
  if (task.kind === "cmd-loop" || task.kind === "prompt-loop") {
    return task.consecutiveFailures ?? 0;
  }
  return 0;
}

/** A raised signal on a command loop: the check has something outstanding (ADR-0018). */
export function signalWord(task: Task): string {
  return task.kind === "cmd-loop" && task.signalRaised === true ? "⚑ signal" : "";
}

/** Fires that never ran because the previous one still was, appended to the count. */
export function missedText(task: CmdLoopTask): string {
  const missed = task.missedFires ?? 0;
  return missed === 0 ? "" : ` · ${String(missed)} skipped`;
}

export function nextFireText(task: LoopBase, row: PanelTaskView, backingOff = false): string {
  if (task.nextFireAt === undefined) return "—";
  const at = formatClockTime(task.nextFireAt);
  if (row.untilNextFireMs === undefined) return at;
  const wait = `${formatDuration(row.untilNextFireMs)}${backingOff ? ", backoff" : ""}`;
  return `${at} (in ${wait})`;
}

/** Iteration list heading: kept and dropped counts are both stated, never hidden. */
export function iterationsText(task: PromptLoopTask): string {
  const dropped = task.droppedIterations ?? 0;
  const kept = task.iterations.length;
  if (kept === 0) {
    return dropped === 0
      ? "iterations · none yet"
      : `iterations · none kept · ${String(dropped)} older dropped`;
  }
  const suffix = dropped === 0 ? "" : ` · ${String(dropped)} older dropped`;
  return `iterations · newest first · ${String(kept)} kept${suffix}`;
}

/** Fire list heading: kept and dropped counts are both stated, never hidden. */
export function firesHeading(task: CmdLoopTask): string {
  const kept = task.fireHistory.length;
  const dropped = Math.max(0, task.fires - kept);
  const suffix = dropped === 0 ? "" : ` · ${String(dropped)} older dropped`;
  if (kept === 0) return dropped === 0 ? "fires · none yet" : `fires · none kept${suffix}`;
  return `fires · newest first · ${String(kept)} kept${suffix}`;
}

/** One fire row: number, time, outcome, exit code, duration and bytes (ADR-0015). */
export function fireLine(fire: FireRecord): string {
  const exit =
    fire.exitCode === undefined || fire.exitCode === null
      ? "exit —"
      : `exit ${String(fire.exitCode)}`;
  return [
    // A manual fire prints as `m1`: it is not one of the schedule's fires.
    fireLabel(fire.fire),
    formatClockTime(fire.at),
    fire.outcome,
    exit,
    fire.durationMs === undefined ? "—" : formatDuration(fire.durationMs),
    fire.outputBytes === undefined ? "—" : formatBytes(fire.outputBytes),
  ].join(" · ");
}

/** The glyph a strip cell prints for its outcome; `–` never ran (ADR-0015). */
export const FIRE_MARK = {
  running: "•",
  success: "✓",
  failed: "✗",
  signalled: "⚑",
  skipped: "–",
  interrupted: "!",
} satisfies Record<FireOutcome, string>;

/** Strip colour by outcome: live, done, failed, never-ran, cut short by a stop. */
export const FIRE_COLOUR = {
  running: STATUS_COLOUR.running,
  success: STATUS_COLOUR.completed,
  failed: STATUS_COLOUR.failed,
  signalled: "warning",
  skipped: "muted",
  interrupted: STATUS_COLOUR.interrupted,
} satisfies Record<FireOutcome, ThemeColor>;

/** The mark a chain step carries on its line, one glyph per status it can hold. */
export const STEP_MARK = {
  running: "●",
  paused: "•",
  completed: "✓",
  failed: "✗",
  killed: "■",
  interrupted: "!",
  waiting: "·",
  skipped: "–",
  stopped: "■",
} satisfies Record<TaskStatus, string>;

/** Step colour by status, so a finished step reads as done and a skipped one as absent. */
export function stepColour(status: TaskStatus): ThemeColor {
  switch (status) {
    case "completed":
      return STATUS_COLOUR.completed;
    case "failed":
      return STATUS_COLOUR.failed;
    case "killed":
    case "interrupted":
    case "stopped":
      return STATUS_COLOUR.killed;
    case "running":
      return STATUS_COLOUR.running;
    default:
      return "muted";
  }
}

/**
 * A fire whose turn finished cleanly and recorded no tool call: it spent a model
 * call and moved nothing. A turn cut short — aborted, or interrupted with the
 * process — is not one: it never got the chance to work (ticket #49).
 */
function emptyFire(iteration: Iteration): boolean {
  return iteration.status === "completed" && iteration.calls.length === 0;
}

/**
 * Consecutive fires that made no tool call, counting back from this one through
 * the record's own order (oldest first). One quiet turn is legitimate — a turn
 * may read files and think before acting — so a row marks a fire only from the
 * second one of a run (ticket #49).
 */
function emptyFireRun(iterations: readonly Iteration[], iteration: Iteration): number {
  const end = iterations.findIndex((candidate) => candidate.fire === iteration.fire);
  if (end < 0) return emptyFire(iteration) ? 1 : 0;
  let run = 0;
  for (let index = end; index >= 0; index -= 1) {
    const earlier = iterations[index];
    if (earlier === undefined || !emptyFire(earlier)) break;
    run += 1;
  }
  return run;
}

/**
 * One iteration row: fire number, result, when it ran, what it cost, and — once a
 * second fire in a row made no call — the run that says the loop has stalled.
 */
export function iterationLine(iteration: Iteration, iterations: readonly Iteration[]): string {
  const parts = [
    `fire ${String(iteration.fire)}`,
    iteration.status,
    formatClockTime(iteration.startedAt),
  ];
  if (iteration.endedAt !== undefined) {
    parts.push(formatDuration(iteration.endedAt - iteration.startedAt));
  }
  parts.push(callsText(iteration));
  if (iteration.droppedCalls > 0) {
    parts.push(`+${String(iteration.droppedCalls)} earlier calls dropped`);
  }
  const empty = emptyFireRun(iterations, iteration);
  if (empty > 1) parts.push(`${String(empty)} empty in a row`);
  return parts.join(" · ");
}

/** How many calls the iteration kept; the dropped ones are marked below the list. */
export function callsText(iteration: Iteration): string {
  return iteration.calls.length === 1 ? "1 call" : `${String(iteration.calls.length)} calls`;
}

/**
 * Where the visible call window sits, oldest first. `rows` is how many lines the
 * pane can give the calls, so a short pane reports the shorter range it shows
 * instead of promising rows it never drew.
 */
export function callsHeading(
  iteration: Iteration,
  requested: number,
  rows = DETAIL_OUTPUT_LINES,
): string {
  const total = iteration.calls.length;
  if (total === 0) return "calls · none in this turn";
  const top = callTopFor(iteration, requested, rows);
  const to = Math.min(total, top + rows);
  return `calls ${String(top + 1)}–${String(to)} of ${String(total)} · oldest first`;
}

export function callTopFor(
  iteration: Iteration,
  requested: number,
  rows = DETAIL_OUTPUT_LINES,
): number {
  const oldest = Math.max(0, iteration.calls.length - rows);
  return Math.min(Math.max(0, requested), oldest);
}

/** A free-form field as one line: the panel draws rows, not paragraphs. */
export function singleLine(text: string, maxLength: number): string {
  const oneLine = text.replace(/\s*\n\s*/g, " ").trim();
  return truncateToWidth(oneLine, Math.max(1, maxLength), "…", false);
}

/**
 * Short kind word printed in a row. Search uses the same word, so a reader who
 * sees `llm` can type `llm` and find that row.
 */
export function kindWord(kind: TaskKind): "proc" | "llm" | "cmd" | "chn" {
  // pi-lens-ignore: switch-without-default -- exhaustive over the closed kind union; a default would hide a new kind from the compiler
  switch (kind) {
    case "process":
      return "proc";
    case "prompt-loop":
      return "llm";
    case "cmd-loop":
      return "cmd";
    case "chain":
      // The word a reader types to find a chain once the panel gives it a tab (#27).
      return "chn";
  }
}

/**
 * What a loop page says under the prompt's path. `lines` is at most the three the
 * loop layer trimmed; `changed` carries the file's own time in the same clock the
 * `Updated` row above it uses, so a reader can tell a prompt written a moment ago
 * from one nobody has touched. `problem` is whatever needs saying alongside them:
 * the record's own warning first — a fire that fell back to the creation text
 * leaves behind a file that reads fine again, so the file alone would hide it —
 * and otherwise the file's own state ("the prompt file is empty").
 */
export interface PromptBody {
  readonly lines: readonly string[];
  readonly changed?: string;
  readonly problem?: string;
}

export function promptBody(preview: PromptPreview, warning: string | undefined): PromptBody {
  const changed =
    preview.changedAt === undefined ? undefined : `changed ${formatClockTime(preview.changedAt)}`;
  const problem =
    warning ?? (preview.problem === undefined ? undefined : `the prompt file ${preview.problem}`);
  return {
    lines: preview.lines,
    ...(changed === undefined ? {} : { changed }),
    ...(problem === undefined ? {} : { problem }),
  };
}
