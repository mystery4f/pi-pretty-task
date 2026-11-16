/**
 * The panel's vocabulary: the shape it reads tasks through, the pages and filters
 * a reader walks, and the words a page says when it is empty. Types and constants
 * only, so every panel module can share them without importing another renderer.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { OutputTail } from "../tasks/base/output.js";
import type { Task } from "../tasks/base/task.js";

/** Output lines the detail view shows at once. */
export const DETAIL_OUTPUT_LINES = 12;

/**
 * Output lines the detail view keeps in hand while the reader scrolls up: more
 * than the visible window, which is what makes scrolling backwards possible.
 */
export const DETAIL_TAIL_LINES = 200;

/** Task rows drawn at once in the list. */
export const LIST_VISIBLE_ROWS = 12;

/** Width of a detail label column, colon included, so the values line up. */
export const LABEL_WIDTH = 12;

/** An id carries its kind, so the column holds all of `bg-1a2cf` and pads the old six. */
export const ID_COLUMN_WIDTH = 8;

/** Longest query a reader can paste or type; more than this is a command, not a filter. */
export const QUERY_MAX_LENGTH = 120;

/** Fires the list row's strip shows: the newest three, oldest at the left (ADR-0015). */
export const STRIP_CELLS = 3;

/** One task as the panel reads it: the record plus the numbers the list shows. */
export interface PanelTaskView {
  readonly task: Task;
  readonly elapsedMs: number;
  readonly outputBytes: number;
  /** A running loop's countdown to the next fire, when the store knows it. */
  readonly untilNextFireMs?: number;
  /**
   * The session the record belongs to, when it is not this panel's own. A tagged
   * row is shown only once `o` asks for the other sessions, and only to be read.
   */
  readonly sessionId?: string;
}

/** What a stop attempt produced, or `undefined` when there is no such task. */
export interface PanelStopResult {
  /** `killed`, `already-finished` or `tree-survived`, as the store reported it. */
  readonly outcome: string;
  readonly view: PanelTaskView;
  readonly detail?: string;
}

/**
 * Everything the panel needs from the outside world. The store adapter
 * (`tasks-command.ts`) implements it; tests implement it with fixtures.
 */
export interface PanelSource {
  /** The session this panel belongs to; `others` rows carry their own instead. */
  readonly sessionId?: string;
  /** Every task in the session, in any order; the panel sorts newest first. */
  list(): Promise<readonly PanelTaskView[]>;
  /**
   * The roots of the other sessions working in the same checkout, each tagged with
   * its session. Missing when the panel cannot see them; `o` then says so.
   */
  others?(): Promise<readonly PanelTaskView[]>;
  /**
   * Trailing output for one process task; an absent file is an empty tail, not an
   * error. The session names whose store to read, for a row shown by `o`.
   */
  tail(id: string, sessionId?: string): Promise<OutputTail | undefined>;
  /** Stop one task; the store ends a process tree or a loop schedule, the panel never acts. */
  stop(id: string): Promise<PanelStopResult | undefined>;
  /**
   * Run one task's command again as a new task; absent when the panel cannot start
   * anything (a read-only view), in which case `R` says so instead of failing.
   */
  rerun?(id: string): Promise<PanelTaskView | undefined>;
}

export interface TasksPanelOptions {
  readonly tui: Pick<TUI, "requestRender">;
  readonly theme: Theme;
  /** Called once when the panel should close; pi then disposes the component. */
  readonly done: () => void;
  readonly source: PanelSource;
  /** Refresh period in milliseconds; 0 disables the tick, letting tests drive refreshes. */
  readonly refreshMs?: number;
  /** Clock for the ages shown on rows and details; tests pin it to a fixed time. */
  readonly now?: () => number;
}

/** List → task detail → iteration detail; the third level exists only under a loop. */
export type PanelMode = "list" | "detail" | "iteration";

/**
 * The panel's three pages (ADR-0012). Every record belongs to one page, and a child
 * record — a fire or a chain's step — belongs to none: it is read through its parent.
 */
export type PanelTab = "processes" | "loops" | "chains";

/** The status filter `f` cycles, applied inside whichever page is open (ADR-0012). */
export type PanelFilter = "all" | "running" | "failed" | "done";

/** The pages in the order `1`, `2`, `3` and the `tab` key walk them. */
export const PANEL_TABS: readonly PanelTab[] = ["processes", "loops", "chains"];

/** The filters in the order `f` walks them, starting from the one the panel opens on. */
export const PANEL_FILTERS: readonly PanelFilter[] = ["all", "running", "failed", "done"];

/** The filter a freshly opened panel starts on: live work, not the archive. */
export const DEFAULT_PANEL_FILTER: PanelFilter = "running";

/** The word each page is titled with; the glossary's own names (GLOSSARY.md). */
export const TAB_TITLE: Record<PanelTab, string> = {
  processes: "Processes",
  loops: "Loops",
  chains: "Chains",
};

/** What a page says when the session holds nothing of its kind at all. */
export const TAB_EMPTY: Record<PanelTab, string> = {
  processes: "No processes here — run a command with pretty_task_bg_run and it appears.",
  loops: "No loops here — a schedule created with pretty_task_loop_create gathers its fires here.",
  chains: "No chains here — queue a step with pretty_task_bg_run's after and the pipeline appears.",
};

/**
 * What a key says when it would change, rather than read, a row another session
 * owns. One wording for `k`, `a` and `R`, so the rule reads the same wherever met.
 */
export const READ_ONLY = "another session's task is read-only here";
