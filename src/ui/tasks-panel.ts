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
import type { LoopTask, Task } from "../tasks/base/task.js";
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

/** Refresh period; the tail of a running task should look alive. */
const REFRESH_MS = 1000;

/** One task as the panel reads it: the record plus the numbers the list shows. */
export interface PanelTaskView {
  readonly task: Task;
  readonly elapsedMs: number;
  readonly outputBytes: number;
  /** A running loop's countdown to the next fire, when the store knows it. */
  readonly untilNextFireMs?: number;
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
  /** Every task in the session, in any order; the panel sorts newest first. */
  list(): Promise<readonly PanelTaskView[]>;
  /** Trailing output for one process task; an absent file is an empty tail, not an error. */
  tail(id: string): Promise<OutputTail | undefined>;
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
}

/** List → task detail → iteration detail; the third level exists only under a loop. */
type PanelMode = "list" | "detail" | "iteration";

/** Newest first: the row the reader most likely wants is on top. */
function newestFirst(left: PanelTaskView, right: PanelTaskView): number {
  return right.task.createdAt - left.task.createdAt;
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
  private readonly timer: ReturnType<typeof setInterval> | undefined;

  private mode: PanelMode = "list";
  /** Width of the frame being drawn; field values are cut against it. */
  private renderWidth = 80;
  /** What the reader may open: the filter has already been applied. */
  private rows: readonly PanelTaskView[] = [];
  /** Every row of the session, so the counts never depend on the filters. */
  private allRows: readonly PanelTaskView[] = [];
  /** `h` shows the finished rows; until then only live work is listed. */
  private showHistory = false;
  private selectedId: string | undefined;
  private listTop = 0;
  /** `l` narrows the list to loop tasks; a second press brings the process rows back. */
  private onlyLoops = false;

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
      const all = [...(await this.source.list())].sort(newestFirst);
      this.allRows = all;
      // The loop filter narrows what the reader sees, never what the store holds.
      const kindRows = this.onlyLoops ? all.filter((row) => row.task.kind === "loop") : all;
      // Finished work is history, and history is asked for: the panel opens on what
      // is live, and shows the past on `h` — or when nothing is left running.
      const live = kindRows.filter((row) => row.task.status === "running");
      this.rows = this.showHistory || live.length === 0 ? kindRows : live;
    } catch {
      // A store that cannot list is a store with nothing to show, not a crash.
      this.rows = [];
    }
    this.trackGrowth();

    if (!this.rows.some((row) => row.task.id === this.selectedId)) {
      this.selectedId = this.rows[0]?.task.id;
      this.listTop = 0;
    }
    if (this.mode === "detail" && this.following && this.detailRow()?.task.kind === "process") {
      await this.readTail();
    }
    if (this.mode === "iteration") {
      const open = this.detailRow();
      if (
        open === undefined ||
        open.task.kind !== "loop" ||
        this.currentIteration(open.task) === undefined
      ) {
        // The open iteration fell out of the store's history cap, or its loop vanished.
        this.mode = "detail";
      }
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
    if (data === "x" || data === "q" || matchesKey(data, "escape")) {
      this.done();
      return;
    }
    if (this.mode === "iteration") this.handleIterationInput(data);
    else if (this.mode === "detail") this.handleDetailInput(data);
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
    if (data === "l") this.toggleLoopFilter();
    if (data === "h") this.toggleHistory();
    if (data === "R") this.rerunSelected();
    if (data === "c") this.showOutputPath();
  }

  private handleDetailInput(data: string): void {
    const row = this.detailRow();
    if (row?.task.kind === "loop") {
      this.handleLoopDetailInput(data, row.task);
      return;
    }
    this.handleProcessDetailInput(data);
  }

  /** A process detail scrolls its output; a loop detail walks its iterations instead. */
  private handleProcessDetailInput(data: string): void {
    if (matchesKey(data, "left")) {
      this.mode = "list";
      this.paint();
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

  private handleLoopDetailInput(data: string, task: LoopTask): void {
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
  private moveIteration(delta: number, task: LoopTask): void {
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
    if (row === undefined || row.task.kind !== "loop") return;
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
    if (row === undefined || row.task.kind !== "loop") return;
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
    // A loop opens on its newest iteration; a process opens on the tail of its output.
    this.iterationFire = row?.task.kind === "loop" ? row.task.iterations.at(-1)?.fire : undefined;
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
    const id = this.selectedId;
    if (id === undefined) return;
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
    const ids = this.rows.map((row) => row.task.id);
    if (ids.length === 0) {
      this.notice = "No tasks to stop.";
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

  /** `l` shows only loop tasks, or everything again. */
  private toggleLoopFilter(): void {
    this.onlyLoops = !this.onlyLoops;
    this.notice = this.onlyLoops ? "showing loops only" : undefined;
    this.enqueue(async () => {
      await this.refresh();
      this.paint();
    });
  }

  /** `h` shows the finished rows, or hides them again; the counts never follow it. */
  private toggleHistory(): void {
    this.showHistory = !this.showHistory;
    this.notice = this.showHistory ? "showing history" : "history hidden";
    this.enqueue(async () => {
      await this.refresh();
      this.paint();
    });
  }

  /** `R` runs the selected command again; the old row stays as its own record. */
  private rerunSelected(): void {
    const row = this.rows[this.selectedIndex()];
    if (row === undefined) {
      this.notice = "No task selected.";
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
    this.notice =
      row.task.kind === "process"
        ? `output: ${row.task.outputPath}`
        : "a loop writes no output file";
    this.paint();
  }

  // ---- data ----------------------------------------------------------------
  private detailRow(): PanelTaskView | undefined {
    return this.rows.find((row) => row.task.id === this.detailId);
  }

  /** The iteration under the cursor, or the newest one when the store trimmed the pick. */
  private currentIteration(task: LoopTask): Iteration | undefined {
    if (this.iterationFire !== undefined) {
      const found = task.iterations.find((iteration) => iteration.fire === this.iterationFire);
      if (found !== undefined) return found;
    }
    return task.iterations.at(-1);
  }

  private async readTail(): Promise<void> {
    // Only a process task has an output file; a loop detail never asks the source for one.
    if (this.detailRow()?.task.kind !== "process") return;
    const id = this.detailId;
    if (id === undefined) return;
    try {
      const tail = await this.source.tail(id);
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
   * come from every row, so a filter can never hide a failure.
   */
  private listHeader(width: number): string[] {
    const theme = this.theme;
    const heading = theme.fg("borderMuted", "──") + theme.fg("text", " Background Tasks ");
    const rule = Math.max(0, width - visibleWidth("── Background Tasks "));
    return [heading + theme.fg("borderMuted", "─".repeat(rule)), ` ${this.countsLine()} `];
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

  /** The list's keys: the replaced panel's set, plus the loop filter this plugin adds. */
  private listFooter(): string {
    return "↑/↓ · Enter logs · k stop · a stop all · h history · R rerun · c path · l loops · x close";
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
      body.push(
        "",
        theme.fg("dim", "  No tasks yet — run a command with bg_run and it appears here."),
      );
      return this.listFrame(body, width);
    }

    const visible = this.rows.slice(this.listTop, this.listTop + LIST_VISIBLE_ROWS);
    visible.forEach((row, offset) => {
      body.push(this.listRow(row, this.listTop + offset === this.selectedIndex(), inner));
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

  /**
   * One list row, in the shape of a process listing: pointer, live dot, name, id,
   * status, then the numbers. Every cell is padded before it is coloured, so the
   * border stays straight whatever the theme does with escapes.
   */
  private listRow(row: PanelTaskView, selected: boolean, width: number): string {
    const theme = this.theme;
    const task = row.task;
    const pointer = selected ? theme.fg("accent", "›") : " ";
    const dot = theme.fg(dotColour(task), "●");
    const id = theme.fg("dim", task.id);
    const separator = theme.fg("dim", "·");
    const status = theme.fg(STATUS_COLOUR[task.status], pad(task.status, 11));
    const exit = exitText(task) === "" ? "" : theme.fg("dim", ` ${exitText(task)}`);

    // The name takes what the numbers do not, the way the panel this replaces
    // splits its row: a name column that keeps growing would push the numbers
    // off the edge on a wide terminal.
    const nameRoom = Math.max(12, width - 78);
    const name = theme.fg(nameColour(task), pad(task.name, nameRoom));
    const right = theme.fg("dim", rightText(row));
    const growth = this.growthText(row);

    const line = ` ${pointer} ${dot} ${name} ${id} ${separator} ${status}${exit} ${right}${growth}`;
    // A selected row is washed in one block of background, the way the panel this
    // replaces marks its cursor: the eye finds it without a colour of its own.
    return selected
      ? theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))))
      : line;
  }

  private renderDetail(width: number): string[] {
    const row = this.detailRow();
    if (row === undefined) return this.renderList(width);
    return row.task.kind === "loop"
      ? this.renderLoopDetail(row, width)
      : this.renderProcessDetail(width);
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
      this.field("Status", theme.fg(colour, task.status)),
      this.field("Runtime", formatDuration(row.elapsedMs)),
      this.field("Started", formatClockTime(task.createdAt)),
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
      "↑/↓ scroll · r follow · ← list · k stop · R rerun · c path · x close",
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
    if (task.kind !== "loop") return this.renderList(width);
    const colour = STATUS_COLOUR[task.status];
    const body: string[] = [
      this.field("Status", theme.fg(colour, task.status)),
      this.field("Kind", task.kind),
      this.field("Runtime", formatDuration(row.elapsedMs)),
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
      "↑/↓ select · Enter iteration · ← list · k stop · x close",
      width,
    );
  }

  /** An iteration detail: the tool calls that turn made, oldest first; `←` goes back. */
  private renderIterationDetail(width: number): string[] {
    const theme = this.theme;
    const row = this.detailRow();
    if (row === undefined || row.task.kind !== "loop") return this.renderList(width);
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
      "↑/↓ scroll · ← loop · k stop · x close",
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

/** Exit column: a process has a code, a loop has fires instead. */
function exitText(task: Task): string {
  if (task.kind === "loop") return "";
  return task.exitCode === undefined ? "" : `exit ${String(task.exitCode)}`;
}

/** Right-hand numbers: a process reports runtime and output size, a loop its fires and schedule. */
function rightText(row: PanelTaskView): string {
  const task = row.task;
  const elapsed = formatDuration(row.elapsedMs);
  if (task.kind === "process") return `${elapsed} ${formatSize(row)}`;
  // A loop has no exit code and no bytes: it reports the fires it made and how
  // long until the next one, which is the whole question while it is running.
  const next =
    row.untilNextFireMs === undefined ? "" : ` · next ${formatDuration(row.untilNextFireMs)}`;
  return `${elapsed} · ${firesText(task)} fires${next}`;
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

function firesText(task: LoopTask): string {
  if (task.maxFires === undefined) return String(task.fires);
  return `${String(task.fires)} / ${String(task.maxFires)}`;
}

function nextFireText(task: LoopTask, row: PanelTaskView): string {
  if (task.nextFireAt === undefined) return "—";
  const at = formatClockTime(task.nextFireAt);
  return row.untilNextFireMs === undefined
    ? at
    : `${at} (in ${formatDuration(row.untilNextFireMs)})`;
}

/** Iteration list heading: kept and dropped counts are both stated, never hidden. */
function iterationsText(task: LoopTask): string {
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
