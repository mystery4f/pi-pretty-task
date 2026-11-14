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
  private rows: readonly PanelTaskView[] = [];
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
      // The loop filter narrows what the reader sees, never what the store holds.
      this.rows = this.onlyLoops ? all.filter((row) => row.task.kind === "loop") : all;
    } catch {
      // A store that cannot list is a store with nothing to show, not a crash.
      this.rows = [];
    }
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

  render(width: number): string[] {
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

  private renderList(width: number): string[] {
    const theme = this.theme;
    const lines: string[] = [
      `${theme.bold("Tasks")} ${theme.fg("muted", `· ${String(this.rows.length)} · newest first`)}`,
    ];

    if (this.rows.length === 0) {
      lines.push("");
      lines.push(this.notice ?? "No tasks yet — run a command with bg_run and it appears here.");
      lines.push(theme.fg("dim", "x closes"));
      return lines;
    }

    lines.push(theme.fg("dim", this.listHeader(width)));
    const visible = this.rows.slice(this.listTop, this.listTop + LIST_VISIBLE_ROWS);
    visible.forEach((row, offset) => {
      lines.push(this.listRow(row, this.listTop + offset === this.selectedIndex(), width));
    });
    if (this.notice !== undefined) lines.push(theme.fg("muted", this.notice));
    lines.push(
      theme.fg("dim", "↑/↓ select · Enter details · k stop · a stop all · l loops · x close"),
    );
    return lines;
  }

  private selectedIndex(): number {
    return this.rows.findIndex((row) => row.task.id === this.selectedId);
  }

  private listHeader(width: number): string {
    const columns = listColumns(width);
    const cells = [
      " ",
      ` ${pad("kind", 8)}`,
      ` ${pad("name", nameWidth(width))}`,
      ` ${pad("id", 10)}`,
      ` ${pad("status", 12)}`,
      ` ${padStart("elapsed", 9)}`,
      ` ${padStart("size", 10)}`,
    ];
    if (columns.iters) cells.push(` ${padStart("iters", 6)}`);
    if (columns.last) cells.push(` ${padStart("last", 9)}`);
    return cells.join("");
  }

  private listRow(row: PanelTaskView, selected: boolean, width: number): string {
    const theme = this.theme;
    const marker = selected ? theme.fg("accent", ">") : " ";
    const name = truncateToWidth(row.task.name, nameWidth(width), "…", false);
    const columns = listColumns(width);
    const cells = [
      marker,
      ` ${pad(row.task.kind, 8)}`,
      ` ${pad(name, nameWidth(width))}`,
      ` ${pad(row.task.id, 10)}`,
      ` ${theme.fg(STATUS_COLOUR[row.task.status], pad(row.task.status, 12))}`,
      ` ${padStart(formatDuration(row.elapsedMs), 9)}`,
      ` ${padStart(formatSize(row), 10)}`,
    ];
    if (columns.iters) cells.push(` ${padStart(iterationCountText(row.task), 6)}`);
    if (columns.last) cells.push(` ${padStart(lastFireText(row.task), 9)}`);
    return cells.join("");
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
    const lines: string[] = [
      `${theme.bold(task.name)} ${theme.fg("muted", `(${task.id})`)}`,
      "",
      this.field("status", theme.fg(colour, task.status)),
      this.field("kind", task.kind),
      this.field("elapsed", formatDuration(row.elapsedMs)),
      this.field("output", formatSize(row)),
    ];
    // Only a process task carries the process facts; a loop task has none of them.
    if (task.kind === "process") {
      if (task.pid !== undefined) lines.push(this.field("pid", String(task.pid)));
      lines.push(this.field("command", task.command));
      lines.push(this.field("output file", task.outputPath));
      if (task.cwd !== undefined) lines.push(this.field("cwd", task.cwd));
      if (task.exitCode !== undefined) {
        lines.push(this.field("exit code", theme.fg(colour, String(task.exitCode))));
      }
      if (task.killReason !== undefined) lines.push(this.field("kill reason", task.killReason));
    }
    if (task.error !== undefined) lines.push(this.field("error", theme.fg(colour, task.error)));

    lines.push("");
    lines.push(theme.fg("muted", `output · ${this.position()}`));

    if (this.detailError !== undefined) {
      lines.push(theme.fg("error", `  output unavailable: ${this.detailError}`));
    } else if (this.detailLines.length === 0) {
      lines.push(theme.fg("dim", "  no output yet"));
    } else {
      const [from, to] = this.window();
      for (const line of this.detailLines.slice(from, to)) {
        lines.push(`  ${truncateToWidth(line, Math.max(1, width - 2), "…", false)}`);
      }
      if (this.detailTruncated) lines.push(theme.fg("dim", "  … older output left out"));
    }

    if (this.notice !== undefined) lines.push(theme.fg("muted", this.notice));
    lines.push(theme.fg("dim", "↑/↓ scroll · r follow · ← list · k stop · x close"));
    return lines;
  }

  /** A loop detail: schedule facts, then the iterations it produced, newest first. */
  private renderLoopDetail(row: PanelTaskView, width: number): string[] {
    const theme = this.theme;
    const task = row.task;
    if (task.kind !== "loop") return this.renderList(width);
    const colour = STATUS_COLOUR[task.status];
    const lines: string[] = [
      `${theme.bold(task.name)} ${theme.fg("muted", `(${task.id})`)}`,
      "",
      this.field("status", theme.fg(colour, task.status)),
      this.field("kind", task.kind),
      this.field("elapsed", formatDuration(row.elapsedMs)),
      this.field("schedule", task.schedule),
      this.field("fires", firesText(task)),
      this.field("next fire", nextFireText(task, row)),
      this.field(
        "last fire",
        task.lastFireAt === undefined ? "—" : formatClockTime(task.lastFireAt),
      ),
    ];
    if (task.expiresAt !== undefined)
      lines.push(this.field("expires", formatClockTime(task.expiresAt)));
    if (task.endedAt !== undefined) lines.push(this.field("ended", formatClockTime(task.endedAt)));
    if (task.error !== undefined) lines.push(this.field("error", theme.fg(colour, task.error)));
    lines.push(this.field("prompt", singleLine(task.prompt, Math.max(1, width - 10))));
    lines.push("");
    lines.push(theme.fg("muted", iterationsText(task)));

    const newestFirst = [...task.iterations].reverse();
    if (newestFirst.length === 0) {
      lines.push(theme.fg("dim", "  no iteration recorded yet"));
    } else {
      const selected = this.currentIteration(task);
      const top = Math.min(
        Math.max(0, this.iterationTop),
        Math.max(0, newestFirst.length - LIST_VISIBLE_ROWS),
      );
      const visible = newestFirst.slice(top, top + LIST_VISIBLE_ROWS);
      if (top > 0) lines.push(theme.fg("dim", `  … ${String(top)} newer above`));
      for (const iteration of visible) {
        const marker = iteration.fire === selected?.fire ? theme.fg("accent", ">") : " ";
        const text = iterationLine(iteration);
        lines.push(`${marker} ${truncateToWidth(text, Math.max(1, width - 2), "…", false)}`);
      }
      const below = newestFirst.length - top - visible.length;
      if (below > 0) lines.push(theme.fg("dim", `  … ${String(below)} older below`));
    }

    if (this.notice !== undefined) lines.push(theme.fg("muted", this.notice));
    lines.push(theme.fg("dim", "↑/↓ select · Enter iteration · ← list · k stop · x close"));
    return lines;
  }

  /** An iteration detail: the tool calls that turn made, oldest first; `←` goes back. */
  private renderIterationDetail(width: number): string[] {
    const theme = this.theme;
    const row = this.detailRow();
    if (row === undefined || row.task.kind !== "loop") return this.renderList(width);
    const task = row.task;
    const iteration = this.currentIteration(task);
    if (iteration === undefined) return this.renderLoopDetail(row, width);

    const lines: string[] = [
      `${theme.bold(`fire ${String(iteration.fire)}`)} ${theme.fg(
        "muted",
        `(${task.name} · ${task.id})`,
      )}`,
      "",
      this.field("status", theme.fg(ITERATION_COLOUR[iteration.status], iteration.status)),
      this.field("started", formatClockTime(iteration.startedAt)),
    ];
    if (iteration.endedAt !== undefined) {
      lines.push(this.field("took", formatDuration(iteration.endedAt - iteration.startedAt)));
    }
    lines.push(this.field("calls", callsText(iteration)));
    lines.push("");
    lines.push(theme.fg("muted", callsHeading(iteration, this.callTop)));

    const top = callTopFor(iteration, this.callTop);
    const visible = iteration.calls.slice(top, top + DETAIL_OUTPUT_LINES);
    if (visible.length === 0) {
      lines.push(theme.fg("dim", "  no tool call in this turn"));
    }
    visible.forEach((call, offset) => {
      lines.push(this.callLine(call, top + offset, width));
      if (call.error !== undefined) {
        lines.push(theme.fg(STATUS_COLOUR.failed, `     error: ${call.error}`));
      }
    });
    // The cap drops the oldest calls first; say so where they would have been.
    if (iteration.droppedCalls > 0) {
      lines.push(
        theme.fg(
          STATUS_COLOUR.interrupted,
          `  … +${String(iteration.droppedCalls)} earlier calls dropped`,
        ),
      );
    }

    if (this.notice !== undefined) lines.push(theme.fg("muted", this.notice));
    lines.push(theme.fg("dim", "↑/↓ scroll · ← loop · k stop · x close"));
    return lines;
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
    if (this.following || this.detailLines.length === 0) return "following";
    const [from, to] = this.window();
    return `lines ${String(from + 1)}–${String(to)} of ${String(this.detailLines.length)} · r resumes following`;
  }

  /** Visible slice of the detail buffer, as half-open `[from, to)`. */
  private window(): [number, number] {
    const total = this.detailLines.length;
    const to = Math.max(0, total - this.scrollBack);
    return [Math.max(0, to - DETAIL_OUTPUT_LINES), to];
  }

  private field(label: string, value: string): string {
    return `${this.theme.fg("muted", pad(label, 10))}${value}`;
  }
}

/** Size column: output bytes for a process task; a loop task has no output file. */
function formatSize(row: PanelTaskView): string {
  return row.task.kind === "process" ? formatBytes(row.outputBytes) : "—";
}

/** Columns the fixed list fields take, marker and gaps included. */
const FIXED_COLUMNS = 2 + 9 + 11 + 13 + 10 + 11 + 7 + 10;

/** `last` and `iters` are 10 and 7 cells wide; a narrow terminal loses them first. */
const LAST_COLUMN = 10;
const ITERS_COLUMN = 7;

/** Which optional columns a terminal this wide still fits, and what they leave the name. */
function listColumns(width: number): { fixed: number; last: boolean; iters: boolean } {
  const floor = 4;
  if (width >= FIXED_COLUMNS + floor) {
    return { fixed: FIXED_COLUMNS, last: true, iters: true };
  }
  const withoutLast = FIXED_COLUMNS - LAST_COLUMN;
  if (width >= withoutLast + floor) {
    return { fixed: withoutLast, last: false, iters: true };
  }
  // Below this the row keeps marker, kind, name, id, status, elapsed and size only.
  return { fixed: FIXED_COLUMNS - LAST_COLUMN - ITERS_COLUMN, last: false, iters: false };
}

/** Space a task name may use: whatever the fixed columns leave, with a floor. */
function nameWidth(width: number): number {
  // The floor is deliberately small: a narrow terminal must lose the name first,
  // not wrap the row (scope-v1 keeps terminal size as the panel's known risk).
  return Math.max(4, width - listColumns(width).fixed);
}

function pad(text: string, width: number): string {
  // Width is pixels, not code units: a CJK or emoji name must not shift the columns.
  const used = visibleWidth(text);
  return used >= width ? truncateToWidth(text, width, "", false) : text + " ".repeat(width - used);
}

function padStart(text: string, width: number): string {
  const used = visibleWidth(text);
  return used >= width ? text : " ".repeat(width - used) + text;
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

/** The iterations column: kept count, plus any the history cap dropped. */
function iterationCountText(task: Task): string {
  if (task.kind !== "loop") return "—";
  const dropped = task.droppedIterations ?? 0;
  const kept = String(task.iterations.length);
  return dropped === 0 ? kept : `${kept}+${String(dropped)}`;
}

/** The last-fire column: wall-clock time, or a dash before the first fire. */
function lastFireText(task: Task): string {
  if (task.kind !== "loop" || task.lastFireAt === undefined) return "—";
  return formatClockTime(task.lastFireAt);
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
