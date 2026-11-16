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
import type {
  ChainTask,
  CmdLoopTask,
  FireRecord,
  PromptLoopTask,
  Task,
} from "../tasks/base/task.js";
import type { Iteration, IterationCall } from "../tasks/loop/iteration.js";
import {
  bestFieldMatch,
  CALL_COLOUR,
  callsHeading,
  callsText,
  callTopFor,
  dotColour,
  exitText,
  FIRE_COLOUR,
  FIRE_MARK,
  failureStreak,
  fireLine,
  firesHeading,
  firesText,
  fittedFooter,
  formatSize,
  ITERATION_COLOUR,
  inTab,
  isCommandCall,
  iterationLine,
  iterationsText,
  kindWord,
  LIST_KEYS,
  type MatchField,
  messageOf,
  missedText,
  nameColour,
  nextFireText,
  PROCESS_KEYS,
  pad,
  pageKey,
  passesFilter,
  pastedQuery,
  type RowMatch,
  rightText,
  STEP_MARK,
  singleLine,
  stepColour,
  typedQuery,
} from "./panel-format.js";
import {
  DEFAULT_PANEL_FILTER,
  DETAIL_OUTPUT_LINES,
  DETAIL_TAIL_LINES,
  ID_COLUMN_WIDTH,
  LABEL_WIDTH,
  LIST_VISIBLE_ROWS,
  PANEL_FILTERS,
  PANEL_TABS,
  type PanelFilter,
  type PanelMode,
  type PanelSource,
  type PanelStopResult,
  type PanelTab,
  type PanelTaskView,
  QUERY_MAX_LENGTH,
  READ_ONLY,
  STRIP_CELLS,
  TAB_EMPTY,
  TAB_TITLE,
  type TasksPanelOptions,
} from "./panel-model.js";
import { STATUS_COLOUR } from "./status-colour.js";

export * from "./panel-format.js";
export * from "./panel-model.js";

/** Refresh period; the tail of a running task should look alive. */
const REFRESH_MS = 1000;

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
  private filter: PanelFilter = DEFAULT_PANEL_FILTER;
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
        open.task.kind !== "prompt-loop" ||
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

  /**
   * Hold the selected task across a refresh or a narrower query, or fall back to
   * the first row. Ranking can lift the held task above the scroll window, so the
   * window follows it; a query never hides the row a reader is standing on.
   */
  private keepSelection(): void {
    const index = this.rows.findIndex((row) => row.task.id === this.selectedId);
    if (index < 0) {
      this.selectedId = this.rows[0]?.task.id;
      this.listTop = 0;
      return;
    }
    if (index < this.listTop) this.listTop = index;
    if (index >= this.listTop + LIST_VISIBLE_ROWS) this.listTop = index - LIST_VISIBLE_ROWS + 1;
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
    if (row?.task.kind === "prompt-loop") {
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

  private handleLoopDetailInput(data: string, task: PromptLoopTask): void {
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
  private moveIteration(delta: number, task: PromptLoopTask): void {
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
    if (row === undefined || row.task.kind !== "prompt-loop") return;
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
    if (row === undefined || row.task.kind !== "prompt-loop") return;
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
      this.notice =
        "No tasks to open yet — run a command with pretty_task_bg_run and it appears here.";
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
      row?.task.kind === "prompt-loop"
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
    // The key belongs to the page in front of the reader: an open fire is a process
    // record of its own, so `R` repeats that fire, not the loop above it (ticket #35).
    const row = this.mode === "detail" ? this.detailRow() : this.rows[this.selectedIndex()];
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
      // for. Starting the same pipeline again is a `pretty_task_bg_run` with the same `after`.
      this.notice = "A chain is a queue; run its steps again with pretty_task_bg_run.";
      this.paint();
      return;
    }
    // A step of a chain is a move in its queue, not a command that stands alone:
    // repeating it here would run work the queue has not reached or has passed. The
    // reason is said out loud, because `R` on a row that looks like a process would
    // otherwise seem to have been ignored (ticket #35).
    if (
      row.task.kind === "process" &&
      row.task.parentId !== undefined &&
      row.task.fire === undefined
    ) {
      this.notice =
        "A chain step runs inside its queue; run the chain again with pretty_task_bg_run.";
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
    // As with `R`: the path belongs to the page in front of the reader, so an open
    // fire names its own file and a loop detail names the loop's (ticket #35).
    const row = this.mode === "detail" ? this.detailRow() : this.rows[this.selectedIndex()];
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
  private currentIteration(task: PromptLoopTask): Iteration | undefined {
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
    // The frame is the one place the panel's width is guaranteed: whatever a caller
    // hands it — a cell that already padded itself, a field value, a footer no
    // candidate could shorten — every line leaves here exactly `inner` columns wide.
    // A line that would not fit is cut with an ellipsis rather than pushing the
    // border right (ADR-0017); colouring happens before this, and the cut counts
    // only the columns a reader sees.
    const fitted = (text: string, room: number): string =>
      visibleWidth(text) > room ? truncateToWidth(text, room, "…", false) : text;
    const padded = (text: string, room: number): string => {
      const fit = fitted(text, room);
      return fit + " ".repeat(Math.max(0, room - visibleWidth(fit)));
    };
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
   * `1 Processes 2 │ 2 Loops 1 │ 3 Chains · filter: running`: each tab carries how
   * much of its kind is live right now, so a page the reader is not on still says
   * whether it holds work. The page being read is washed with the selection colour,
   * so the band doubles as where-am-I and as the keys that get you elsewhere
   * (ADR-0012, `1`/`2`/`3`).
   */
  private tabBand(): string {
    const theme = this.theme;
    const pages = PANEL_TABS.map((tab, index) => {
      const live = this.liveCount(tab);
      const title = `${String(index + 1)} ${TAB_TITLE[tab]}`;
      const badge = theme.fg(live > 0 ? "accent" : "muted", String(live));
      return tab === this.tab
        ? theme.bg(
            "selectedBg",
            `${theme.fg("text", ` ${title} `)}${theme.fg("accent", `${badge} `)}`,
          )
        : `${theme.fg("muted", ` ${title} `)}${badge} `;
    });
    const divider = theme.fg("borderMuted", "│");
    return `${pages.join(divider)}${theme.fg("muted", `· filter: ${this.filter}`)}`;
  }

  /** How many rows on that page are live; a paused loop still counts as owed a turn. */
  private liveCount(tab: PanelTab): number {
    return this.allRows.filter(
      (row) =>
        inTab(row.task, tab) && (row.task.status === "running" || row.task.status === "paused"),
    ).length;
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
  private listFooter(room: number): string {
    return fittedFooter(LIST_KEYS, room);
  }

  /** The box around the rows: the header sits above it, the keys inside the bottom. */
  private listFrame(body: string[], width: number): string[] {
    const theme = this.theme;
    const inner = Math.max(1, width - 2);
    const edge = (glyph: string): string => theme.fg("borderAccent", glyph);
    const fitted = (text: string, room: number): string =>
      visibleWidth(text) > room ? truncateToWidth(text, room, "…", false) : text;
    const padded = (text: string, room: number): string => {
      const fit = fitted(text, room);
      return fit + " ".repeat(Math.max(0, room - visibleWidth(fit)));
    };
    const row = (content = ""): string => `${edge("│")}${padded(content, inner)}${edge("│")}`;

    const lines = [
      // The bands above the box are full-width lines of their own, so they are cut to
      // the terminal rather than padded to it: a tally that does not fit loses its
      // tail instead of pushing the panel wider (ticket #34).
      ...this.listHeader(width).map((line) => fitted(line, width)),
      edge(`╭${"─".repeat(inner)}╮`),
    ];
    for (const line of body) lines.push(row(line));
    // The keys are chosen while still plain text: cutting a coloured string can slice
    // an escape in half and leave the border one column off.
    const footer = this.listFooter(inner - 1);
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
            : this.filter === "running"
              ? "  Nothing is running on this page — f shows every status, so finished work is one keypress away."
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
    // A hit in a word the row does not print still finds the row; the row names
    // the word instead of leaving the reader to guess why it is here.
    const notePlain = match?.hidden === true ? ` via ${match.field}` : "";
    const note = notePlain === "" ? "" : theme.fg("muted", notePlain);

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
    const headPlain = ` ${pointer} ${dot} ${name} ${id}${tag} ${separator} ${kind} ${status}${exit}${note} `;
    // The numbers get the room the head leaves, minus one space of gap, so they can
    // shed their least important parts instead of pushing the row past the border.
    // The room is measured on the bare cells: a theme adds markup, and only the
    // characters a reader sees should cost a number its place.
    const headCells = ` ${selected ? "›" : " "} ● ${namePlain} ${pad(
      task.id,
      ID_COLUMN_WIDTH,
    )}${tagPlain} · ${kindWord(task.kind)} ${pad(task.status, 11)}${exitText(task) === "" ? "" : ` ${exitText(task)}`}${notePlain} `;
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
    if (row.task.kind === "prompt-loop") return this.renderLoopDetail(row, width);
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
      // The keys shed whole entries on a narrow terminal: the frame would otherwise
      // cut the last one in half and leave the border a column off (ticket #34).
      fittedFooter(PROCESS_KEYS, Math.max(1, width - 3)),
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
    if (task.kind !== "prompt-loop") return this.renderList(width);
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
    if (row === undefined || row.task.kind !== "prompt-loop") return this.renderList(width);
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
