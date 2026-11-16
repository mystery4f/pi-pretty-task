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

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { formatBytes } from "../../tasks/base/format.js";
import type { CmdLoopTask, FireRecord, PromptLoopTask, Task } from "../../tasks/base/task.js";
import type { Iteration } from "../../tasks/loop/iteration.js";
import { renderDetail, renderIterationDetail } from "./detail.js";
import {
  bestFieldMatch,
  inTab,
  messageOf,
  pageKey,
  passesFilter,
  pastedQuery,
  type RowMatch,
  typedQuery,
} from "./format.js";
import { foreign, renderList, selectedIndex, stepRecord } from "./list.js";
import {
  DEFAULT_PANEL_FILTER,
  DETAIL_OUTPUT_LINES,
  DETAIL_TAIL_LINES,
  LIST_VISIBLE_ROWS,
  PANEL_FILTERS,
  type PanelFilter,
  type PanelMode,
  type PanelSource,
  type PanelStopResult,
  type PanelTab,
  type PanelTaskView,
  QUERY_MAX_LENGTH,
  READ_ONLY,
  type TasksPanelOptions,
} from "./model.js";

export * from "./format.js";
export * from "./model.js";

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
  readonly tui: Pick<TUI, "requestRender">;
  readonly theme: Theme;
  readonly done: () => void;
  readonly source: PanelSource;
  readonly now: () => number;
  readonly timer: ReturnType<typeof setInterval> | undefined;

  mode: PanelMode = "list";
  /** Width of the frame being drawn; field values are cut against it. */
  renderWidth = 80;
  /** What the reader may open: the filter has already been applied. */
  rows: readonly PanelTaskView[] = [];
  /** Every row of the session, so the counts never depend on the filters. */
  allRows: readonly PanelTaskView[] = [];
  /** The page being read; a reopened panel starts on the remembered one (ADR-0012). */
  tab: PanelTab = rememberedTab;
  /** The status filter `f` cycles, applied inside the open page. */
  filter: PanelFilter = DEFAULT_PANEL_FILTER;
  /**
   * Whether `o` has brought in the other sessions working in this checkout. Their
   * rows are read-only and tagged, and the counts above never include them.
   */
  showOthers = false;
  /** Roots of the other sessions, loaded on demand and merged into the page. */
  otherRows: PanelTaskView[] = [];
  /**
   * What each page had selected when the reader left it, keyed by page. Reopening a
   * page lands where it was left rather than at the top (ADR-0012 keeps selection by id).
   */
  readonly selectedByTab: Record<PanelTab, string | undefined> = {
    processes: undefined,
    loops: undefined,
    chains: undefined,
  };
  selectedId: string | undefined;
  listTop = 0;
  /** `/` turns keys into a query instead of navigation; `alt+q` leaves it. */
  searching = false;
  /** The query outlives search mode: leaving keeps it, and the header keeps showing it. */
  query = "";
  /** Where each shown row's query landed; empty when there is no query. */
  readonly matchScores = new Map<PanelTaskView, RowMatch>();

  detailId: string | undefined;
  detailLines: readonly string[] = [];
  detailTruncated = false;
  detailError: string | undefined;
  /** Lines the reader has scrolled up from the newest; 0 follows the tail. */
  scrollBack = 0;
  /** False while scrolled up: the buffer stays frozen so the view does not move. */
  following = true;

  /** Which iteration of the open loop is selected, by fire number. */
  iterationFire: number | undefined;
  /** First iteration row drawn in the loop detail's newest-first list. */
  iterationTop = 0;
  /** First call drawn in the iteration view, counted from the oldest call. */
  callTop = 0;

  notice: string | undefined;
  /** Bytes each task had at the previous refresh, so the list can show `+4.1KB ↑`. */
  readonly lastBytes = new Map<string, number>();
  readonly recentGrowth = new Map<string, { bytes: number; at: number }>();
  /** Serialises async work so a keypress never races the refresh it started. */
  pending: Promise<void> = Promise.resolve();

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
  applyFilters(): void {
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
  matchField(task: Task): RowMatch | undefined {
    const steps =
      task.kind === "chain"
        ? task.steps.flatMap((id, index) => {
            const name = stepRecord(this, id)?.name ?? "";
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
  keepSelection(): void {
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
  trackGrowth(): void {
    const now = Date.now();
    for (const row of this.rows) {
      const before = this.lastBytes.get(row.task.id);
      this.lastBytes.set(row.task.id, row.outputBytes);
      if (before === undefined || row.outputBytes <= before) continue;
      this.recentGrowth.set(row.task.id, { bytes: row.outputBytes - before, at: now });
    }
  }

  /** The `+size ↑` a still-growing task shows for a few seconds after a refresh. */
  growthText(row: PanelTaskView): string {
    const recent = this.recentGrowth.get(row.task.id);
    if (recent === undefined || Date.now() - recent.at >= 3000) return "";
    return ` ${this.theme.fg("warning", `+${formatBytes(recent.bytes)} ↑`)}`;
  }
  render(width: number): string[] {
    // Field values are cut against the frame they sit in, so the frame never has to
    // re-measure text that already carries colour.
    this.renderWidth = width;
    if (this.mode === "iteration") return renderIterationDetail(this, width);
    return this.mode === "detail" ? renderDetail(this, width) : renderList(this, width);
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

  handleListInput(data: string): void {
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
  handleSearchInput(data: string): void {
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
  setQuery(query: string): void {
    this.query = query.slice(0, QUERY_MAX_LENGTH);
    this.applyFilters();
    this.paint();
  }

  handleDetailInput(data: string): void {
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
  handleProcessDetailInput(data: string): void {
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

  handleLoopDetailInput(data: string, task: PromptLoopTask): void {
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
  handleCmdLoopDetailInput(data: string, task: CmdLoopTask): void {
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
  moveFire(delta: number, task: CmdLoopTask): void {
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
  openFire(): void {
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
  handleIterationInput(data: string): void {
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
  moveIteration(delta: number, task: PromptLoopTask): void {
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

  openIteration(): void {
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

  scrollCalls(delta: number): void {
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

  moveSelection(delta: number): void {
    if (this.rows.length === 0) return;
    const current = this.rows.findIndex((row) => row.task.id === this.selectedId);
    const base = current === -1 ? 0 : current;
    const next = Math.min(this.rows.length - 1, Math.max(0, base + delta));
    this.selectedId = this.rows[next]?.task.id;
    if (next < this.listTop) this.listTop = next;
    if (next >= this.listTop + LIST_VISIBLE_ROWS) this.listTop = next - LIST_VISIBLE_ROWS + 1;
    this.paint();
  }

  openDetail(): void {
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
  scrollDetail(delta: number): void {
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

  follow(): void {
    this.following = true;
    this.scrollBack = 0;
    this.enqueue(async () => {
      await this.readTail();
      this.paint();
    });
  }

  stopSelected(): void {
    // In a task detail `k` stops what is open: an expanded fire is its own record,
    // so stopping it must not end the schedule behind it (ADR-0015).
    const row = this.mode === "detail" ? this.detailRow() : this.rows[selectedIndex(this)];
    const id = row?.task.id;
    if (id === undefined) return;
    // Another session's task belongs to that session: this panel may read it, never
    // end it, so `k` says why and leaves the store alone (ticket #27).
    if (foreign(this, row)) {
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
  stopAll(): void {
    // `o` can put another session's rows on the page, and `a` stops only the ones
    // this session owns: the rest are there to be read (ticket #27).
    const ids = this.rows.filter((row) => !foreign(this, row)).map((row) => row.task.id);
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
  selectTab(next: PanelTab): void {
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
  cycleFilter(): void {
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
  toggleOthers(): void {
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
  rerunSelected(): void {
    // The key belongs to the page in front of the reader: an open fire is a process
    // record of its own, so `R` repeats that fire, not the loop above it (ticket #35).
    const row = this.mode === "detail" ? this.detailRow() : this.rows[selectedIndex(this)];
    if (row === undefined) {
      this.notice = "No task selected.";
      this.paint();
      return;
    }
    // Another session started this command, so running it again is its decision, not
    // a reader's on a page that only borrowed the row (ticket #27).
    if (foreign(this, row)) {
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
  showOutputPath(): void {
    // As with `R`: the path belongs to the page in front of the reader, so an open
    // fire names its own file and a loop detail names the loop's (ticket #35).
    const row = this.mode === "detail" ? this.detailRow() : this.rows[selectedIndex(this)];
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
  detailRow(): PanelTaskView | undefined {
    return (
      this.rows.find((row) => row.task.id === this.detailId) ??
      // A fire is not a row, so a fire detail is found among the children: the
      // panel opened it from its loop, and `←` goes back there (ADR-0014).
      this.allRows.find((row) => row.task.id === this.detailId)
    );
  }

  /** The iteration under the cursor, or the newest one when the store trimmed the pick. */
  currentIteration(task: PromptLoopTask): Iteration | undefined {
    if (this.iterationFire !== undefined) {
      const found = task.iterations.find((iteration) => iteration.fire === this.iterationFire);
      if (found !== undefined) return found;
    }
    return task.iterations.at(-1);
  }

  /** The fire under the cursor, or the newest one when the history cap trimmed it. */
  currentFire(task: CmdLoopTask): FireRecord | undefined {
    if (this.iterationFire !== undefined) {
      const found = task.fireHistory.find((fire) => fire.fire === this.iterationFire);
      if (found !== undefined) return found;
    }
    return task.fireHistory.at(-1);
  }

  async readTail(): Promise<void> {
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

  enqueue(work: () => Promise<void>): void {
    this.pending = this.pending.then(work, work).catch(() => undefined);
  }

  paint(): void {
    this.tui.requestRender();
  }

  // ---- drawing -------------------------------------------------------------

  /**
   * The box the whole panel lives in: a border, a tinted title band carrying the
   * counts, the body, then the keys. It mirrors the panel this plugin replaces so
   * the eye lands in the same place; colours still come from theme tokens.
   */
  frame(title: string, subtitle: string, body: string[], footer: string, width: number): string[] {
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

  /**
   * `1 Processes 2 │ 2 Loops 1 │ 3 Chains · filter: running`: each tab carries how
   * much of its kind is live right now, so a page the reader is not on still says
   * whether it holds work. The page being read is washed with the selection colour,
   * so the band doubles as where-am-I and as the keys that get you elsewhere
   * (ADR-0012, `1`/`2`/`3`).
   */

  /** How many rows on that page are live; a paused loop still counts as owed a turn. */

  /** One `dot label number` per ending, in the order the reader cares about. */

  /** The list's keys, the same on every page (ADR-0012): one model, three lists. */

  /** The box around the rows: the header sits above it, the keys inside the bottom. */

  /** True for a row `o` brought in from another session: readable, never writable. */

  /**
   * The field's text in its own colour, with the query's characters in the accent
   * weight. The match is computed on the bare text and applied here, fragment by
   * fragment, so a theme's escapes never reach the matcher and the padding keeps
   * its width.
   */

  /**
   * One list row, in the shape of a process listing: pointer, live dot, name, id,
   * status, then the numbers. Every cell is padded before it is coloured, so the
   * border stays straight whatever the theme does with escapes.
   */

  /**
   * The fire strip: newest STRIP_CELLS fires, oldest left, one coloured cell each.
   * On a narrow row the oldest cells drop first, and when nothing fits the strip is
   * omitted rather than wrapped, so the row keeps its shape (ADR-0015).
   */

  /** The record a chain step id names, or undefined while its record is missing. */

  /** Which step a chain is on, in words a reader does not have to decode a cursor for. */

  /**
   * The chain's own column: its steps in run order, joined by arrows, with the step at
   * the cursor in the accent colour and bold. On a narrow row the steps it has already
   * got through drop first, newest kept, and a leading ellipsis says something was
   * left out — a chain never wraps and never hides the step that is running (ADR-0012).
   */

  /**
   * A chain detail: the queue in run order, one line per step with the status, the
   * duration and the exit code it ended with. The step at the cursor is marked, so
   * the list says what is running now and what never got its turn (ADR-0012).
   */

  /** The output tail, inside its own thin border so it reads as a window, not a field. */

  /** A loop detail: schedule facts, then the iterations it produced, newest first. */

  /** A command loop detail: schedule facts, then the fires it produced, newest first. */

  /** An iteration detail: the tool calls that turn made, oldest first; `←` goes back. */

  /** One call row: its subject (a command stands out), then its result or error. */

  /** Where the visible window sits: following the newest line, or a frozen range. */

  /** Visible slice of the detail buffer, as half-open `[from, to)`. */

  /**
   * The session that owns a row, printed only when it is not this one: the list had
   * room for six characters, the detail has room to name the whole session so a
   * reader can go and ask it (ticket #27).
   */

  /** Absolute clock plus age: the list shows only the age, the detail can afford both. */
}
