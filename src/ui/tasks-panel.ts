/**
 * The `/tasks` panel: one overlay over every task in the session, list and detail.
 *
 * It is a plain pi-tui `Component` with no state of its own beyond keys and
 * pixels: records and processes belong to the store, and the panel reaches them
 * only through `PanelSource`. Nothing here signals a process or touches a file.
 *
 * Both kinds share one table and one key set. A loop task opens onto its
 * iterations, newest first; an iteration opens onto the tool calls that turn
 * made, in order — the panel only renders records the loop store already kept.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { formatBytes, formatClockTime, formatDuration } from "../tasks/base/format.js";
import type { OutputTail } from "../tasks/base/output.js";
import type {
  ChainTask,
  CmdLoopTask,
  FireOutcome,
  FireRecord,
  LlmLoopTask,
  LoopBase,
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
import { STATUS_COLOUR } from "./status-colour.js";

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
const LABEL_WIDTH = 12;

/** An id carries its kind, so the column holds all of `bg-1a2cf` and pads the old six. */
const ID_COLUMN_WIDTH = 8;

/** Refresh period; the tail of a running task should look alive. */
const REFRESH_MS = 1000;

/** Longest query a reader can paste or type; more than this is a command, not a filter. */
const QUERY_MAX_LENGTH = 120;

/** Fires the list row's strip shows: the newest three, oldest at the left (ADR-0015). */
const STRIP_CELLS = 3;

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
type PanelMode = "list" | "detail" | "iteration";

/**
 * The panel's three pages (ADR-0012). Every record belongs to one page, and a child
 * record — a fire or a chain's step — belongs to none: it is read through its parent.
 */
export type PanelTab = "processes" | "loops" | "chains";

/** The status filter `f` cycles, applied inside whichever page is open (ADR-0012). */
export type PanelFilter = "all" | "running" | "failed" | "done";

/** The pages in the order `1`, `2`, `3` and the `tab` key walk them. */
export const PANEL_TABS: readonly PanelTab[] = ["processes", "loops", "chains"];

/** The filters in the order `f` walks them, opening on the widest one. */
export const PANEL_FILTERS: readonly PanelFilter[] = ["all", "running", "failed", "done"];

/** The word each page is titled with; the glossary's own names (GLOSSARY.md). */
const TAB_TITLE: Record<PanelTab, string> = {
  processes: "Processes",
  loops: "Loops",
  chains: "Chains",
};

/** What a page says when the session holds nothing of its kind at all. */
const TAB_EMPTY: Record<PanelTab, string> = {
  processes: "No processes here — run a command with bg_run and it appears.",
  loops: "No loops here — a schedule created with loop_create gathers its fires here.",
  chains: "No chains here — queue a step with bg_run's after and the pipeline appears.",
};

/**
 * What a key says when it would change, rather than read, a row another session
 * owns. One wording for `k`, `a` and `R`, so the rule reads the same wherever met.
 */
const READ_ONLY = "another session's task is read-only here";

/**
 * The page a reopened panel lands on: the last one a reader used (ADR-0012). It
 * lives outside the component because pi builds a fresh panel every time.
 */
let rememberedTab: PanelTab = "processes";

/** The page a new panel opens on. */
export function lastPanelTab(): PanelTab {
  return rememberedTab;
}

/** Put the remembered page back; a test resets it, and only a tab key changes it. */
export function rememberPanelTab(tab: PanelTab): void {
  rememberedTab = tab;
}
/**
 * Most recently changed first, not most recently created: a task that just ended
 * or just fired is what the reader wants, while a long job that only grew would
 * otherwise sink under every fresh row (ADR-0010).
 */
function mostRecentlyChangedFirst(left: PanelTaskView, right: PanelTaskView): number {
  return right.task.updatedAt - left.task.updatedAt;
}

/** Whitespace-free lines of an output tail, newest last. */
function tailLines(text: string, count: number): string[] {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(Math.max(0, lines.length - count));
}

export class TasksPanel implements Component {
  private readonly tui: Pick<TUI, "requestRender">;
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly source: PanelSource;
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval> | undefined;

  private mode: PanelMode = "list";
  /** Width of the frame being drawn; field values are cut against it. */
  private renderWidth = 80;
  /** What the reader may open: the filter has already been applied. */
  private rows: readonly PanelTaskView[] = [];
  /** Every row of the session, so the counts never depend on the filters. */
  private allRows: readonly PanelTaskView[] = [];
  /** The page being read; a reopened panel starts on the remembered one (ADR-0012). */
  private tab: PanelTab = rememberedTab;
  /** The status filter `f` cycles, applied inside the open page. */
  private filter: PanelFilter = "all";
  /**
   * Whether `o` has brought in the other sessions working in this checkout. Their
   * rows are read-only and tagged, and the counts above never include them.
   */
  private showOthers = false;
  /** Roots of the other sessions, loaded on demand and merged into the page. */
  private otherRows: PanelTaskView[] = [];
  /**
   * What each page had selected when the reader left it, keyed by page. Reopening a
   * page lands where it was left rather than at the top (ADR-0012 keeps selection by id).
   */
  private readonly selectedByTab: Record<PanelTab, string | undefined> = {
    processes: undefined,
    loops: undefined,
    chains: undefined,
  };
  private selectedId: string | undefined;
  private listTop = 0;
  /** `/` turns keys into a query instead of navigation; `alt+q` leaves it. */
  private searching = false;
  /** The query outlives search mode: leaving keeps it, and the header keeps showing it. */
  private query = "";
  /** Where each shown row's query landed; empty when there is no query. */
  private readonly matchScores = new Map<PanelTaskView, RowMatch>();

  private detailId: string | undefined;
  private detailLines: readonly string[] = [];
  private detailTruncated = false;
  private detailError: string | undefined;
  /** Lines the reader has scrolled up from the newest; 0 follows the tail. */
  private scrollBack = 0;
  /** False while scrolled up: the buffer stays frozen so the view does not move. */
  private following = true;

  /** Which iteration of the open loop is selected, by fire number. */
  private iterationFire: number | undefined;
  /** First iteration row drawn in the loop detail's newest-first list. */
  private iterationTop = 0;
  /** First call drawn in the iteration view, counted from the oldest call. */
  private callTop = 0;

  private notice: string | undefined;
  /** Bytes each task had at the previous refresh, so the list can show `+4.1KB ↑`. */
  private readonly lastBytes = new Map<string, number>();
  private readonly recentGrowth = new Map<string, { bytes: number; at: number }>();
  /** Serialises async work so a keypress never races the refresh it started. */
  private pending: Promise<void> = Promise.resolve();

  constructor(options: TasksPanelOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.done = options.done;
    this.source = options.source;
    this.now = options.now ?? Date.now;
    const refreshMs = options.refreshMs ?? REFRESH_MS;
    if (refreshMs > 0) {
      this.timer = setInterval(() => {
        this.enqueue(async () => {
          await this.refresh();
          this.paint();
        });
      }, refreshMs);
      // Never hold the process open just because the panel is watching it.
      this.timer.unref?.();
    }
    this.enqueue(async () => {
      await this.refresh();
      this.paint();
    });
  }

  /** Resolves once every queued action has finished; a seam for deterministic tests. */
  settle(): Promise<void> {
    return this.pending;
  }

  /** Reload rows, and the detail tail while it is being followed. */
  async refresh(): Promise<void> {
    try {
      this.allRows = [...(await this.source.list())].sort(mostRecentlyChangedFirst);
      // The other sessions are read only when `o` asked for them, and a failure to
      // read one of them must never empty the rows this session does own.
      this.otherRows =
        this.showOthers && this.source.others !== undefined
          ? [...(await this.source.others())]
          : [];
      this.applyFilters();
    } catch {
      // A store that cannot list is a store with nothing to show, not a crash.
      this.rows = [];
    }
    this.trackGrowth();

    this.keepSelection();
    if (this.mode === "detail" && this.following && this.detailRow()?.task.kind === "process") {
      await this.readTail();
    }
    if (this.mode === "iteration") {
      const open = this.detailRow();
      if (
        open === undefined ||
        open.task.kind !== "llm-loop" ||
        this.currentIteration(open.task) === undefined
      ) {
        // The open iteration fell out of the store's history cap, or its loop vanished.
        this.mode = "detail";
      }
    }
  }

  /**
   * Recompute what the reader may open: the page's roots, then the status filter,
   * then the query. A child record is never a row, so a fire or a step can never
   * pull its parent in (ADR-0014); the counts stay over every record and never
   * follow either narrowing (ADR-0012).
   */
  private applyFilters(): void {
    this.matchScores.clear();
    const page = (rows: readonly PanelTaskView[]): PanelTaskView[] =>
      rows
        .filter((row) => inTab(row.task, this.tab))
        .filter((row) => passesFilter(row.task, this.filter))
        .filter((row) => {
          if (this.query.length === 0) return true;
          const match = this.matchField(row.task);
          if (match === undefined) return false;
          this.matchScores.set(row, match);
          return true;
        });
    // Another session's rows join the page only behind `o`, and they obey the same
    // page, filter and query as this session's own, so a search never reaches across
    // into another session by accident (ticket #27).
    const shown = [...page(this.allRows), ...page(this.otherRows)];
    this.rows =
      this.query.length === 0
        ? shown.sort(mostRecentlyChangedFirst)
        : shown.sort((left, right) => {
            const byMatch =
              (this.matchScores.get(right)?.score ?? 0) - (this.matchScores.get(left)?.score ?? 0);
            return byMatch !== 0 ? byMatch : mostRecentlyChangedFirst(left, right);
          });
    this.keepSelection();
  }

  /**
   * Where the query lands on a row, or undefined when it misses. A chain row
   * displays its step names, so those are matchable words; nothing a row does not
   * display — a step's command, a fire's id — can bring a row back (ticket #27).
   */
  private matchField(task: Task): RowMatch | undefined {
    const steps =
      task.kind === "chain"
        ? task.steps.flatMap((id, index) => {
            const name = this.stepRecord(id)?.name ?? "";
            return name === "" ? [] : [{ name, index }];
          })
        : [];
    return bestFieldMatch(task, this.query, steps);
  }

  /** Hold the selected task across a refresh, or fall back to the first row. */
  private keepSelection(): void {
    if (!this.rows.some((row) => row.task.id === this.selectedId)) {
      this.selectedId = this.rows[0]?.task.id;
      this.listTop = 0;
    }
  }
  /**
   * Remember how much each task grew since the last look, so a list row can say
   * `+4.1KB ↑` the way a file manager shows a download. A finished task keeps its
   * final size and shows no arrow.
   */
  private trackGrowth(): void {
    const now = Date.now();
    for (const row of this.rows) {
      const before = this.lastBytes.get(row.task.id);
      this.lastBytes.set(row.task.id, row.outputBytes);
      if (before === undefined || row.outputBytes <= before) continue;
      this.recentGrowth.set(row.task.id, { bytes: row.outputBytes - before, at: now });
    }
  }

  /** The `+size ↑` a still-growing task shows for a few seconds after a refresh. */
  private growthText(row: PanelTaskView): string {
    const recent = this.recentGrowth.get(row.task.id);
    if (recent === undefined || Date.now() - recent.at >= 3000) return "";
    return ` ${this.theme.fg("warning", `+${formatBytes(recent.bytes)} ↑`)}`;
  }
  render(width: number): string[] {
    // Field values are cut against the frame they sit in, so the frame never has to
    // re-measure text that already carries colour.
    this.renderWidth = width;
    if (this.mode === "iteration") return this.renderIterationDetail(width);
    return this.mode === "detail" ? this.renderDetail(width) : this.renderList(width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "alt+q")) {
      // Leaving search keeps the query, which the header goes on showing; a second
      // press closes the panel, exactly as `x` does.
      if (this.mode === "list" && this.searching) {
        this.searching = false;
        this.paint();
        return;
      }
      this.done();
      return;
    }
    // `1`, `2`, `3` and `tab` pick a page from any view, search mode included:
    // a page key is never a character a query wanted. All three pages share this
    // one keyboard model (ADR-0012), so the keys sit above the mode dispatch.
    if (!this.searching) {
      const page = pageKey(data, this.tab);
      if (page !== undefined) {
        this.selectTab(page);
        return;
      }
    }
    // `x` closes from the list only: a detail view is left with alt+q (or ←), and a
    // character typed into a query is never a command.
    if (data === "x" && this.mode === "list" && !this.searching) {
      this.done();
      return;
    }
    if (this.mode === "iteration") this.handleIterationInput(data);
    else if (this.mode === "detail") this.handleDetailInput(data);
    else if (this.searching) this.handleSearchInput(data);
    else this.handleListInput(data);
  }

  invalidate(): void {
    this.paint();
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  // ---- input ---------------------------------------------------------------

  private handleListInput(data: string): void {
    if (data === "/") {
      this.searching = true;
      this.paint();
      return;
    }
    if (matchesKey(data, "up")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.moveSelection(-LIST_VISIBLE_ROWS);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.moveSelection(LIST_VISIBLE_ROWS);
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "right")) {
      this.openDetail();
      return;
    }
    if (data === "k") this.stopSelected();
    if (data === "a") this.stopAll();
    if (data === "f") this.cycleFilter();
    if (data === "o") this.toggleOthers();
    if (data === "R") this.rerunSelected();
    if (data === "c") this.showOutputPath();
  }

  /**
   * A query is typed, not navigated: the panel only filters. Paste arrives as one
   * bracketed sequence, so its newlines must not read as Enter presses.
   */
  private handleSearchInput(data: string): void {
    if (data === "\x7f" || data === "\b") {
      this.setQuery(this.query.slice(0, -1));
      return;
    }
    const pasted = pastedQuery(data);
    if (pasted !== undefined) {
      this.setQuery(`${this.query}${pasted}`);
      return;
    }
    const typed = typedQuery(data);
    if (typed !== undefined) this.setQuery(`${this.query}${typed}`);
  }

  /** Set the query, filter on it at once, and paint without going through the store. */
  private setQuery(query: string): void {
    this.query = query.slice(0, QUERY_MAX_LENGTH);
    this.applyFilters();
    this.paint();
  }

  private handleDetailInput(data: string): void {
    const row = this.detailRow();
    if (row?.task.kind === "llm-loop") {
      this.handleLoopDetailInput(data, row.task);
      return;
    }
    if (row?.task.kind === "cmd-loop") {
      this.handleCmdLoopDetailInput(data, row.task);
      return;
    }
    this.handleProcessDetailInput(data);
  }

  /** A process detail scrolls its output; a loop detail walks its iterations instead. */
  private handleProcessDetailInput(data: string): void {
    if (matchesKey(data, "left")) {
      const task = this.detailRow()?.task;
      if (task?.kind === "process" && task.parentId !== undefined) {
        // A fire opened from its loop: the left arrow goes back to that loop, so
        // the reader never loses the schedule behind the run (ADR-0014).
        this.detailId = task.parentId;
        this.paint();
        return;
      }
      this.mode = "list";
      return;
    }
    if (matchesKey(data, "up")) {
      this.scrollDetail(1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.scrollDetail(-1);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.scrollDetail(DETAIL_OUTPUT_LINES);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.scrollDetail(-DETAIL_OUTPUT_LINES);
      return;
    }
    if (data === "r") {
      this.follow();
      return;
    }
    if (data === "k") this.stopSelected();
    if (data === "R") this.rerunSelected();
    if (data === "c") this.showOutputPath();
  }

  private handleLoopDetailInput(data: string, task: LlmLoopTask): void {
    if (matchesKey(data, "left")) {
      this.mode = "list";
      this.iterationTop = 0;
      this.callTop = 0;
      this.paint();
      return;
    }
    if (matchesKey(data, "up")) {
      this.moveIteration(-1, task);
      return;
    }
    if (matchesKey(data, "down")) {
      this.moveIteration(1, task);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.moveIteration(-LIST_VISIBLE_ROWS, task);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.moveIteration(LIST_VISIBLE_ROWS, task);
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "right")) {
      this.openIteration();
      return;
    }
    if (data === "k") this.stopSelected();
  }

  /**
   * A command loop detail walks its fires newest first; Enter opens the selected
   * fire's own process record, an ordinary task detail (ADR-0014).
   */
  private handleCmdLoopDetailInput(data: string, task: CmdLoopTask): void {
    if (matchesKey(data, "left")) {
      this.mode = "list";
      this.iterationTop = 0;
      this.paint();
      return;
    }
    if (matchesKey(data, "up")) {
      this.moveFire(-1, task);
      return;
    }
    if (matchesKey(data, "down")) {
      this.moveFire(1, task);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.moveFire(-LIST_VISIBLE_ROWS, task);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.moveFire(LIST_VISIBLE_ROWS, task);
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "right")) {
      this.openFire();
      return;
    }
    // On the loop row `k` stops the schedule and cascades to its running fire.
    if (data === "k") this.stopSelected();
  }

  /** Walk the newest-first fire list, keeping the selected row on screen. */
  private moveFire(delta: number, task: CmdLoopTask): void {
    const newestFirst = [...task.fireHistory].reverse();
    if (newestFirst.length === 0) return;
    const selected = this.currentFire(task);
    const current = newestFirst.findIndex((fire) => fire.fire === selected?.fire);
    const base = current === -1 ? 0 : current;
    const next = Math.min(newestFirst.length - 1, Math.max(0, base + delta));
    const chosen = newestFirst[next];
    if (chosen === undefined) return;
    this.iterationFire = chosen.fire;
    if (next < this.iterationTop) this.iterationTop = next;
    if (next >= this.iterationTop + LIST_VISIBLE_ROWS) {
      this.iterationTop = next - LIST_VISIBLE_ROWS + 1;
    }
    this.paint();
  }

  /** Enter on a fire: its process record, or a notice when it never ran. */
  private openFire(): void {
    const row = this.detailRow();
    if (row === undefined || row.task.kind !== "cmd-loop") return;
    const fire = this.currentFire(row.task);
    if (fire === undefined) {
      this.notice = "No fire to open yet — this loop has not fired.";
      this.paint();
      return;
    }
    if (fire.taskId === undefined) {
      this.notice =
        fire.outcome === "skipped"
          ? `fire #${String(fire.fire)} was skipped: the previous fire was still running.`
          : `fire #${String(fire.fire)} left no process record (${fire.outcome}).`;
      this.paint();
      return;
    }
    this.iterationFire = fire.fire;
    this.detailId = fire.taskId;
    this.mode = "detail";
    this.following = true;
    this.scrollBack = 0;
    this.enqueue(async () => {
      await this.readTail();
      this.paint();
    });
  }

  /** The iteration view scrolls the turn's calls; the left arrow goes back to the loop. */
  private handleIterationInput(data: string): void {
    if (matchesKey(data, "left")) {
      this.mode = "detail";
      this.callTop = 0;
      this.paint();
      return;
    }
    if (matchesKey(data, "up")) {
      this.scrollCalls(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.scrollCalls(1);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.scrollCalls(-DETAIL_OUTPUT_LINES);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.scrollCalls(DETAIL_OUTPUT_LINES);
      return;
    }
    if (data === "k") this.stopSelected();
  }

  /** Walk the newest-first iteration list, keeping the selected row on screen. */
  private moveIteration(delta: number, task: LlmLoopTask): void {
    const newestFirst = [...task.iterations].reverse();
    if (newestFirst.length === 0) return;
    const selected = this.currentIteration(task);
    const current = newestFirst.findIndex((iteration) => iteration.fire === selected?.fire);
    const base = current === -1 ? 0 : current;
    const next = Math.min(newestFirst.length - 1, Math.max(0, base + delta));
    const chosen = newestFirst[next];
    if (chosen === undefined) return;
    this.iterationFire = chosen.fire;
    if (next < this.iterationTop) this.iterationTop = next;
    if (next >= this.iterationTop + LIST_VISIBLE_ROWS) {
      this.iterationTop = next - LIST_VISIBLE_ROWS + 1;
    }
    this.paint();
  }

  private openIteration(): void {
    const row = this.detailRow();
    if (row === undefined || row.task.kind !== "llm-loop") return;
    const iteration = this.currentIteration(row.task);
    if (iteration === undefined) {
      this.notice = "No iteration to open yet — this loop has not fired.";
      this.paint();
      return;
    }
    this.iterationFire = iteration.fire;
    this.callTop = 0;
    this.mode = "iteration";
    this.paint();
  }

  private scrollCalls(delta: number): void {
    const row = this.detailRow();
    if (row === undefined || row.task.kind !== "llm-loop") return;
    const iteration = this.currentIteration(row.task);
    if (iteration === undefined) return;
    const oldest = Math.max(0, iteration.calls.length - DETAIL_OUTPUT_LINES);
    const next = Math.min(oldest, Math.max(0, this.callTop + delta));
    if (next === this.callTop) return;
    this.callTop = next;
    this.paint();
  }

  private moveSelection(delta: number): void {
    if (this.rows.length === 0) return;
    const current = this.rows.findIndex((row) => row.task.id === this.selectedId);
    const base = current === -1 ? 0 : current;
    const next = Math.min(this.rows.length - 1, Math.max(0, base + delta));
    this.selectedId = this.rows[next]?.task.id;
    if (next < this.listTop) this.listTop = next;
    if (next >= this.listTop + LIST_VISIBLE_ROWS) this.listTop = next - LIST_VISIBLE_ROWS + 1;
    this.paint();
  }

  private openDetail(): void {
    if (this.rows.length === 0) {
      this.notice = "No tasks to open yet — run a command with bg_run and it appears here.";
      this.paint();
      return;
    }
    this.detailId = this.selectedId;
    this.mode = "detail";
    this.following = true;
    this.scrollBack = 0;
    this.callTop = 0;
    const row = this.detailRow();
    // A loop opens on its newest history row; a process opens on its output tail.
    this.iterationFire =
      row?.task.kind === "llm-loop"
        ? row.task.iterations.at(-1)?.fire
        : row?.task.kind === "cmd-loop"
          ? row.task.fireHistory.at(-1)?.fire
          : undefined;
    this.iterationTop = 0;
    this.enqueue(async () => {
      await this.readTail();
      this.paint();
    });
  }

  /** Scroll up (`delta > 0`) or down from the newest line, freezing on the way up. */
  private scrollDetail(delta: number): void {
    const oldest = Math.max(0, this.detailLines.length - DETAIL_OUTPUT_LINES);
    const next = Math.min(oldest, Math.max(0, this.scrollBack + delta));
    if (next === this.scrollBack) return;
    this.scrollBack = next;
    if (next > 0) {
      // Scrolled up: the buffer is frozen so the reader's place stays put.
      this.following = false;
      this.paint();
      return;
    }
    // Back at the newest line: the tail moves again, freshly read.
    this.follow();
  }

  private follow(): void {
    this.following = true;
    this.scrollBack = 0;
    this.enqueue(async () => {
      await this.readTail();
      this.paint();
    });
  }

  private stopSelected(): void {
    // In a task detail `k` stops what is open: an expanded fire is its own record,
    // so stopping it must not end the schedule behind it (ADR-0015).
    const row = this.mode === "detail" ? this.detailRow() : this.rows[this.selectedIndex()];
    const id = row?.task.id;
    if (id === undefined) return;
    // Another session's task belongs to that session: this panel may read it, never
    // end it, so `k` says why and leaves the store alone (ticket #27).
    if (this.foreign(row)) {
      this.notice = READ_ONLY;
      this.paint();
      return;
    }
    this.enqueue(async () => {
      let result: PanelStopResult | undefined;
      try {
        result = await this.source.stop(id);
      } catch (error) {
        this.notice = `stop failed: ${messageOf(error)}`;
        this.paint();
        return;
      }
      if (result === undefined) {
        this.notice = `no such task: ${id}`;
      } else {
        const detail = result.detail === undefined ? "" : ` · ${result.detail}`;
        this.notice = `stopped ${id} · ${result.outcome}${detail}`;
      }
      await this.refresh();
      this.paint();
    });
  }

  /** `a` stops every row the list shows, one store call at a time. */
  private stopAll(): void {
    // `o` can put another session's rows on the page, and `a` stops only the ones
    // this session owns: the rest are there to be read (ticket #27).
    const ids = this.rows.filter((row) => !this.foreign(row)).map((row) => row.task.id);
    if (ids.length === 0) {
      this.notice = this.rows.length === 0 ? "No tasks to stop." : READ_ONLY;
      this.paint();
      return;
    }
    this.enqueue(async () => {
      let stopped = 0;
      let failed = 0;
      for (const id of ids) {
        try {
          const result = await this.source.stop(id);
          if (result === undefined) failed += 1;
          else stopped += 1;
        } catch {
          failed += 1;
        }
      }
      // A stop that finds nothing is not a failure the reader can act on, so the
      // notice names both counts and leaves the detail in the rows themselves.
      this.notice =
        failed === 0
          ? `stopped ${String(stopped)} tasks`
          : `stopped ${String(stopped)} · ${String(failed)} could not be stopped`;
      await this.refresh();
      this.paint();
    });
  }

  /**
   * Open a page, from any view: the keyboard model is shared by all three, so a tab
   * key leaves a detail or an iteration and lands on that page's list (ADR-0012).
   * The query and the status filter stay as they were — they narrow, they do not travel.
   */
  private selectTab(next: PanelTab): void {
    if (next === this.tab && this.mode === "list" && !this.searching) return;
    this.selectedByTab[this.tab] = this.selectedId;
    this.tab = next;
    rememberPanelTab(next);
    this.mode = "list";
    this.searching = false;
    this.detailId = undefined;
    this.detailLines = [];
    this.detailError = undefined;
    this.following = true;
    this.scrollBack = 0;
    this.selectedId = this.selectedByTab[next];
    this.listTop = 0;
    this.notice = undefined;
    this.applyFilters();
    this.paint();
  }

  /** `f` walks all → running → failed → done inside the open page, and round again. */
  private cycleFilter(): void {
    const index = PANEL_FILTERS.indexOf(this.filter);
    this.filter = PANEL_FILTERS[(index + 1) % PANEL_FILTERS.length] ?? "all";
    this.notice = this.filter === "all" ? "showing every status" : `showing ${this.filter}`;
    // Every record is already in hand, so the filter narrows the view without a read.
    this.applyFilters();
    this.paint();
  }

  /**
   * `o` brings in the other sessions working in this checkout, or puts them away
   * again. They are read only and tagged, and the counts above stay this session's
   * own (ticket #27); the store is asked only when they are shown.
   */
  private toggleOthers(): void {
    this.showOthers = !this.showOthers;
    if (!this.showOthers) this.otherRows = [];
    if (this.showOthers && this.source.others === undefined) {
      this.notice = "No other sessions can be seen from here.";
    } else {
      this.notice = this.showOthers
        ? "showing other sessions read-only"
        : "showing this session only";
    }
    this.applyFilters();
    this.paint();
    if (this.showOthers) {
      this.enqueue(async () => {
        await this.refresh();
        this.paint();
      });
    }
  }

  /** `R` runs the selected command again; the old row stays as its own record. */
  private rerunSelected(): void {
    const row = this.rows[this.selectedIndex()];
    if (row === undefined) {
      this.notice = "No task selected.";
      this.paint();
      return;
    }
    // Another session started this command, so running it again is its decision, not
    // a reader's on a page that only borrowed the row (ticket #27).
    if (this.foreign(row)) {
      this.notice = READ_ONLY;
      this.paint();
      return;
    }
    if (row.task.kind === "chain") {
      // A chain is a queue, and its steps are the commands: `R` has nothing to repeat
      // here, so the panel says so instead of starting something the reader did not ask
      // for. Starting the same pipeline again is a `bg_run` with the same `after`.
      this.notice = "A chain is a queue; run its steps again with bg_run.";
      this.paint();
      return;
    }
    if (row.task.kind !== "process") {
      this.notice = "A loop is scheduled, not run; create a new one instead.";
      this.paint();
      return;
    }
    if (this.source.rerun === undefined) {
      this.notice = "This view cannot start tasks.";
      this.paint();
      return;
    }
    const id = row.task.id;
    this.enqueue(async () => {
      try {
        // Called through the source: the store, not the panel, starts the process.
        const again = await this.source.rerun?.(id);
        this.notice =
          again === undefined ? `no such task: ${id}` : `ran ${id} again as ${again.task.id}`;
        if (again !== undefined) this.selectedId = again.task.id;
      } catch (error) {
        this.notice = `rerun failed: ${messageOf(error)}`;
      }
      await this.refresh();
      this.paint();
    });
  }

  /** `c` puts the output path where it can be read, since the panel cannot copy it. */
  private showOutputPath(): void {
    const row = this.rows[this.selectedIndex()];
    if (row === undefined) {
      this.notice = "No task selected.";
      this.paint();
      return;
    }
    const task = row.task;
    this.notice =
      task.kind === "process"
        ? `output: ${task.outputPath}`
        : task.kind === "cmd-loop" && task.lastOutputPath !== undefined
          ? `output: ${task.lastOutputPath}`
          : task.kind === "chain"
            ? "a chain writes no output of its own; each step has its own file."
            : "a loop writes no output file";
    this.paint();
  }

  // ---- data ----------------------------------------------------------------
  private detailRow(): PanelTaskView | undefined {
    return (
      this.rows.find((row) => row.task.id === this.detailId) ??
      // A fire is not a row, so a fire detail is found among the children: the
      // panel opened it from its loop, and `←` goes back there (ADR-0014).
      this.allRows.find((row) => row.task.id === this.detailId)
    );
  }

  /** The iteration under the cursor, or the newest one when the store trimmed the pick. */
  private currentIteration(task: LlmLoopTask): Iteration | undefined {
    if (this.iterationFire !== undefined) {
      const found = task.iterations.find((iteration) => iteration.fire === this.iterationFire);
      if (found !== undefined) return found;
    }
    return task.iterations.at(-1);
  }

  /** The fire under the cursor, or the newest one when the history cap trimmed it. */
  private currentFire(task: CmdLoopTask): FireRecord | undefined {
    if (this.iterationFire !== undefined) {
      const found = task.fireHistory.find((fire) => fire.fire === this.iterationFire);
      if (found !== undefined) return found;
    }
    return task.fireHistory.at(-1);
  }

  private async readTail(): Promise<void> {
    // Only a process task has an output file; a loop detail never asks the source for one.
    const row = this.detailRow();
    if (row?.task.kind !== "process") return;
    const id = this.detailId;
    if (id === undefined) return;
    try {
      // A row `o` brought in reads the output from its own session's store, which is
      // still only a read: the file belongs to that session, not to this panel.
      const tail = await this.source.tail(id, row.sessionId);
      this.detailLines = tail === undefined ? [] : tailLines(tail.text, DETAIL_TAIL_LINES);
      this.detailTruncated = tail?.truncated === true;
      this.detailError = undefined;
    } catch (error) {
      // An unreadable file keeps the metadata on screen and explains itself below.
      this.detailError = messageOf(error);
    }
  }

  private enqueue(work: () => Promise<void>): void {
    this.pending = this.pending.then(work, work).catch(() => undefined);
  }

  private paint(): void {
    this.tui.requestRender();
  }

  // ---- drawing -------------------------------------------------------------

  /**
   * The box the whole panel lives in: a border, a tinted title band carrying the
   * counts, the body, then the keys. It mirrors the panel this plugin replaces so
   * the eye lands in the same place; colours still come from theme tokens.
   */
  private frame(
    title: string,
    subtitle: string,
    body: string[],
    footer: string,
    width: number,
  ): string[] {
    const theme = this.theme;
    const inner = Math.max(1, width - 2);
    const edge = (glyph: string): string => theme.fg("borderAccent", glyph);
    // The frame pads but never cuts: every line handed to it was already fitted by the
    // caller (list cells pad themselves, `field` cuts its value to the frame). Cutting
    // here as well would double-truncate text that merely carries colour.
    const padded = (text: string, room: number): string =>
      text + " ".repeat(Math.max(0, room - visibleWidth(text)));
    const band = (text: string): string =>
      theme.bg("selectedBg", theme.fg("accent", padded(text, inner)));
    const row = (content = ""): string => `${edge("│")}${padded(content, inner)}${edge("│")}`;

    const lines = [
      edge(`╭${"─".repeat(inner)}╮`),
      row(band(` ${title}`)),
      row(band(` ${subtitle}`)),
      row(),
    ];
    for (const line of body) lines.push(row(line));
    lines.push(row(), row(theme.fg("dim", ` ${footer}`)));
    lines.push(edge(`╰${"─".repeat(inner)}╯`));
    return lines;
  }

  /**
   * The list's header, in the shape of the two-row banner the other task plugin
   * draws above its editor: a ruled title, then one tally per ending. The counts
   * come from every record in the session, so no page and no filter can hide a
   * failure (ADR-0012). Below them, the page band names where the reader is and
   * which status filter is on; the query line stays under it.
   */
  private listHeader(width: number): string[] {
    const theme = this.theme;
    const heading = theme.fg("borderMuted", "──") + theme.fg("text", " Background Tasks ");
    const rule = Math.max(0, width - visibleWidth("── Background Tasks "));
    const lines = [
      heading + theme.fg("borderMuted", "─".repeat(rule)),
      ` ${this.countsLine()} `,
      ` ${this.tabBand()} `,
    ];
    // The query stays visible after search mode is left, so the reader can see why
    // rows are missing; the counts above still cover every task.
    if (this.query.length > 0) {
      lines.push(` ${theme.fg("muted", "search:")} ${theme.fg("accent", this.query)} `);
    }
    return lines;
  }

  /**
   * `Processes │ Loops │ Chains · status: running`: the page being read is the one
   * washed with the selection colour, so the band doubles as where-am-I and as the
   * list of keys that gets you elsewhere (ADR-0012, `1`/`2`/`3`).
   */
  private tabBand(): string {
    const theme = this.theme;
    const pages = PANEL_TABS.map((tab, index) => {
      const title = `${String(index + 1)} ${TAB_TITLE[tab]}`;
      return tab === this.tab
        ? theme.bg("selectedBg", theme.fg("text", ` ${title} `))
        : theme.fg("muted", ` ${title} `);
    });
    const divider = theme.fg("borderMuted", "│");
    return `${pages.join(divider)}${theme.fg("muted", `· status: ${this.filter}`)}`;
  }

  /** One `dot label number` per ending, in the order the reader cares about. */
  private countsLine(): string {
    const theme = this.theme;
    const counts = { running: 0, succeeded: 0, failed: 0, timeout: 0, killed: 0 };
    for (const row of this.allRows) {
      const task = row.task;
      switch (task.status) {
        case "running":
        case "paused":
          // A paused loop is still owed a turn, so it stands with the live work.
          counts.running += 1;
          break;
        case "completed":
          counts.succeeded += 1;
          break;
        case "failed":
          counts.failed += 1;
          break;
        case "killed":
        case "interrupted":
          // Only a process carries a kill reason; a loop is never killed by a limit.
          if (task.kind === "process" && task.killReason === "timeout") counts.timeout += 1;
          else counts.killed += 1;
          break;
      }
    }
    const parts: readonly (readonly [ThemeColor, string, number])[] = [
      ["accent", "Running", counts.running],
      ["success", "Succeeded", counts.succeeded],
      ["error", "Failed", counts.failed],
      ["warning", "Timeout", counts.timeout],
      ["muted", "Killed", counts.killed],
    ];
    return parts
      .map(
        ([colour, label, count]) =>
          `${theme.fg(colour, "●")} ${theme.fg("muted", label)} ${theme.fg("text", String(count))}`,
      )
      .join("  ");
  }

  /** The list's keys, the same on every page (ADR-0012): one model, three lists. */
  private listFooter(): string {
    return "↑/↓ · Enter logs · k stop · f filter · o others · 1/2/3 tabs · / search · R rerun · a stop all · alt+q close";
  }

  /** The box around the rows: the header sits above it, the keys inside the bottom. */
  private listFrame(body: string[], width: number): string[] {
    const theme = this.theme;
    const inner = Math.max(1, width - 2);
    const edge = (glyph: string): string => theme.fg("borderAccent", glyph);
    const padded = (text: string, room: number): string =>
      text + " ".repeat(Math.max(0, room - visibleWidth(text)));
    const row = (content = ""): string => `${edge("│")}${padded(content, inner)}${edge("│")}`;

    const lines = [
      ...this.listHeader(width).map((line) => padded(line, width)),
      edge(`╭${"─".repeat(inner)}╮`),
    ];
    for (const line of body) lines.push(row(line));
    // The keys are cut while still plain text: cutting a coloured string can slice an
    // escape in half and leave the border one column off.
    const keys = this.listFooter();
    const footer = keys.length <= inner - 1 ? keys : `${keys.slice(0, inner - 2)}…`;
    lines.push(row(), row(theme.fg("dim", ` ${footer}`)));
    lines.push(edge(`╰${"─".repeat(inner)}╯`));
    return lines;
  }

  private renderList(width: number): string[] {
    const theme = this.theme;
    const inner = Math.max(1, width - 2);
    const body: string[] = [];

    if (this.rows.length === 0) {
      // An empty page says which of the three reasons emptied it: nothing of that
      // kind, a status filter that keeps nothing, or a query that matches no row.
      // It never blames the other pages, which are only a keypress away.
      const message =
        this.allRows.every((row) => !inTab(row.task, this.tab)) || this.allRows.length === 0
          ? TAB_EMPTY[this.tab]
          : this.query.length > 0
            ? "  Nothing on this page matches the search — / , then backspace, widens it."
            : "  Nothing here matches this status — f moves to the next filter.";
      body.push("", theme.fg("dim", message));
      return this.listFrame(body, width);
    }

    // One name column for the whole page, so the ids line up and nothing more.
    const room = (row: PanelTaskView): number => visibleWidth(this.chainCells(row).plain);
    const longest = this.rows.reduce(
      (most, row) =>
        Math.max(most, row.task.kind === "chain" ? room(row) : visibleWidth(row.task.name)),
      12,
    );
    // A chain sells its name column to the steps, so the numbers beside it need less
    // room than a process's size and age; the strip sheds its finished steps instead.
    const nameRoom = Math.min(longest, Math.max(12, inner - (this.tab === "chains" ? 48 : 79)));

    const visible = this.rows.slice(this.listTop, this.listTop + LIST_VISIBLE_ROWS);
    visible.forEach((row, offset) => {
      body.push(this.listRow(row, this.listTop + offset === this.selectedIndex(), inner, nameRoom));
    });
    if (this.rows.length > LIST_VISIBLE_ROWS) {
      const first = this.listTop + 1;
      const last = Math.min(this.rows.length, this.listTop + LIST_VISIBLE_ROWS);
      body.push(
        theme.fg(
          "dim",
          `  Showing ${String(first)}-${String(last)} of ${String(this.rows.length)}`,
        ),
      );
    }
    if (this.notice !== undefined) body.push(theme.fg("warning", `  ${this.notice}`));
    return this.listFrame(body, width);
  }

  private selectedIndex(): number {
    return this.rows.findIndex((row) => row.task.id === this.selectedId);
  }

  /** True for a row `o` brought in from another session: readable, never writable. */
  private foreign(row: PanelTaskView | undefined): boolean {
    return row?.sessionId !== undefined && row.sessionId !== this.source.sessionId;
  }

  /**
   * The field's text in its own colour, with the query's characters in the accent
   * weight. The match is computed on the bare text and applied here, fragment by
   * fragment, so a theme's escapes never reach the matcher and the padding keeps
   * its width.
   */
  private highlight(text: string, colour: ThemeColor, positions: readonly number[]): string {
    if (positions.length === 0) return this.theme.fg(colour, text);
    let themed = "";
    let at = 0;
    let index = 0;
    while (index < positions.length) {
      const start = positions[index] ?? 0;
      if (start > at) themed += this.theme.fg(colour, text.slice(at, start));
      let end = start + 1;
      index += 1;
      while (positions[index] === end) {
        end += 1;
        index += 1;
      }
      themed += this.theme.bold(this.theme.fg("accent", text.slice(start, end)));
      at = end;
    }
    if (at < text.length) themed += this.theme.fg(colour, text.slice(at));
    return themed;
  }

  /**
   * One list row, in the shape of a process listing: pointer, live dot, name, id,
   * status, then the numbers. Every cell is padded before it is coloured, so the
   * border stays straight whatever the theme does with escapes.
   */
  private listRow(row: PanelTaskView, selected: boolean, width: number, nameRoom: number): string {
    const theme = this.theme;
    const task = row.task;
    const match = this.matchScores.get(row);
    const lit = (field: MatchField): readonly number[] =>
      match?.field === field ? match.positions : [];
    const pointer = selected ? theme.fg("accent", "›") : " ";
    const dot = theme.fg(dotColour(task), "●");
    const id = this.highlight(pad(task.id, ID_COLUMN_WIDTH), "dim", lit("id"));
    // A row `o` brought in says whose it is: the store names a session by a UUID, so
    // the row carries its first six characters and the detail the whole id.
    const tag =
      row.sessionId === undefined ? "" : theme.fg("muted", ` @${row.sessionId.slice(0, 6)}`);
    const tagPlain = row.sessionId === undefined ? "" : ` @${row.sessionId.slice(0, 6)}`;
    const separator = theme.fg("dim", "·");
    // Both kinds share one table, so the row has to say which it is: a loop runs
    // nothing and a process wakes nobody, and their numbers mean different things.
    const kind = this.highlight(kindWord(task.kind), "muted", lit("kind"));
    const status = this.highlight(pad(task.status, 11), STATUS_COLOUR[task.status], lit("status"));
    const exit = exitText(task) === "" ? "" : theme.fg("dim", ` ${exitText(task)}`);

    // The name column is as wide as the longest name, not as wide as the terminal:
    // a fixed split leaves a canyon between the name and the id on a wide screen.
    // A chain spends the column on its steps instead of a name of its own (ADR-0012).
    const chain = task.kind === "chain" ? this.chainCells(row, nameRoom) : undefined;
    const namePlain = pad(chain?.plain ?? task.name, nameRoom);
    const name =
      chain === undefined
        ? this.highlight(namePlain, nameColour(task), lit("name"))
        : `${chain.themed}${" ".repeat(Math.max(0, nameRoom - visibleWidth(chain.plain)))}`;
    const growth = this.growthText(row);
    const headPlain = ` ${pointer} ${dot} ${name} ${id}${tag} ${separator} ${kind} ${status}${exit} `;
    // The numbers get the room the head leaves, minus one space of gap, so they can
    // shed their least important parts instead of pushing the row past the border.
    // The room is measured on the bare cells: a theme adds markup, and only the
    // characters a reader sees should cost a number its place.
    const headCells = ` ${selected ? "›" : " "} ● ${namePlain} ${pad(
      task.id,
      ID_COLUMN_WIDTH,
    )}${tagPlain} · ${kindWord(task.kind)} ${pad(task.status, 11)}${exitText(task) === "" ? "" : ` ${exitText(task)}`} `;
    const right = theme.fg(
      "dim",
      rightText(
        row,
        this.now(),
        width - 2 - visibleWidth(headCells) - visibleWidth(growth) - 1,
        this.foreign(row),
      ),
    );
    // The strip is a command loop's own column: the newest fires, oldest left, so a
    // failure count can never hide a run that never happened (ADR-0015). It drops
    // its oldest cells on a narrow row and disappears entirely before wrapping.
    const strip =
      task.kind === "cmd-loop"
        ? this.fireStrip(
            task,
            width - 2 - visibleWidth(headPlain) - visibleWidth(right) - visibleWidth(growth) - 2,
          )
        : "";
    const head = strip === "" ? headPlain : `${headPlain}${strip} `;
    // The numbers sit against the right edge so a column of sizes can be compared
    // by eye, which is what a reader does with them.
    const tail = `${right}${growth}`;
    const gap = Math.max(1, width - 2 - visibleWidth(head) - visibleWidth(tail));
    const line = `${head}${" ".repeat(gap)}${tail}`;
    // A selected row is washed in one block of background, the way the panel this
    // replaces marks its cursor: the eye finds it without a colour of its own.
    return selected
      ? theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))))
      : line;
  }

  /**
   * The fire strip: newest STRIP_CELLS fires, oldest left, one coloured cell each.
   * On a narrow row the oldest cells drop first, and when nothing fits the strip is
   * omitted rather than wrapped, so the row keeps its shape (ADR-0015).
   */
  private fireStrip(task: CmdLoopTask, room: number): string {
    const theme = this.theme;
    const newest = task.fireHistory.slice(-STRIP_CELLS);
    // Widths are counted on the bare glyphs, so a theme's escapes never cost a
    // cell its place in the strip.
    let cells = newest.map((fire) => {
      const plain = `#${String(fire.fire)}${FIRE_MARK[fire.outcome]}`;
      return { plain, themed: theme.fg(FIRE_COLOUR[fire.outcome], plain) };
    });
    const fitted = (): number =>
      cells.reduce((total, cell) => total + cell.plain.length, 0) + Math.max(0, cells.length - 1);
    while (cells.length > 0 && fitted() > room) cells = cells.slice(1);
    return cells.map((cell) => cell.themed).join(" ");
  }

  /** The record a chain step id names, or undefined while its record is missing. */
  private stepRecord(id: string): Task | undefined {
    // Both stores are searched: a chain `o` brought in still has to name its steps,
    // and those records live in the session that owns it (ticket #27).
    return [...this.allRows, ...this.otherRows].find((row) => row.task.id === id)?.task;
  }

  /** Which step a chain is on, in words a reader does not have to decode a cursor for. */
  private chainPlace(task: ChainTask): string {
    if (task.steps.length === 0) return "no step queued";
    if (task.cursor >= task.steps.length)
      return `${String(task.steps.length)} of ${String(task.steps.length)} done`;
    return `step ${String(task.cursor + 1)} of ${String(task.steps.length)}`;
  }

  /**
   * The chain's own column: its steps in run order, joined by arrows, with the step at
   * the cursor in the accent colour and bold. On a narrow row the steps it has already
   * got through drop first, newest kept, and a leading ellipsis says something was
   * left out — a chain never wraps and never hides the step that is running (ADR-0012).
   */
  private chainCells(
    row: PanelTaskView,
    room = Number.POSITIVE_INFINITY,
  ): {
    plain: string;
    themed: string;
  } {
    const task = row.task;
    const match = this.matchScores.get(row);
    const nameLit = (): readonly number[] => (match?.field === "name" ? match.positions : []);
    if (task.kind !== "chain")
      return {
        plain: task.name,
        themed: this.highlight(task.name, nameColour(task), nameLit()),
      };
    if (task.steps.length === 0) {
      return {
        plain: task.name,
        themed: this.highlight(task.name, nameColour(task), nameLit()),
      };
    }
    const cells = task.steps.map((id) => {
      const step = this.stepRecord(id);
      const name = step?.name ?? id;
      const status = step?.status ?? "waiting";
      return { name, status };
    });
    const build = (from: number, to: number, markers = true): { plain: string; themed: string } => {
      const kept = cells.slice(from, to);
      // The ellipses stand for the steps that make way, and they are the first thing
      // to go when the column cannot hold them beside the step it must show.
      const lead = markers && from > 0 ? "… " : "";
      const trail = markers && to < cells.length ? " …" : "";
      const plain = `${lead}${kept.map((cell) => cell.name).join(" → ")}${trail}`;
      const themed =
        this.theme.fg("dim", lead) +
        kept
          .map((cell, offset) => {
            const index = from + offset;
            const arrow = offset === 0 ? "" : this.theme.fg("dim", " → ");
            const lit = match?.field === "step" && match.stepIndex === index ? match.positions : [];
            const name =
              index === task.cursor
                ? this.theme.bold(this.highlight(cell.name, "accent", lit))
                : this.highlight(cell.name, stepColour(cell.status), lit);
            return `${arrow}${name}`;
          })
          .join("") +
        this.theme.fg("dim", trail);
      return { plain, themed };
    };
    let from = 0;
    let to = cells.length;
    // The running step is the one fact the row may not lose, so shedding stops at it:
    // finished steps go first, then the waiting ones behind, whichever end is further.
    const fits = (): boolean => visibleWidth(build(from, to).plain) <= room;
    while (!fits() && to - from > 1) {
      if (task.cursor > from) from += 1;
      else to -= 1;
    }
    const shown = build(from, to);
    if (visibleWidth(shown.plain) <= room) return shown;
    const tight = build(from, to, false);
    if (visibleWidth(tight.plain) <= room) return tight;
    // Even the running step alone is too wide for the column: cut it like a name.
    const plain = truncateToWidth(tight.plain, Math.max(1, room), "…", false);
    return { plain, themed: this.theme.fg(nameColour(task), plain) };
  }

  private renderDetail(width: number): string[] {
    const row = this.detailRow();
    if (row === undefined) return this.renderList(width);
    if (row.task.kind === "llm-loop") return this.renderLoopDetail(row, width);
    if (row.task.kind === "cmd-loop") return this.renderCommandLoopDetail(row, width);
    if (row.task.kind === "chain") return this.renderChainDetail(row, width);
    return this.renderProcessDetail(width);
  }

  /**
   * A chain detail: the queue in run order, one line per step with the status, the
   * duration and the exit code it ended with. The step at the cursor is marked, so
   * the list says what is running now and what never got its turn (ADR-0012).
   */
  private renderChainDetail(row: PanelTaskView, width: number): string[] {
    const theme = this.theme;
    const task = row.task;
    if (task.kind !== "chain") return this.renderList(width);
    const colour = STATUS_COLOUR[task.status];
    const done = task.steps.filter((id) => this.stepRecord(id)?.status === "completed").length;
    const body: string[] = [
      this.field("Name", theme.fg("accent", task.name)),
      this.field("ID", theme.fg("accent", task.id)),
      ...this.sessionField(row),
      this.field("Status", theme.fg(colour, task.status)),
      this.field("Runtime", formatDuration(row.elapsedMs)),
      this.field("Updated", this.updatedText(task.updatedAt)),
      this.field(
        "Steps",
        `${String(done)} of ${String(task.steps.length)} done · ${this.chainPlace(task)}`,
      ),
    ];
    if (task.endedAt !== undefined) {
      body.push(this.field("Ended", formatClockTime(task.endedAt)));
    }
    if (task.killReason !== undefined) body.push(this.field("Kill reason", task.killReason));
    if (task.error !== undefined) body.push(this.field("Error", theme.fg(colour, task.error)));

    body.push("", theme.fg("muted", ` Steps, in run order (${String(task.steps.length)}):`));
    if (task.steps.length === 0) {
      body.push(theme.fg("dim", "  no step queued yet"));
    }
    const room = Math.max(20, width - 4);
    task.steps.forEach((id, index) => {
      const step = this.stepRecord(id);
      const status = step?.status ?? "waiting";
      const marker = index === task.cursor ? theme.fg("accent", "›") : " ";
      const mark = theme.fg(stepColour(status), STEP_MARK[status]);
      const name = `${String(index + 1)}. ${step?.name ?? id}`;
      // A step that has not run yet has no duration of its own, and a bare dash says
      // that more honestly than the wait since it was queued does.
      const duration =
        step === undefined || status === "waiting"
          ? "—"
          : formatDuration(Math.max(0, (step.endedAt ?? this.now()) - step.createdAt));
      const code =
        step?.kind === "process" && step.exitCode !== undefined && step.exitCode !== null
          ? `exit ${String(step.exitCode)}`
          : "";
      const line = `${marker} ${mark} ${pad(name, 20)} ${pad(status, 10)} ${pad(duration, 6)} ${code}`;
      body.push(`${truncateToWidth(line.trimEnd(), room, "…", false)}  ${theme.fg("dim", id)}`);
    });

    if (this.notice !== undefined) body.push(theme.fg("warning", `  ${this.notice}`));
    return this.frame(
      `chain: ${task.name}`,
      `${task.id} · ${task.status} · ${this.chainPlace(task)}`,
      body,
      "← list · k stop from the running step · alt+q close",
      width,
    );
  }

  private renderProcessDetail(width: number): string[] {
    const theme = this.theme;
    const row = this.detailRow();
    if (row === undefined || row.task.kind !== "process") return this.renderList(width);
    const task = row.task;
    const colour = STATUS_COLOUR[task.status];
    const body: string[] = [
      this.field("Name", theme.fg("accent", task.name)),
      this.field("ID", theme.fg("accent", task.id)),
      ...this.sessionField(row),
      this.field("Status", theme.fg(colour, task.status)),
      this.field("Runtime", formatDuration(row.elapsedMs)),
      this.field("Started", formatClockTime(task.createdAt)),
      this.field("Updated", this.updatedText(task.updatedAt)),
      this.field("Output", task.outputPath),
      this.field("Size", formatSize(row)),
    ];
    if (task.endedAt !== undefined) {
      body.push(this.field("Ended", formatClockTime(task.endedAt)));
    }
    if (task.pid !== undefined) body.push(this.field("PID", String(task.pid)));
    body.push(this.field("Command", singleLine(task.command, Math.max(1, width - 14))));
    if (task.cwd !== undefined) body.push(this.field("CWD", task.cwd));
    if (task.exitCode !== undefined) {
      body.push(this.field("Exit code", theme.fg(colour, String(task.exitCode))));
    }
    if (task.killReason !== undefined) body.push(this.field("Kill reason", task.killReason));
    if (task.error !== undefined) body.push(this.field("Error", theme.fg(colour, task.error)));

    body.push(theme.fg("muted", " Output tail:"));
    body.push(...this.outputBox(width - 2));
    body.push(theme.fg("dim", ` ${this.position()}`));

    if (this.notice !== undefined) body.push(theme.fg("warning", `  ${this.notice}`));
    const live = task.status === "running" ? "live tail refreshes every second" : "final output";
    return this.frame(
      `task: ${task.name}`,
      `${task.id} · ${task.status} · ${live}`,
      body,
      "↑/↓ scroll · r follow · ← list · k stop · R rerun · c path · alt+q close",
      width,
    );
  }

  /** The output tail, inside its own thin border so it reads as a window, not a field. */
  private outputBox(width: number): string[] {
    const theme = this.theme;
    const inner = Math.max(1, width - 2);
    const edge = (glyph: string): string => theme.fg("borderAccent", glyph);
    const row = (content = ""): string => {
      const cut =
        visibleWidth(content) > inner ? truncateToWidth(content, inner, "…", false) : content;
      return `${edge("│")}${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))}${edge("│")}`;
    };
    const lines = [edge(`╭${"─".repeat(inner)}╮`)];
    if (this.detailError !== undefined) {
      lines.push(row(theme.fg("error", ` output unavailable: ${this.detailError}`)));
    } else if (this.detailLines.length === 0) {
      lines.push(row(theme.fg("dim", " no output yet")));
    } else {
      const [from, to] = this.window();
      for (const line of this.detailLines.slice(from, to)) lines.push(row(` ${line}`));
      if (this.detailTruncated) lines.push(row(theme.fg("dim", " … older output left out")));
    }
    // Keep the window the same height whatever the output does: a box that grows
    // and shrinks under the reader's eyes is harder to scan than an empty one.
    while (lines.length < DETAIL_OUTPUT_LINES + 1) lines.push(row());
    lines.push(edge(`╰${"─".repeat(inner)}╯`));
    return lines;
  }

  /** A loop detail: schedule facts, then the iterations it produced, newest first. */
  private renderLoopDetail(row: PanelTaskView, width: number): string[] {
    const theme = this.theme;
    const task = row.task;
    if (task.kind !== "llm-loop") return this.renderList(width);
    const colour = STATUS_COLOUR[task.status];
    const body: string[] = [
      this.field("Status", theme.fg(colour, task.status)),
      this.field("Kind", task.kind),
      ...this.sessionField(row),
      this.field("Runtime", formatDuration(row.elapsedMs)),
      this.field("Updated", this.updatedText(task.updatedAt)),
      this.field("Schedule", task.schedule),
      this.field("Fires", firesText(task)),
      this.field("Next fire", nextFireText(task, row)),
      this.field(
        "Last fire",
        task.lastFireAt === undefined ? "—" : formatClockTime(task.lastFireAt),
      ),
    ];
    if (task.expiresAt !== undefined) {
      body.push(this.field("Expires", formatClockTime(task.expiresAt)));
    }
    if (task.endedAt !== undefined) {
      body.push(this.field("Ended", formatClockTime(task.endedAt)));
    }
    if (task.error !== undefined) body.push(this.field("Error", theme.fg(colour, task.error)));
    body.push(this.field("Prompt", singleLine(task.prompt, Math.max(1, width - 14))));
    body.push("", theme.fg("muted", iterationsText(task)));

    const newestFirst = [...task.iterations].reverse();
    if (newestFirst.length === 0) {
      body.push(theme.fg("dim", "  no iteration recorded yet"));
    } else {
      const selected = this.currentIteration(task);
      const top = Math.min(
        Math.max(0, this.iterationTop),
        Math.max(0, newestFirst.length - LIST_VISIBLE_ROWS),
      );
      const visible = newestFirst.slice(top, top + LIST_VISIBLE_ROWS);
      if (top > 0) body.push(theme.fg("dim", `  … ${String(top)} newer above`));
      for (const iteration of visible) {
        const marker = iteration.fire === selected?.fire ? theme.fg("accent", "›") : " ";
        const text = iterationLine(iteration);
        body.push(`${marker} ${truncateToWidth(text, Math.max(1, width - 4), "…", false)}`);
      }
      const below = newestFirst.length - top - visible.length;
      if (below > 0) body.push(theme.fg("dim", `  … ${String(below)} older below`));
    }

    if (this.notice !== undefined) body.push(theme.fg("warning", `  ${this.notice}`));
    return this.frame(
      `loop: ${task.name}`,
      `${task.id} · ${task.status} · ${task.schedule}`,
      body,
      "↑/↓ select · Enter iteration · ← list · k stop · alt+q close",
      width,
    );
  }

  /** A command loop detail: schedule facts, then the fires it produced, newest first. */
  private renderCommandLoopDetail(row: PanelTaskView, width: number): string[] {
    const theme = this.theme;
    const task = row.task;
    if (task.kind !== "cmd-loop") return this.renderList(width);
    const colour = STATUS_COLOUR[task.status];
    const envCount = Object.keys(task.env ?? {}).length;
    const body: string[] = [
      this.field("Status", theme.fg(colour, task.status)),
      this.field("Kind", task.kind),
      ...this.sessionField(row),
      this.field("Runtime", formatDuration(row.elapsedMs)),
      this.field("Updated", this.updatedText(task.updatedAt)),
      this.field("Schedule", task.schedule),
      this.field("Fires", `${firesText(task)}${missedText(task)}`),
      this.field("Next fire", nextFireText(task, row, failureStreak(task) > 0)),
      this.field(
        "Last fire",
        task.lastFireAt === undefined ? "—" : formatClockTime(task.lastFireAt),
      ),
    ];
    // A streak explains why the next fire is later than the expression says, so
    // it sits with the schedule facts and never rewrites them (ADR-0017).
    const streak = failureStreak(task);
    if (streak > 0) body.push(this.field("Failures", `${String(streak)} in a row`));
    if (task.expiresAt !== undefined) {
      body.push(this.field("Expires", formatClockTime(task.expiresAt)));
    }
    if (task.endedAt !== undefined) {
      body.push(this.field("Ended", formatClockTime(task.endedAt)));
    }
    if (task.error !== undefined) body.push(this.field("Error", theme.fg(colour, task.error)));
    body.push(this.field("Command", singleLine(task.command, Math.max(1, width - 14))));
    if (task.cwd !== undefined) body.push(this.field("CWD", task.cwd));
    body.push(
      this.field(
        "Env",
        envCount === 0 ? "—" : `${String(envCount)} variable${envCount === 1 ? "" : "s"}`,
      ),
    );
    body.push(this.field("Wake on failure", task.wakeOnFailure === false ? "off" : "on"));
    body.push(
      this.field("Last exit", task.lastExitCode === undefined ? "—" : String(task.lastExitCode)),
    );
    if (task.lastOutputPath !== undefined) {
      body.push(this.field("Last output", task.lastOutputPath));
    }
    body.push(
      this.field(
        "Size",
        task.lastOutputBytes === undefined ? "—" : formatBytes(task.lastOutputBytes),
      ),
    );
    body.push("", theme.fg("muted", firesHeading(task)));

    const newestFirst = [...task.fireHistory].reverse();
    if (newestFirst.length === 0) {
      body.push(theme.fg("dim", "  no fire recorded yet"));
    } else {
      const selected = this.currentFire(task);
      const top = Math.min(
        Math.max(0, this.iterationTop),
        Math.max(0, newestFirst.length - LIST_VISIBLE_ROWS),
      );
      const visible = newestFirst.slice(top, top + LIST_VISIBLE_ROWS);
      if (top > 0) body.push(theme.fg("dim", `  … ${String(top)} newer above`));
      for (const fire of visible) {
        const marker = fire.fire === selected?.fire ? theme.fg("accent", "›") : " ";
        const text = fireLine(fire);
        body.push(`${marker} ${truncateToWidth(text, Math.max(1, width - 4), "…", false)}`);
      }
      const below = newestFirst.length - top - visible.length;
      if (below > 0) body.push(theme.fg("dim", `  … ${String(below)} older below`));
    }

    if (this.notice !== undefined) body.push(theme.fg("warning", `  ${this.notice}`));
    return this.frame(
      `loop: ${task.name}`,
      `${task.id} · ${task.status} · ${task.schedule}`,
      body,
      "↑/↓ select · Enter fire · ← list · k stop · alt+q close",
      width,
    );
  }

  /** An iteration detail: the tool calls that turn made, oldest first; `←` goes back. */
  private renderIterationDetail(width: number): string[] {
    const theme = this.theme;
    const row = this.detailRow();
    if (row === undefined || row.task.kind !== "llm-loop") return this.renderList(width);
    const task = row.task;
    const iteration = this.currentIteration(task);
    if (iteration === undefined) return this.renderLoopDetail(row, width);

    const body: string[] = [
      this.field("Status", theme.fg(ITERATION_COLOUR[iteration.status], iteration.status)),
      this.field("Started", formatClockTime(iteration.startedAt)),
    ];
    if (iteration.endedAt !== undefined) {
      body.push(this.field("Took", formatDuration(iteration.endedAt - iteration.startedAt)));
    }
    body.push(this.field("Calls", callsText(iteration)));
    body.push("", theme.fg("muted", callsHeading(iteration, this.callTop)));

    const top = callTopFor(iteration, this.callTop);
    const visible = iteration.calls.slice(top, top + DETAIL_OUTPUT_LINES);
    if (visible.length === 0) {
      body.push(theme.fg("dim", "  no tool call in this turn"));
    }
    visible.forEach((call, offset) => {
      body.push(this.callLine(call, top + offset, width - 4));
      if (call.error !== undefined) {
        body.push(theme.fg(STATUS_COLOUR.failed, `     error: ${call.error}`));
      }
    });
    // The cap drops the oldest calls first; say so where they would have been.
    if (iteration.droppedCalls > 0) {
      body.push(
        theme.fg(
          STATUS_COLOUR.interrupted,
          `  … +${String(iteration.droppedCalls)} earlier calls dropped`,
        ),
      );
    }

    if (this.notice !== undefined) body.push(theme.fg("warning", `  ${this.notice}`));
    return this.frame(
      `fire ${String(iteration.fire)}`,
      `${task.name} · ${task.id} · ${iteration.status}`,
      body,
      "↑/↓ scroll · ← loop · k stop · alt+q close",
      width,
    );
  }

  /** One call row: its subject (a command stands out), then its result or error. */
  private callLine(call: IterationCall, index: number, width: number): string {
    const theme = this.theme;
    const prefix = ` ${String(index + 1).padStart(2)}. ${call.tool}  `;
    const duration = call.durationMs === undefined ? "" : ` ${formatDuration(call.durationMs)}`;
    const status = `  ${call.status}${duration}`;
    const room = Math.max(1, width - prefix.length - status.length);
    const subject = singleLine(call.subject, room);
    const body =
      subject.length === 0 ? "" : isCommandCall(call) ? theme.fg("accent", subject) : subject;
    return `${prefix}${body}${theme.fg(CALL_COLOUR[call.status], status)}`;
  }

  /** Where the visible window sits: following the newest line, or a frozen range. */
  private position(): string {
    if (this.following || this.detailLines.length === 0) return "following tail · ↑ scroll";
    const [from, to] = this.window();
    const total = this.detailLines.length;
    return `lines ${String(from + 1)}–${String(to)} of ${String(total)} · ↑/↓ scroll · r follows`;
  }

  /** Visible slice of the detail buffer, as half-open `[from, to)`. */
  private window(): [number, number] {
    const total = this.detailLines.length;
    const to = Math.max(0, total - this.scrollBack);
    return [Math.max(0, to - DETAIL_OUTPUT_LINES), to];
  }

  private field(label: string, value: string): string {
    // Cut here, once, against the frame: the border and the label take their share first.
    const room = Math.max(8, this.renderWidth - 2 - LABEL_WIDTH - 2);
    const text = visibleWidth(value) > room ? truncateToWidth(value, room, "…", false) : value;
    return `${this.theme.fg("muted", pad(`${label}:`, LABEL_WIDTH))}${text}`;
  }

  /**
   * The session that owns a row, printed only when it is not this one: the list had
   * room for six characters, the detail has room to name the whole session so a
   * reader can go and ask it (ticket #27).
   */
  private sessionField(row: PanelTaskView): string[] {
    if (!this.foreign(row) || row.sessionId === undefined) return [];
    return [this.field("Session", this.theme.fg("dim", row.sessionId))];
  }

  /** Absolute clock plus age: the list shows only the age, the detail can afford both. */
  private updatedText(updatedAt: number): string {
    const age = formatDuration(Math.max(0, this.now() - updatedAt));
    return `${formatClockTime(updatedAt)} · ${age} ago`;
  }
}

/** Size column: output bytes for a process task; a loop task has no output file. */
function formatSize(row: PanelTaskView): string {
  return row.task.kind === "process" ? formatBytes(row.outputBytes) : "—";
}

/** The live dot: running is loud, a stopped task is a hollow ring, paused is a warning. */
function dotColour(task: Task): ThemeColor {
  if (task.status === "running") return STATUS_COLOUR.running;
  if (task.status === "paused") return STATUS_COLOUR.paused;
  return task.status === "completed" ? "dim" : STATUS_COLOUR[task.status];
}

/** Exit column: a process has a code, a loop has fires instead, a chain has steps. */
function exitText(task: Task): string {
  if (task.kind === "llm-loop") return "";
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
function rightText(
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
    return candidates.find((candidate) => visibleWidth(candidate) <= room) ?? elapsed;
  }
  if (task.kind === "process") {
    // The numbers give way in the order they matter: the age first, then the size,
    // and the runtime last, so a narrow terminal still says how long it ran. The
    // row is never wrapped and never pushed past its border (ADR-0015).
    const size = formatSize(row);
    const candidates = [`${elapsed} ${size}${age}`, `${elapsed} ${size}`, elapsed];
    return candidates.find((candidate) => visibleWidth(candidate) <= room) ?? elapsed;
  }
  if (task.kind === "chain") {
    // A chain reports its place in the queue: the step it is on, and how many it holds.
    // The steps' own bytes and exit codes read on the step lines of its detail.
    const at = Math.min(task.cursor + 1, task.steps.length);
    const place = `${String(at)}/${String(task.steps.length)}`;
    // The elapsed time and the queue's place outrank the age, which goes first on a
    // narrow row, so a chain still says where it is when the numbers must give way.
    const candidates = [`${elapsed} · ${place}${age}`, `${elapsed} · ${place}`, place, elapsed];
    return candidates.find((candidate) => visibleWidth(candidate) <= room) ?? place;
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
  // wait itself. Nothing is ever cut mid-number and the row never wraps (ADR-0015).
  const candidates = [
    `${state}${next ?? ""}${backingOff}${age}`,
    `${state}${next ?? ""}${backingOff}`,
    ...(next === undefined ? [] : [`${state}${next}`, state]),
  ];
  return candidates.find((candidate) => visibleWidth(candidate) <= room) ?? state;
}

function pad(text: string, width: number): string {
  // Width is pixels, not code units: a CJK or emoji name must not shift the columns.
  const used = visibleWidth(text);
  return used >= width ? truncateToWidth(text, width, "", false) : text + " ".repeat(width - used);
}

/** Name colour, as the replaced panel had it: the ending decides, not the kind. */
function nameColour(task: Task): ThemeColor {
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tools whose subject is a command line, so the panel can make them stand out. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["bash", "bg_run"]);

/** Iteration states, read from the one task-status palette. */
const ITERATION_COLOUR: Record<IterationStatus, ThemeColor> = {
  running: STATUS_COLOUR.running,
  completed: STATUS_COLOUR.completed,
  aborted: STATUS_COLOUR.killed,
  interrupted: STATUS_COLOUR.interrupted,
};

/** Tool-call states, read from the same palette. */
const CALL_COLOUR: Record<IterationCallStatus, ThemeColor> = {
  running: STATUS_COLOUR.running,
  completed: STATUS_COLOUR.completed,
  failed: STATUS_COLOUR.failed,
  aborted: STATUS_COLOUR.killed,
  interrupted: STATUS_COLOUR.interrupted,
};

function isCommandCall(call: IterationCall): boolean {
  return COMMAND_TOOLS.has(call.tool);
}

function firesText(task: LoopBase): string {
  if (task.maxFires === undefined) return String(task.fires);
  return `${String(task.fires)} / ${String(task.maxFires)}`;
}
/**
 * Failed fires in a row on a command loop. Only a fire that ran can fail, so an
 * llm loop never carries a streak and its rows never claim one (ADR-0017).
 */
function failureStreak(task: Task): number {
  return task.kind === "cmd-loop" ? (task.consecutiveFailures ?? 0) : 0;
}

/** Fires that never ran because the previous one still was, appended to the count. */
function missedText(task: CmdLoopTask): string {
  const missed = task.missedFires ?? 0;
  return missed === 0 ? "" : ` · ${String(missed)} skipped`;
}

function nextFireText(task: LoopBase, row: PanelTaskView, backingOff = false): string {
  if (task.nextFireAt === undefined) return "—";
  const at = formatClockTime(task.nextFireAt);
  if (row.untilNextFireMs === undefined) return at;
  const wait = `${formatDuration(row.untilNextFireMs)}${backingOff ? ", backoff" : ""}`;
  return `${at} (in ${wait})`;
}

/** Iteration list heading: kept and dropped counts are both stated, never hidden. */
function iterationsText(task: LlmLoopTask): string {
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
function firesHeading(task: CmdLoopTask): string {
  const kept = task.fireHistory.length;
  const dropped = Math.max(0, task.fires - kept);
  const suffix = dropped === 0 ? "" : ` · ${String(dropped)} older dropped`;
  if (kept === 0) return dropped === 0 ? "fires · none yet" : `fires · none kept${suffix}`;
  return `fires · newest first · ${String(kept)} kept${suffix}`;
}

/** One fire row: number, time, outcome, exit code, duration and bytes (ADR-0015). */
function fireLine(fire: FireRecord): string {
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
const FIRE_MARK: Record<FireOutcome, string> = {
  running: "•",
  success: "✓",
  failed: "✗",
  skipped: "–",
  interrupted: "!",
};

/** Strip colour by outcome: live, done, failed, never-ran, cut short by a stop. */
const FIRE_COLOUR: Record<FireOutcome, ThemeColor> = {
  running: STATUS_COLOUR.running,
  success: STATUS_COLOUR.completed,
  failed: STATUS_COLOUR.failed,
  skipped: "muted",
  interrupted: STATUS_COLOUR.interrupted,
};

/** The mark a chain step carries on its line, one glyph per status it can hold. */
const STEP_MARK: Record<TaskStatus, string> = {
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
function stepColour(status: TaskStatus): ThemeColor {
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
function iterationLine(iteration: Iteration): string {
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
function callsText(iteration: Iteration): string {
  return iteration.calls.length === 1 ? "1 call" : `${String(iteration.calls.length)} calls`;
}

/** Where the visible call window sits, oldest first. */
function callsHeading(iteration: Iteration, requested: number): string {
  const total = iteration.calls.length;
  if (total === 0) return "calls · none in this turn";
  const top = callTopFor(iteration, requested);
  const to = Math.min(total, top + DETAIL_OUTPUT_LINES);
  return `calls ${String(top + 1)}–${String(to)} of ${String(total)} · oldest first`;
}

function callTopFor(iteration: Iteration, requested: number): number {
  const oldest = Math.max(0, iteration.calls.length - DETAIL_OUTPUT_LINES);
  return Math.min(Math.max(0, requested), oldest);
}

/** A free-form field as one line: the panel draws rows, not paragraphs. */
function singleLine(text: string, maxLength: number): string {
  const oneLine = text.replace(/\s*\n\s*/g, " ").trim();
  return truncateToWidth(oneLine, Math.max(1, maxLength), "…", false);
}

/**
 * Short kind word printed in a row. Search uses the same word, so a reader who
 * sees `llm` can type `llm` and find that row.
 */
function kindWord(kind: TaskKind): "proc" | "llm" | "cmd" | "chn" {
  switch (kind) {
    case "process":
      return "proc";
    case "llm-loop":
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
function inTab(task: Task, tab: PanelTab): boolean {
  switch (tab) {
    case "processes":
      return task.kind === "process" && task.parentId === undefined;
    case "loops":
      return task.kind === "llm-loop" || task.kind === "cmd-loop";
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
function passesFilter(task: Task, filter: PanelFilter): boolean {
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
function pageKey(data: string, current: PanelTab): PanelTab | undefined {
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
type MatchField = "name" | "id" | "status" | "kind" | "step" | "command" | "prompt";

/** Where a row's query landed: the field, how well it scored, and what to light up. */
interface RowMatch {
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
function bestFieldMatch(
  task: Task,
  query: string,
  steps: readonly { name: string; index: number }[] = [],
): RowMatch | undefined {
  const needle = query.toLowerCase();
  // The kind word is the one the row prints, so searching `proc` finds the
  // processes the reader can see and searching `llm` finds the llm loops; the
  // status word is the string the row colours.
  const kind = kindWord(task.kind);
  // A chain with a queue spends its name column on the steps, so its own name is
  // no longer a word the row prints.
  const nameHidden = task.kind === "chain" && task.steps.length > 0;
  const fields: SearchField[] =
    task.kind === "llm-loop"
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
function pastedQuery(data: string): string | undefined {
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
function typedQuery(data: string): string | undefined {
  if (data.length === 0) return undefined;
  for (const character of data) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return data;
}
