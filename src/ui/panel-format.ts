/**
 * Text the panel draws: columns, colours and the words behind each cell. Pure
 * functions over records — no terminal, no clock, no store — so a renderer can
 * be read and tested without the panel around it.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatBytes, formatClockTime, formatDuration } from "../tasks/base/format.js";
import type {
  CmdLoopTask,
  FireOutcome,
  FireRecord,
  LoopBase,
  PromptLoopTask,
  Task,
  TaskKind,
  TaskStatus,
} from "../tasks/base/task.js";
import type {
  Iteration,
  IterationCall,
  IterationCallStatus,
  IterationStatus,
} from "../tasks/loop/iteration.js";
import {
  DETAIL_OUTPUT_LINES,
  PANEL_TABS,
  type PanelFilter,
  type PanelTab,
  type PanelTaskView,
  QUERY_MAX_LENGTH,
} from "./panel-model.js";
import { STATUS_COLOUR } from "./status-colour.js";

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

/**
 * The list's keys, widest first (ADR-0012): one model, three lists. A narrow
 * terminal takes a shorter variant whole rather than a cut-off one, so a reader
 * near the right edge never meets half a key (ticket #34).
 */
export const LIST_KEYS: readonly string[] = [
  "↑/↓ · Enter logs · k stop · f filter · o others · 1/2/3 tabs · / search · R rerun · a stop all · alt+q close",
  "↑/↓ · Enter logs · k stop · f filter · o others · 1/2/3 · / search · R rerun · alt+q close",
  "↑/↓ · Enter logs · k stop · f filter · / search · alt+q close",
  "↑/↓ · Enter · k stop · alt+q close",
];

/** The keys under a process detail, widest first, for the same reason as `LIST_KEYS`. */
export const PROCESS_KEYS: readonly string[] = [
  "↑/↓ scroll · r follow · ← list · k stop · R rerun · c path · alt+q close",
  "↑/↓ scroll · r follow · ← list · k stop · R rerun · c · alt+q",
  "↑/↓ · r follow · ← list · k stop · alt+q",
];

/**
 * The footer that fits the room, taken whole: the first candidate that fits wins,
 * and only when none does is the shortest cut. Cutting the long one instead would
 * leave a reader with `alt+q clo` and the border a column off.
 */
export function fittedFooter(candidates: readonly string[], room: number): string {
  const fit = candidates.find((candidate) => visibleWidth(candidate) <= room);
  if (fit !== undefined) return fit;
  const shortest = candidates.at(-1) ?? "";
  return truncateToWidth(shortest, Math.max(1, room), "…", false);
}

export function pad(text: string, width: number): string {
  // Width is pixels, not code units: a CJK or emoji name must not shift the columns.
  const used = visibleWidth(text);
  return used >= width ? truncateToWidth(text, width, "", false) : text + " ".repeat(width - used);
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
    `#${String(fire.fire)}`,
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
  skipped: "–",
  interrupted: "!",
};

/** Strip colour by outcome: live, done, failed, never-ran, cut short by a stop. */
export const FIRE_COLOUR: Record<FireOutcome, ThemeColor> = {
  running: STATUS_COLOUR.running,
  success: STATUS_COLOUR.completed,
  failed: STATUS_COLOUR.failed,
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

/** Where the visible call window sits, oldest first. */
export function callsHeading(iteration: Iteration, requested: number): string {
  const total = iteration.calls.length;
  if (total === 0) return "calls · none in this turn";
  const top = callTopFor(iteration, requested);
  const to = Math.min(total, top + DETAIL_OUTPUT_LINES);
  return `calls ${String(top + 1)}–${String(to)} of ${String(total)} · oldest first`;
}

export function callTopFor(iteration: Iteration, requested: number): number {
  const oldest = Math.max(0, iteration.calls.length - DETAIL_OUTPUT_LINES);
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

/**
 * True when the task is a root row of the given page (ADR-0012). A chain's step and
 * a loop's fire are records with a `parentId`, and they belong to no page's list:
 * the parent's expansion is where they are read (ADR-0014). Processes are the only
 * kind that has children, so the other two kinds are roots by construction.
 */
export function inTab(task: Task, tab: PanelTab): boolean {
  switch (tab) {
    case "processes":
      return task.kind === "process" && task.parentId === undefined;
    case "loops":
      return task.kind === "prompt-loop" || task.kind === "cmd-loop";
    case "chains":
      return task.kind === "chain";
  }
}

/**
 * True when the task answers the status filter. `running` is the word a reader
 * types for live work, and a paused schedule is still live; `done` is every ending
 * that is not a failure, so the four filters partition the endings a reader cares
 * about. A chain counts as running while any step runs, which its own status says
 * (ADR-0014) — the chain is `running` for as long as it has a step left.
 */
export function passesFilter(task: Task, filter: PanelFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "running":
      return task.status === "running" || task.status === "paused";
    case "failed":
      return task.status === "failed";
    case "done":
      return (
        task.status === "completed" ||
        task.status === "killed" ||
        task.status === "interrupted" ||
        task.status === "stopped" ||
        task.status === "skipped"
      );
  }
}

/**
 * The page a keypress asks for: `1`, `2`, `3` name one directly and `tab` walks from
 * the open page to the next, wrapping after the last (ADR-0012). Everything else
 * returns `undefined` and stays a row key.
 */
export function pageKey(data: string, current: PanelTab): PanelTab | undefined {
  const named =
    data === "1" ? "processes" : data === "2" ? "loops" : data === "3" ? "chains" : undefined;
  if (named !== undefined) return named;
  if (matchesKey(data, "tab")) {
    const index = PANEL_TABS.indexOf(current);
    return PANEL_TABS[(index + 1) % PANEL_TABS.length] ?? "processes";
  }
  return undefined;
}

/**
 * True when the query's characters all appear in the field, in order: the match
 * `dbg` makes against `deploy-bg`, where the three letters never sit together.
 */
/** The task field a hit landed in; the row renders the match in the field it can see. */
export type MatchField = "name" | "id" | "status" | "kind" | "step" | "command" | "prompt";

/** Where a row's query landed: the field, how well it scored, and what to light up. */
export interface RowMatch {
  readonly field: MatchField;
  readonly score: number;
  readonly positions: readonly number[];
  /** The hit came from a word the row never prints, so the row has to say so. */
  readonly hidden: boolean;
  /** Which of the chain's steps matched, when the field is a step name. */
  readonly stepIndex?: number;
}

/** One searchable word, with what a hit in it is worth before the match is scored. */
interface SearchField {
  readonly field: MatchField;
  readonly text: string;
  readonly bonus: number;
  readonly hidden: boolean;
  readonly stepIndex?: number;
}

/** How well one field answers the query, and where the matched characters sit. */
interface FieldMatch {
  readonly score: number;
  readonly positions: readonly number[];
}

/** Points for a matched character, before bonuses and the field-length penalty. */
const MATCH_BASE = 4;
const CONSECUTIVE_BONUS = 8;
const WORD_START_BONUS = 10;
/** A gap costs a point per skipped character, but a scattered match never scores below zero. */
const GAP_CAP = 6;
const LENGTH_DIVISOR = 4;

const NAME_BONUS = 8;
const STEP_BONUS = 4;
const ID_BONUS = 3;
/** A hit in a word the row never prints still finds the row, but below anything on screen. */
const HIDDEN_BONUS = 2;
const STATUS_BONUS = 0;

const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const LOWER_CASE_LETTER = /\p{Ll}/u;
const UPPER_CASE_LETTER = /\p{Lu}/u;

/** The first character of a word: the field start, after a separator, or a camel hump. */
function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1] ?? "";
  if (!WORD_CHARACTER.test(before)) return true;
  return LOWER_CASE_LETTER.test(before) && UPPER_CASE_LETTER.test(text[index] ?? "");
}

/**
 * Score a left-to-right match: adjacent characters and word starts are what the
 * reader means, so they earn the most, and the field's length pays a small
 * penalty so an exact short name outranks a hit buried in a sentence.
 */
function scorePositions(text: string, positions: readonly number[]): number {
  let score = -Math.ceil(text.length / LENGTH_DIVISOR);
  let previous = -1;
  for (const at of positions) {
    score += MATCH_BASE;
    if (previous >= 0 && at === previous + 1) score += CONSECUTIVE_BONUS;
    else score -= Math.min(GAP_CAP, at - previous - 1);
    if (isWordStart(text, at)) score += WORD_START_BONUS;
    previous = at;
  }
  return score;
}

/**
 * The positions of the query's characters in the field, in order, or undefined.
 * Greedy left to right: the first home for each character is the tightest one.
 */
function matchPositions(text: string, needle: string): number[] | undefined {
  const positions: number[] = [];
  let from = 0;
  for (let index = 0; index < needle.length; index += 1) {
    const wanted = needle[index] ?? "";
    let at = from;
    while (at < text.length && (text[at] ?? "").toLowerCase() !== wanted) at += 1;
    if (at >= text.length) return undefined;
    positions.push(at);
    from = at + 1;
  }
  return positions;
}

function fuzzyMatch(text: string, needle: string): FieldMatch | undefined {
  const positions = matchPositions(text, needle);
  if (positions === undefined) return undefined;
  return { positions, score: scorePositions(text, positions) };
}

/**
 * The best-scoring field of the task for this query, or undefined when none
 * matches. A name heads the row, so it outranks an id, a status or a command hit
 * at the same tightness; a chain row shows its step names in place of a name, so
 * those rank next, and a prompt or a command is a word the row never prints, so
 * it ranks below everything the reader can see.
 */
export function bestFieldMatch(
  task: Task,
  query: string,
  steps: readonly { name: string; index: number }[] = [],
): RowMatch | undefined {
  const needle = query.toLowerCase();
  // The kind word is the one the row prints, so searching `proc` finds the
  // processes the reader can see and searching `llm` finds the prompt loops; the
  // status word is the string the row colours.
  const kind = kindWord(task.kind);
  // A chain with a queue spends its name column on the steps, so its own name is
  // no longer a word the row prints.
  const nameHidden = task.kind === "chain" && task.steps.length > 0;
  const fields: SearchField[] =
    task.kind === "prompt-loop"
      ? [
          { field: "name", text: task.name, bonus: NAME_BONUS, hidden: false },
          { field: "id", text: task.id, bonus: ID_BONUS, hidden: false },
          { field: "prompt", text: task.prompt, bonus: HIDDEN_BONUS, hidden: true },
          { field: "status", text: task.status, bonus: STATUS_BONUS, hidden: false },
          { field: "kind", text: kind, bonus: STATUS_BONUS, hidden: false },
        ]
      : task.kind === "chain"
        ? // A chain has no command of its own: its row shows the step names it queues,
          // so those are words the reader can see and search for (ADR-0012).
          [
            { field: "name", text: task.name, bonus: NAME_BONUS, hidden: nameHidden },
            { field: "id", text: task.id, bonus: ID_BONUS, hidden: false },
            { field: "status", text: task.status, bonus: STATUS_BONUS, hidden: false },
            { field: "kind", text: kind, bonus: STATUS_BONUS, hidden: false },
            ...steps.map(({ name, index }) => ({
              field: "step" as const,
              text: name,
              bonus: STEP_BONUS,
              hidden: false,
              stepIndex: index,
            })),
          ]
        : [
            { field: "name", text: task.name, bonus: NAME_BONUS, hidden: false },
            { field: "id", text: task.id, bonus: ID_BONUS, hidden: false },
            { field: "command", text: task.command, bonus: HIDDEN_BONUS, hidden: true },
            { field: "status", text: task.status, bonus: STATUS_BONUS, hidden: false },
            { field: "kind", text: kind, bonus: STATUS_BONUS, hidden: false },
          ];
  let best: RowMatch | undefined;
  for (const field of fields) {
    const match = fuzzyMatch(field.text, needle);
    if (match === undefined) continue;
    const score = match.score + field.bonus;
    if (best !== undefined && score <= best.score) continue;
    best = {
      field: field.field,
      score,
      positions: match.positions,
      hidden: field.hidden,
      ...(field.stepIndex === undefined ? {} : { stepIndex: field.stepIndex }),
    };
  }
  return best;
}

/** Bracketed paste, as pi-tui hands it to `handleInput`: ESC [200~ … ESC [201~. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * The pasted text as a query. A newline would otherwise read as Enter and a tab as
 * a key of its own, so both become spaces; the remaining C0 controls are dropped.
 */
export function pastedQuery(data: string): string | undefined {
  if (!data.startsWith(PASTE_START)) return undefined;
  const end = data.indexOf(PASTE_END, PASTE_START.length);
  const text = end === -1 ? data.slice(PASTE_START.length) : data.slice(PASTE_START.length, end);
  return withoutControls(text.replace(/[\n\r\t]/g, " ")).slice(0, QUERY_MAX_LENGTH);
}

/** Drop C0 controls and DEL, which a pasted command may carry but a query must not. */
function withoutControls(text: string): string {
  let kept = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    kept += character;
  }
  return kept;
}

/** A printable keypress; key sequences, Enter and Escape are not part of a query. */
export function typedQuery(data: string): string | undefined {
  if (data.length === 0) return undefined;
  for (const character of data) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return data;
}
