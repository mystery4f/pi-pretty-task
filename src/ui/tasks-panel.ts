/**
 * The `/tasks` panel: one overlay over every task in the session, list and detail.
 *
 * It is a plain pi-tui `Component` with no state of its own beyond keys and
 * pixels: records and processes belong to the store, and the panel reaches them
 * only through `PanelSource`. Nothing here signals a process or touches a file.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { formatBytes, formatDuration } from "../tasks/base/format.js";
import type { OutputTail } from "../tasks/base/output.js";
import type { Task } from "../tasks/base/task.js";
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
  /** Trailing output for one task; an absent file is an empty tail, not an error. */
  tail(id: string): Promise<OutputTail | undefined>;
  /** Stop one task; the store kills the process tree, the panel never signals. */
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

type PanelMode = "list" | "detail";

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

  private detailId: string | undefined;
  private detailLines: readonly string[] = [];
  private detailTruncated = false;
  private detailError: string | undefined;
  /** Lines the reader has scrolled up from the newest; 0 follows the tail. */
  private scrollBack = 0;
  /** False while scrolled up: the buffer stays frozen so the view does not move. */
  private following = true;

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
      this.rows = [...(await this.source.list())].sort(newestFirst);
    } catch {
      // A store that cannot list is a store with nothing to show, not a crash.
      this.rows = [];
    }
    if (!this.rows.some((row) => row.task.id === this.selectedId)) {
      this.selectedId = this.rows[0]?.task.id;
      this.listTop = 0;
    }
    if (this.mode === "detail" && this.following) await this.readTail();
  }

  render(width: number): string[] {
    return this.mode === "detail" ? this.renderDetail(width) : this.renderList(width);
  }

  handleInput(data: string): void {
    if (data === "x" || data === "q" || matchesKey(data, "escape")) {
      this.done();
      return;
    }
    if (this.mode === "detail") this.handleDetailInput(data);
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
  }

  private handleDetailInput(data: string): void {
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

  // ---- data ----------------------------------------------------------------
  private detailRow(): PanelTaskView | undefined {
    return this.rows.find((row) => row.task.id === this.detailId);
  }

  private async readTail(): Promise<void> {
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
    lines.push(theme.fg("dim", "↑/↓ select · Enter details · k stop · x close"));
    return lines;
  }

  private selectedIndex(): number {
    return this.rows.findIndex((row) => row.task.id === this.selectedId);
  }

  private listHeader(width: number): string {
    return [
      " ",
      ` ${pad("kind", 8)}`,
      ` ${pad("name", nameWidth(width))}`,
      ` ${pad("id", 10)}`,
      ` ${pad("status", 12)}`,
      ` ${padStart("elapsed", 9)}`,
      ` ${padStart("size", 10)}`,
    ].join("");
  }

  private listRow(row: PanelTaskView, selected: boolean, width: number): string {
    const theme = this.theme;
    const marker = selected ? theme.fg("accent", ">") : " ";
    const name = truncateToWidth(row.task.name, nameWidth(width), "…", false);
    return [
      marker,
      ` ${pad(row.task.kind, 8)}`,
      ` ${pad(name, nameWidth(width))}`,
      ` ${pad(row.task.id, 10)}`,
      ` ${theme.fg(STATUS_COLOUR[row.task.status], pad(row.task.status, 12))}`,
      ` ${padStart(formatDuration(row.elapsedMs), 9)}`,
      ` ${padStart(formatSize(row), 10)}`,
    ].join("");
  }

  private renderDetail(width: number): string[] {
    const theme = this.theme;
    const row = this.detailRow();
    if (row === undefined) return this.renderList(width);
    const task = row.task;
    const colour = STATUS_COLOUR[task.status];
    const lines: string[] = [
      `${theme.bold(task.name)} ${theme.fg("muted", `(${task.id})`)}`,
      "",
      this.field("status", theme.fg(colour, task.status)),
      this.field("kind", task.kind),
      this.field("elapsed", formatDuration(row.elapsedMs)),
      this.field("output", `${formatSize(row)} · ${task.outputPath}`),
    ];
    if (task.pid !== undefined) lines.push(this.field("pid", String(task.pid)));
    if (task.kind === "process") lines.push(this.field("command", task.command));
    if (task.cwd !== undefined) lines.push(this.field("cwd", task.cwd));
    if (task.exitCode !== undefined) {
      lines.push(this.field("exit code", theme.fg(colour, String(task.exitCode))));
    }
    if (task.killReason !== undefined) lines.push(this.field("kill reason", task.killReason));
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
const FIXED_COLUMNS = 2 + 9 + 11 + 13 + 10 + 11;

/** Space a task name may use: whatever the fixed columns leave, with a floor. */
function nameWidth(width: number): number {
  return Math.max(12, width - FIXED_COLUMNS);
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
