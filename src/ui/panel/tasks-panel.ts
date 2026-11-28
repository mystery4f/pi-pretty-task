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
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatBytes } from "../../tasks/base/format.js";
import {
  readSettings,
  type SettingKey,
  type SettingScope,
  type Settings,
  type SettingsFileLayer,
} from "../../tasks/base/settings.js";
import type { CmdLoopTask, FireRecord, PromptLoopTask, Task } from "../../tasks/base/task.js";
import type { Iteration } from "../../tasks/loop/iteration.js";
import type { PromptPreview } from "../../tasks/loop/prompt-file.js";
import { renderDetail, renderIterationDetail, windowRowsFor } from "./detail.js";
import { messageOf } from "./format.js";
import { handlePanelInput } from "./input.js";
import { renderList, stepRecord } from "./list.js";
import {
  DEFAULT_PANEL_FILTER,
  DEFAULT_RENDER_ROWS,
  DETAIL_TAIL_LINES,
  LIST_VISIBLE_ROWS,
  listWindow,
  PANEL_FILTERS,
  type PanelFilter,
  type PanelMode,
  type PanelSource,
  type PanelTab,
  type PanelTaskView,
  type PanelTerminal,
  panelHeightBudget,
  QUERY_MAX_LENGTH,
  type TasksPanelOptions,
} from "./model.js";
import { bestFieldMatch, type RowMatch } from "./query.js";
import { inTab, passesFilter } from "./row-filter.js";
import {
  formatSettingSavedNotice,
  initialDraftForSetting,
  isCycleSettingKey,
  nextCycledSettingPatch,
  parseDraftSettingPatch,
  renderSettingsView,
  visibleSettingKeys,
} from "./settings-view.js";
import type { PanelView } from "./view.js";

export * from "./format.js";
export * from "./keys.js";
export * from "./model.js";
export * from "./query.js";
export * from "./row-filter.js";
export * from "./settings-view.js";

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

/**
 * Best query match first; rows that match equally keep the recency order, so a
 * search never scrambles the work it ranks the same.
 */
function bestMatchFirst(
  scores: ReadonlyMap<PanelTaskView, RowMatch>,
): (left: PanelTaskView, right: PanelTaskView) => number {
  return (left, right) => {
    const byMatch = (scores.get(right)?.score ?? 0) - (scores.get(left)?.score ?? 0);
    return byMatch !== 0 ? byMatch : mostRecentlyChangedFirst(left, right);
  };
}

/** The newest fire a loop has recorded; a process has none, so its detail opens on the tail. */
function newestFire(task: Task | undefined): number | undefined {
  if (task?.kind === "prompt-loop") return task.iterations.at(-1)?.fire;
  if (task?.kind === "cmd-loop") return task.fireHistory.at(-1)?.fire;
  return undefined;
}

/** Whitespace-free lines of an output tail, newest last. */
function tailLines(text: string, count: number): string[] {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(Math.max(0, lines.length - count));
}

export class TasksPanel implements Component, PanelView {
  readonly tui: PanelTerminal;
  readonly theme: Theme;
  readonly done: () => void;
  readonly source: PanelSource;
  readonly now: () => number;
  readonly timer: ReturnType<typeof setInterval> | undefined;

  mode: PanelMode = "list";
  /** Width of the frame being drawn; field values are cut against it. */
  renderWidth = 80;
  /**
   * Rows the pane leaves the panel, measured on every render. A caller without a
   * terminal falls back to a tall default, so a test and a headless view keep
   * every field instead of drawing into a pane that may not exist.
   */
  renderHeight = DEFAULT_RENDER_ROWS;
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
  /**
   * The open loop's prompt file as last read, or undefined when nothing open has
   * one. Projection, not drawing: the page renders whatever sits here (ticket #48).
   */
  promptPreview: PromptPreview | undefined;
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
  settingsScope: SettingScope = "project";
  settingsIndex = 0;
  settingsEditing = false;
  settingsDraft = "";
  private cachedSettings: Settings | undefined;
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
    if (this.mode === "detail") {
      // A process refreshes the output it follows; a loop refreshes the prompt
      // file a fire may have rewritten. Both are reads of the outside world.
      if (this.following && this.detailRow()?.task.kind === "process") await this.readTail();
      if (this.detailRow()?.task.kind === "prompt-loop") await this.readPrompt();
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
    this.rows = shown.sort(
      this.query.length === 0 ? mostRecentlyChangedFirst : bestMatchFirst(this.matchScores),
    );
    this.keepSelection();
  }

  /**
   * Where the query lands on a row, or undefined when it misses. A chain row
   * displays its step names, so those are matchable words; nothing a row does not
   * display — a step's command, a fire's id — can bring a row back (ticket #27).
   */
  matchField(task: Task): RowMatch | undefined {
    // A chain row displays its step names, so those are matchable words; a step
    // with no name is not one.
    const steps: { name: string; index: number }[] = [];
    if (task.kind === "chain") {
      task.steps.forEach((id, index) => {
        const name = stepRecord(this, id)?.name ?? "";
        if (name !== "") steps.push({ name, index });
      });
    }
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
    const rows = listWindow(this.rows.length, this.renderHeight).rows;
    if (index >= this.listTop + rows) this.listTop = index - rows + 1;
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
    // A real terminal answers how tall the pane is; pi's overlay clamps the frame
    // to this budget and cuts from the top, so the pages plan against it.
    this.renderHeight =
      this.tui.terminal === undefined
        ? DEFAULT_RENDER_ROWS
        : panelHeightBudget(this.tui.terminal.rows);
    if (this.mode === "settings") return renderSettingsView(this, width);
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
  // ---- intents -------------------------------------------------------------
  // The keyboard says what the reader asked for, never which field moves. Every
  // change the panel allows is a method here, so `input.ts` writes no field and a
  // state no key can reach cannot be built by one.

  /** Say something in the notice line: the answer to a key that could not act. */
  notify(text: string | undefined): void {
    this.notice = text;
    this.paint();
  }

  /** `/` — the next keystrokes are a query, not a command. */
  beginSearch(): void {
    this.searching = true;
    this.paint();
  }

  /** `alt+q` in search — the query stays on screen, the keys go back to commands. */
  endSearch(): void {
    this.searching = false;
    this.paint();
  }

  /** Re-filter on a new query and paint; every record is already in hand. */
  enterQuery(query: string): void {
    this.query = query.slice(0, QUERY_MAX_LENGTH);
    this.applyFilters();
    this.paint();
  }

  /** Move the list cursor by `delta`, keeping the selected row on screen. */
  moveCursor(delta: number): void {
    if (this.rows.length === 0) return;
    const current = this.rows.findIndex((row) => row.task.id === this.selectedId);
    const base = current === -1 ? 0 : current;
    const next = Math.min(this.rows.length - 1, Math.max(0, base + delta));
    this.selectRow(this.rows[next]?.task.id);
    this.scrollListTo(next);
    this.paint();
  }

  /** Point the list at one row, without moving the window. */
  selectRow(id: string | undefined): void {
    this.selectedId = id;
  }

  /** Keep row `index` inside the list window. */
  private scrollListTo(index: number): void {
    if (index < this.listTop) this.listTop = index;
    const rows = listWindow(this.rows.length, this.renderHeight).rows;
    if (index >= this.listTop + rows) this.listTop = index - rows + 1;
  }

  /** Enter on the list: open the selected record, or say there is nothing to open. */
  openPage(): void {
    if (this.rows.length === 0) {
      this.notify(
        "No tasks to open yet — run a command with pretty_task_bg_run and it appears here.",
      );
      return;
    }
    this.detailId = this.selectedId;
    this.mode = "detail";
    this.following = true;
    this.scrollBack = 0;
    this.callTop = 0;
    const row = this.detailRow();
    // A loop opens on its newest history row; a process opens on its output tail.
    this.iterationFire = newestFire(row?.task);
    this.iterationTop = 0;
    this.enqueue(async () => {
      await this.readTail();
      await this.readPrompt();
      this.paint();
    });
  }

  /** Enter on a fire: the process record it left behind, at its own tail. */
  openProcessPage(taskId: string, fire: number): void {
    this.iterationFire = fire;
    this.detailId = taskId;
    this.mode = "detail";
    this.following = true;
    this.scrollBack = 0;
    this.enqueue(async () => {
      await this.readTail();
      await this.readPrompt();
      this.paint();
    });
  }

  /**
   * `←` from a fire: the record it was started by, without leaving the detail.
   * The fire's own page emptied the prompt block, so the way back reads it again
   * rather than leaving a hole until the next refresh tick.
   */
  showDetailOf(id: string | undefined): void {
    this.detailId = id;
    this.enqueue(async () => {
      await this.readTail();
      await this.readPrompt();
      this.paint();
    });
  }

  /** Enter on an iteration: the calls of one turn. */
  openIterationPage(fire: number): void {
    this.iterationFire = fire;
    this.callTop = 0;
    this.mode = "iteration";
    this.paint();
  }

  /** `←` out of a detail: back to the list the reader came from. */
  backToList(): void {
    this.mode = "list";
    this.paint();
  }

  /** `←` out of an iteration: back to the detail of the loop it belongs to. */
  backToLoopPage(): void {
    this.mode = "detail";
    this.callTop = 0;
    this.paint();
  }

  /** `←` out of a loop detail: the fire cursor has no meaning in the list. */
  clearFireCursor(): void {
    this.iterationTop = 0;
  }

  /** `←` out of an iteration detail: the next one opens at its own top. */
  clearCallCursor(): void {
    this.callTop = 0;
  }

  /** Walk the newest-first history, keeping the picked fire and its window. */
  showFire(fire: number, index: number): void {
    this.iterationFire = fire;
    if (index < this.iterationTop) this.iterationTop = index;
    const rows = windowRowsFor(this.renderHeight, LIST_VISIBLE_ROWS, 2);
    if (index >= this.iterationTop + rows) {
      this.iterationTop = index - rows + 1;
    }
    this.paint();
  }

  /** Two new lines come from the reader scrolling back through the output. */
  scrollTail(delta: number): void {
    const oldest = Math.max(0, this.detailLines.length - windowRowsFor(this.renderHeight));
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
    this.followTail();
  }

  /** `r`, or scrolling back to the newest line: read the tail again and follow it. */
  followTail(): void {
    this.following = true;
    this.scrollBack = 0;
    this.enqueue(async () => {
      await this.readTail();
      await this.readPrompt();
      this.paint();
    });
  }

  /** Move the call cursor inside one iteration, never past its oldest call. */
  scrollCalls(delta: number, calls: number): void {
    const oldest = Math.max(0, calls - windowRowsFor(this.renderHeight));
    const next = Math.min(oldest, Math.max(0, this.callTop + delta));
    if (next === this.callTop) return;
    this.callTop = next;
    this.paint();
  }

  /** A page key: take the whole keyboard to that page and drop the detail behind it. */
  selectPage(next: PanelTab): void {
    if (next === this.tab && this.mode === "list" && !this.searching) return;
    this.selectedByTab[this.tab] = this.selectedId;
    this.tab = next;
    this.remember(next);
    this.mode = "list";
    this.searching = false;
    this.detailId = undefined;
    this.detailLines = [];
    this.detailError = undefined;
    this.promptPreview = undefined;
    this.following = true;
    this.scrollBack = 0;
    this.selectedId = this.selectedByTab[next];
    this.listTop = 0;
    this.notice = undefined;
    this.applyFilters();
    this.paint();
  }

  /**
   * `f` walks all → running → failed → done → signal inside the open page, and
   * round again. The order lives in `PANEL_FILTERS`; this method reads it.
   */
  cycleFilter(): void {
    const index = PANEL_FILTERS.indexOf(this.filter);
    this.filter = PANEL_FILTERS[(index + 1) % PANEL_FILTERS.length] ?? "all";
    // Every record is already in hand, so the filter narrows the view without a read.
    this.applyFilters();
    this.notify(this.filter === "all" ? "showing every status" : `showing ${this.filter}`);
  }

  /** `o`: add or drop the rows another session started, read-only (ticket #27). */
  toggleOthers(): void {
    this.showOthers = !this.showOthers;
    if (!this.showOthers) {
      this.otherRows = [];
      this.notify("showing this session only");
    } else if (this.source.others === undefined) {
      this.notify("No other sessions can be seen from here.");
    } else {
      this.notify("showing other sessions read-only");
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
  /** Current four-layer settings snapshot, refreshing from the source when available. */
  currentSettings(): Settings {
    if (this.cachedSettings === undefined) {
      this.cachedSettings = this.source.settings?.() ?? readSettings({ env: {} });
    }
    return this.cachedSettings;
  }

  /** `s` on the list: open the four-layer settings view (ADR-0029). */
  openSettings(): void {
    this.cachedSettings = this.source.settings?.() ?? readSettings({ env: {} });
    this.mode = "settings";
    this.settingsEditing = false;
    this.settingsDraft = "";
    this.notice = undefined;
    this.paint();
  }

  /** `←` or `Esc` from the settings view: return to the task list. */
  closeSettings(): void {
    this.settingsEditing = false;
    this.settingsDraft = "";
    this.mode = "list";
    this.notice = undefined;
    this.paint();
  }

  /** `t` or `Tab` in the settings view: switch the target file between project and agent. */
  toggleSettingsScope(): void {
    this.settingsScope = this.settingsScope === "project" ? "agent" : "project";
    this.settingsEditing = false;
    this.settingsDraft = "";
    this.notice = undefined;
    this.paint();
  }

  /** `↑` / `↓` in the settings view: move across the platform's setting keys. */
  moveSettingsCursor(delta: number): void {
    const keys = visibleSettingKeys(this.currentSettings());
    if (keys.length === 0) return;
    this.settingsIndex = Math.min(keys.length - 1, Math.max(0, this.settingsIndex + delta));
    this.paint();
  }

  /** `Enter` in the settings view: cycle an enum/toggle key or open inline text edit. */
  activateSelectedSetting(): void {
    const settings = this.currentSettings();
    const keys = visibleSettingKeys(settings);
    const key = keys[this.settingsIndex];
    if (key === undefined) return;
    if (isCycleSettingKey(key)) {
      const patch = nextCycledSettingPatch(key, this.settingsScope, settings);
      this.applySettingPatch(key, patch, false);
      return;
    }
    this.settingsEditing = true;
    this.settingsDraft = initialDraftForSetting(key, this.settingsScope, settings);
    this.notice = undefined;
    this.paint();
  }

  /** Update the inline text draft while editing a numeric or path setting. */
  enterSettingsDraft(draft: string): void {
    this.settingsDraft = draft.slice(0, 256);
    this.paint();
  }

  /** `Esc` or `alt+q` while editing a setting value: discard the draft and stay in settings. */
  cancelSettingEdit(): void {
    this.settingsEditing = false;
    this.settingsDraft = "";
    this.paint();
  }

  /** `Enter` while editing a setting value: validate and write the draft to the active target file. */
  commitSettingEdit(): void {
    const settings = this.currentSettings();
    const keys = visibleSettingKeys(settings);
    const key = keys[this.settingsIndex];
    if (key === undefined) return;
    const cleared = this.settingsDraft.trim() === "";
    const patch = parseDraftSettingPatch(key, this.settingsDraft, this.settingsScope, settings);
    this.settingsEditing = false;
    this.settingsDraft = "";
    this.applySettingPatch(key, patch, cleared);
  }

  /** `d` in the settings view: remove the selected setting from the active target file. */
  clearSelectedSettingFromFile(): void {
    const settings = this.currentSettings();
    const keys = visibleSettingKeys(settings);
    const key = keys[this.settingsIndex];
    if (key === undefined) return;
    this.applySettingPatch(key, { [key]: undefined }, true);
  }

  private applySettingPatch(
    key: SettingKey,
    patch: Partial<Record<SettingKey, SettingsFileLayer[SettingKey] | undefined>>,
    cleared: boolean,
  ): void {
    const update = this.source.updateSettings;
    if (update === undefined) {
      this.notify("Settings are read-only in this view.");
      return;
    }
    const scope = this.settingsScope;
    this.enqueue(async () => {
      try {
        this.cachedSettings = await update(scope, patch);
        this.notice = formatSettingSavedNotice(key, scope, cleared, this.cachedSettings);
      } catch (error) {
        this.notice = messageOf(error);
      }
      this.paint();
    });
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

  /**
   * The open loop's prompt file, read through the loop's own layer: the panel
   * never joins a path or opens a file. A source that cannot read prompt files,
   * a chain, or a process leaves nothing here, and the page then says nothing
   * about a prompt rather than something wrong.
   */
  async readPrompt(): Promise<void> {
    const row = this.detailRow();
    const id = this.detailId;
    this.promptPreview = undefined;
    if (row?.task.kind !== "prompt-loop" || id === undefined) return;
    if (this.source.prompt === undefined) return;
    try {
      const preview = await this.source.prompt(id, row.sessionId);
      // The reader may have moved on while the file was being read.
      if (this.detailId !== id) return;
      this.promptPreview = preview;
    } catch {
      // The loop's own layer never throws; a source that does has nothing to show,
      // and the page draws no prompt block rather than a guessed one.
      this.promptPreview = undefined;
    }
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
