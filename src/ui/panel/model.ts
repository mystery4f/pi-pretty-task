/**
 * The panel's vocabulary: the shape it reads tasks through, the pages and filters
 * a reader walks, the one projection that turns a record into a row, and the words
 * a page says when it is empty. No renderer lives here, so every panel module can
 * share these without importing another one.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Terminal, TUI } from "@earendil-works/pi-tui";
import { elapsedOf } from "../../tasks/base/format.js";
import type { OutputTail } from "../../tasks/base/output.js";
import type { Task } from "../../tasks/base/task.js";
import type { PromptPreview } from "../../tasks/loop/prompt-file.js";

/** Output lines the detail view shows at once. */
/** Output lines a tall panel's detail window shows at once. */
export const DETAIL_OUTPUT_LINES = 12;

/**
 * Output lines a detail keeps even in a short pane: below this the tail says
 * nothing about the run, and the reader is left scrolling blind.
 */
export const DETAIL_MIN_OUTPUT_LINES = 3;

/**
 * Output lines the detail view keeps in hand while the reader scrolls up: more
 * than the visible window, which is what makes scrolling backwards possible.
 */
export const DETAIL_TAIL_LINES = 200;

/** Task rows a tall panel's list draws at once. */
export const LIST_VISIBLE_ROWS = 12;

/** Width of a detail label column, colon included, so the values line up. */
export const LABEL_WIDTH = 12;
/** Width from which a detail keeps a value on the line of its own label. */
export const DETAIL_WIDE_MIN_WIDTH = 60;

/**
 * Rows a boxed page spends besides its body: border, title, subtitle, the blank
 * line above and below the body, the keys and the bottom border.
 */
export const FRAME_ROWS = 7;
/**
 * Rows kept back for a detail's fields before the window under them takes its
 * share: the core facts of a process, rounded up. A pane shorter than this keeps
 * the window at its floor and cuts fields instead, because the output tail is
 * what a reader opens a process to see.
 */
export const DETAIL_FIELD_RESERVE = 11;

/**
 * Rows a panel draws when it cannot measure its pane (no terminal, as in tests):
 * a common terminal height, so a page is planned rather than guessed.
 */
export const DEFAULT_RENDER_ROWS = 50;

/**
/**
 * Rows a list frame spends besides its rows: the header bands (a query line
 * included), the box, the `Showing` line, the hint above the keys and the keys
 * themselves. The worst case, so a long query nor a command in front can push the
 * rows out of the frame. The hint's row is reserved whether or not it is drawn:
 * a takeover must not resize the list under the reader's cursor.
 */
export const LIST_OVERHEAD_ROWS = 10;

/**
 * Share of the terminal height the panel's overlay may take. The command builds
 * its `maxHeight` from this number, so what the panel reserves and what pi lets
 * it draw cannot disagree.
 */
export const PANEL_HEIGHT_SHARE = 0.8;

/** Rows kept clear above and below the overlay: the command's `margin`. */
export const PANEL_MARGIN = 1;

/**
 * Rows the panel may draw in a terminal `rows` high. pi's overlay clamps its
 * `maxHeight` to the terminal less its margins and cuts the frame from the top,
 * so a panel drawing more than this loses its keys and its output tail first.
 */
export function panelHeightBudget(rows: number): number {
  const available = Math.max(1, rows - PANEL_MARGIN * 2);
  const share = Math.floor(rows * PANEL_HEIGHT_SHARE);
  return Math.max(1, Math.min(share, available));
}
/**
 * Rows the list may draw in a pane `height` rows high: what the header bands,
 * the box, the `Showing` line and the keys leave, capped so a tall pane does not
 * spend all of it on rows.
 */
export function listRowsFor(height: number): number {
  return Math.max(1, Math.min(LIST_VISIBLE_ROWS, height - LIST_OVERHEAD_ROWS));
}

/**
 * Rows of a list page for a pane: the paging line costs one row of the window,
 * so a list too long to fit shows one row fewer — the scroll clamp and the
 * renderer both read this, or the last row would stay below the fold.
 */
export function listWindow(
  rowCount: number,
  height: number,
): { readonly rows: number; readonly paged: boolean } {
  const rows = listRowsFor(height);
  const paged = rowCount > rows;
  return { paged, rows: Math.max(1, paged ? rows - 1 : rows) };
}

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

/** What a producer adds to a record beyond what every row shows. */
export interface RowExtras {
  readonly outputBytes?: number;
  readonly untilNextFireMs?: number;
  readonly sessionId?: string;
}

/**
 * One record as the panel reads it: the record plus the numbers the list shows.
 *
 * Every producer of a row — a process view, a loop's countdown, a chain's, a
 * rerun's — hands its record through here, so the shape and the elapsed
 * arithmetic are written once instead of once per kind.
 */
export function rowOf(task: Task, now: number, extras: RowExtras = {}): PanelTaskView {
  return {
    task,
    elapsedMs: elapsedOf(task, now),
    outputBytes: extras.outputBytes ?? 0,
    ...(extras.untilNextFireMs === undefined ? {} : { untilNextFireMs: extras.untilNextFireMs }),
    ...(extras.sessionId === undefined ? {} : { sessionId: extras.sessionId }),
  };
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
   * A prompt loop's file as its page shows it: the path, a few lines and when it
   * last changed. Missing when the panel cannot read prompt files at all; the
   * loop's own layer answers, so the panel never joins a path or opens a file.
   */
  prompt?(id: string, sessionId?: string): Promise<PromptPreview | undefined>;
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
  /**
   * How many commands pi is still waiting on in this session. They are not tasks
   * yet, so they have no row: the hint above the keys is their only trace, and it
   * names the shortcut that moves one away (ADR-0020).
   */
  foreground?(): number;
  /**
   * How many `wait: true` calls are blocked in this session. They are tasks, so
   * they have rows too; the hint counts them with the foreground runs because the
   * same key serves both (ADR-0025).
   */
  blocked?(): number;
}

/**
 * The slice of a terminal the panel uses. The height is optional because a
 * caller may drive the panel without a terminal at all; the panel then keeps the
 * tall default rather than guessing a pane that may not be there.
 */
export type PanelTerminal = Pick<TUI, "requestRender"> & {
  readonly terminal?: Pick<Terminal, "rows">;
};
export interface TasksPanelOptions {
  /** What the panel may ask of the terminal: a repaint, and how tall the pane is. */
  readonly tui: PanelTerminal;
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
export type PanelFilter = "all" | "running" | "signal" | "failed" | "done";

/** The pages in the order `1`, `2`, `3` and the `tab` key walk them. */
export const PANEL_TABS: readonly PanelTab[] = ["processes", "loops", "chains"];

/** The key that opens each page directly, next to the `tab` key that walks them. */
export const TAB_KEY: ReadonlyMap<string, PanelTab> = new Map([
  ["1", "processes"],
  ["2", "loops"],
  ["3", "chains"],
]);

/**
 * The filters in the order `f` walks them, starting from the one the panel opens
 * on. `signal` sits last because it is the narrowest reading of a live row: a
 * command loop with its latch up is still `running` (ADR-0018), so the walk
 * reaches it after the three ordinary endings instead of in the middle of them.
 */
export const PANEL_FILTERS: readonly PanelFilter[] = ["all", "running", "failed", "done", "signal"];

/**
 * The filter a freshly opened panel starts on: every status. A session whose work
 * has all ended must not open on an empty list — the archive is the session too —
 * and `f` narrows to the living rows in one press.
 */
export const DEFAULT_PANEL_FILTER: PanelFilter = "all";

/** The word each page is titled with; the glossary's own names (GLOSSARY.md). */
export const TAB_TITLE = {
  processes: "Processes",
  loops: "Loops",
  chains: "Chains",
} satisfies Record<PanelTab, string>;

/** What a page says when the session holds nothing of its kind at all. */
export const TAB_EMPTY = {
  processes: "No processes here — run a command with pretty_task_bg_run and it appears.",
  loops: "No loops here — a schedule created with pretty_task_loop_create gathers its fires here.",
  chains: "No chains here — queue a step with pretty_task_bg_run's after and the pipeline appears.",
} satisfies Record<PanelTab, string>;

/**
 * What a key says when it would change, rather than read, a row another session
 * owns. One wording for `k`, `a` and `R`, so the rule reads the same wherever met.
 */
export const READ_ONLY = "another session's task is read-only here";
