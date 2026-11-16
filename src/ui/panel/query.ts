/**
 * The search query: which field a hit landed in, how well it scored, and what
 * the row should light up.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { Task } from "../../tasks/base/task.js";
import { kindWord } from "./format.js";
import { QUERY_MAX_LENGTH } from "./model.js";

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
