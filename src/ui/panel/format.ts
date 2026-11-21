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
  IterationStatus,
} from "../../tasks/loop/iteration.js";
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
 * Right-hand numbers: a process reports runtime, output size and how long ago it last
 * changed; a loop its fires, schedule and the same age. Recency sits on the right so a
 * row that just moved to the top says why (ADR-0010).
 */
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
  const failed = streak === 0 ? "" : ` · ${String(streak)} failed`;
  const state = `${elapsed} · ${firesText(task)} fires${failed}`;
  const backingOff = streak > 0 ? " (backoff)" : "";
  const next =
    row.untilNextFireMs === undefined
      ? undefined
      : ` · next ${formatDuration(row.untilNextFireMs)}`;
  // The state the ticket asks the row to carry is the streak and the backoff, so
  // the age gives way first, then the word marking the wait a backoff, then the
  // wait itself. The count is the last number to go, and a row too narrow even for
  // it drops the numbers instead of crossing the border (ADR-0015, ticket #34).
  const fires = `${firesText(task)} fires`;
  const candidates = [
    `${state}${next ?? ""}${backingOff}${age}`,
    `${state}${next ?? ""}${backingOff}`,
    ...(next === undefined ? [] : [`${state}${next}`, state]),
    `${fires}${failed}`,
    fires,
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
export const ITERATION_COLOUR: Record<IterationStatus, ThemeColor> = {
  running: STATUS_COLOUR.running,
  completed: STATUS_COLOUR.completed,
  aborted: STATUS_COLOUR.killed,
  interrupted: STATUS_COLOUR.interrupted,
};

/** Tool-call states, read from the same palette. */
export const CALL_COLOUR: Record<IterationCallStatus, ThemeColor> = {
  running: STATUS_COLOUR.running,
  completed: STATUS_COLOUR.completed,
  failed: STATUS_COLOUR.failed,
  aborted: STATUS_COLOUR.killed,
  interrupted: STATUS_COLOUR.interrupted,
};

export function isCommandCall(call: IterationCall): boolean {
  return COMMAND_TOOLS.has(call.tool);
}

export function firesText(task: LoopBase): string {
  if (task.maxFires === undefined) return String(task.fires);
  return `${String(task.fires)} / ${String(task.maxFires)}`;
}
/**
 * Failed fires in a row on a command loop. Only a fire that ran can fail, so an
 * prompt loop never carries a streak and its rows never claim one (ADR-0017).
 */
export function failureStreak(task: Task): number {
  return task.kind === "cmd-loop" ? (task.consecutiveFailures ?? 0) : 0;
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
export const FIRE_MARK: Record<FireOutcome, string> = {
  running: "•",
  success: "✓",
  failed: "✗",
  signalled: "⚑",
  skipped: "–",
  interrupted: "!",
};

/** Strip colour by outcome: live, done, failed, never-ran, cut short by a stop. */
export const FIRE_COLOUR: Record<FireOutcome, ThemeColor> = {
  running: STATUS_COLOUR.running,
  success: STATUS_COLOUR.completed,
  failed: STATUS_COLOUR.failed,
  signalled: "warning",
  skipped: "muted",
  interrupted: STATUS_COLOUR.interrupted,
};

/** The mark a chain step carries on its line, one glyph per status it can hold. */
export const STEP_MARK: Record<TaskStatus, string> = {
  running: "●",
  paused: "•",
  completed: "✓",
  failed: "✗",
  killed: "■",
  interrupted: "!",
  waiting: "·",
  skipped: "–",
  stopped: "■",
};

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

/** One iteration row: fire number, result, when it ran, and what it cost. */
export function iterationLine(iteration: Iteration): string {
  const parts = [
    `fire ${String(iteration.fire)}`,
    iteration.status,
    formatClockTime(iteration.startedAt),
  ];
  if (iteration.endedAt !== undefined) {
    parts.push(formatDuration(iteration.endedAt - iteration.startedAt));
  }
  parts.push(iteration.calls.length === 1 ? "1 call" : `${String(iteration.calls.length)} calls`);
  if (iteration.droppedCalls > 0) {
    parts.push(`+${String(iteration.droppedCalls)} earlier calls dropped`);
  }
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
