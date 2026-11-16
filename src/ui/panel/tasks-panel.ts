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
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatBytes } from "../../tasks/base/format.js";
import type { CmdLoopTask, FireRecord, PromptLoopTask, Task } from "../../tasks/base/task.js";
import type { Iteration } from "../../tasks/loop/iteration.js";
import { renderDetail, renderIterationDetail } from "./detail.js";
import { messageOf } from "./format.js";
import { handlePanelInput } from "./input.js";
import { renderList, stepRecord } from "./list.js";
import {
  DEFAULT_PANEL_FILTER,
  DETAIL_TAIL_LINES,
  LIST_VISIBLE_ROWS,
  type PanelFilter,
  type PanelMode,
  type PanelSource,
  type PanelTab,
  type PanelTaskView,
  type TasksPanelOptions,
} from "./model.js";
import { bestFieldMatch, type RowMatch } from "./query.js";
import { inTab, passesFilter } from "./row-filter.js";

export * from "./format.js";
export * from "./keys.js";
export * from "./model.js";
export * from "./query.js";
export * from "./row-filter.js";

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

  /** The keyboard model lives in `input.ts`; this is the component's one entry. */
  handleInput(data: string): void {
    handlePanelInput(this, data);
  }

  /** Remember the open page for the next panel; only a tab key changes it. */
  remember(tab: PanelTab): void {
    rememberPanelTab(tab);
  }

  invalidate(): void {
    this.paint();
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
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
