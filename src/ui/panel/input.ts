/**
 * The panel's keyboard, one dispatch for every view.
 *
 * A key press arrives as one string and leaves as a call on the panel: this
 * module reads the key, moves a cursor, opens a page, or asks the store for a
 * stop — it paints nothing and formats nothing. The three views share one key
 * model (ADR-0012), so the mode dispatch lives in `handlePanelInput` and each
 * view keeps only the keys that make sense in it.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { CmdLoopTask, PromptLoopTask } from "../../tasks/base/task.js";
import { messageOf } from "./format.js";
import { pageKey } from "./keys.js";
import { foreign, selectedIndex } from "./list.js";
import {
  DETAIL_OUTPUT_LINES,
  LIST_VISIBLE_ROWS,
  PANEL_FILTERS,
  type PanelStopResult,
  type PanelTab,
  QUERY_MAX_LENGTH,
  READ_ONLY,
} from "./model.js";
import { pastedQuery, typedQuery } from "./query.js";
import type { TasksPanel } from "./tasks-panel.js";

export function handlePanelInput(panel: TasksPanel, data: string): void {
  if (matchesKey(data, "alt+q")) {
    // Leaving search keeps the query, which the header goes on showing; a second
    // press closes the panel, exactly as `x` does.
    if (panel.mode === "list" && panel.searching) {
      panel.searching = false;
      panel.paint();
      return;
    }
    panel.done();
    return;
  }
  // `1`, `2`, `3` and `tab` pick a page from any view, search mode included:
  // a page key is never a character a query wanted. All three pages share this
  // one keyboard model (ADR-0012), so the keys sit above the mode dispatch.
  if (!panel.searching) {
    const page = pageKey(data, panel.tab);
    if (page !== undefined) {
      selectTab(panel, page);
      return;
    }
  }
  // `x` closes from the list only: a detail view is left with alt+q (or ←), and a
  // character typed into a query is never a command.
  if (data === "x" && panel.mode === "list" && !panel.searching) {
    panel.done();
    return;
  }
  if (panel.mode === "iteration") handleIterationInput(panel, data);
  else if (panel.mode === "detail") handleDetailInput(panel, data);
  else if (panel.searching) handleSearchInput(panel, data);
  else handleListInput(panel, data);
}

export function handleListInput(panel: TasksPanel, data: string): void {
  if (data === "/") {
    panel.searching = true;
    panel.paint();
    return;
  }
  if (matchesKey(data, "up")) {
    moveSelection(panel, -1);
    return;
  }
  if (matchesKey(data, "down")) {
    moveSelection(panel, 1);
    return;
  }
  if (matchesKey(data, "pageUp")) {
    moveSelection(panel, -LIST_VISIBLE_ROWS);
    return;
  }
  if (matchesKey(data, "pageDown")) {
    moveSelection(panel, LIST_VISIBLE_ROWS);
    return;
  }
  if (matchesKey(data, "enter") || matchesKey(data, "right")) {
    openDetail(panel);
    return;
  }
  if (data === "k") stopSelected(panel);
  if (data === "a") stopAll(panel);
  if (data === "f") cycleFilter(panel);
  if (data === "o") toggleOthers(panel);
  if (data === "R") rerunSelected(panel);
  if (data === "c") showOutputPath(panel);
}

export function handleSearchInput(panel: TasksPanel, data: string): void {
  if (data === "\x7f" || data === "\b") {
    setQuery(panel, panel.query.slice(0, -1));
    return;
  }
  const pasted = pastedQuery(data);
  if (pasted !== undefined) {
    setQuery(panel, `${panel.query}${pasted}`);
    return;
  }
  const typed = typedQuery(data);
  if (typed !== undefined) setQuery(panel, `${panel.query}${typed}`);
}

/** Set the query, filter on it at once, and paint without going through the store. */
/** Set the query, filter on it at once, and paint without going through the store. */
export function setQuery(panel: TasksPanel, query: string): void {
  panel.query = query.slice(0, QUERY_MAX_LENGTH);
  panel.applyFilters();
  panel.paint();
}

export function handleDetailInput(panel: TasksPanel, data: string): void {
  const row = panel.detailRow();
  if (row?.task.kind === "prompt-loop") {
    handleLoopDetailInput(panel, data, row.task);
    return;
  }
  if (row?.task.kind === "cmd-loop") {
    handleCmdLoopDetailInput(panel, data, row.task);
    return;
  }
  handleProcessDetailInput(panel, data);
}

/** A process detail scrolls its output; a loop detail walks its iterations instead. */
/** A process detail scrolls its output; a loop detail walks its iterations instead. */
export function handleProcessDetailInput(panel: TasksPanel, data: string): void {
  if (matchesKey(data, "left")) {
    const task = panel.detailRow()?.task;
    if (task?.kind === "process" && task.parentId !== undefined) {
      // A fire opened from its loop: the left arrow goes back to that loop, so
      // the reader never loses the schedule behind the run (ADR-0014).
      panel.detailId = task.parentId;
      panel.paint();
      return;
    }
    panel.mode = "list";
    return;
  }
  if (matchesKey(data, "up")) {
    scrollDetail(panel, 1);
    return;
  }
  if (matchesKey(data, "down")) {
    scrollDetail(panel, -1);
    return;
  }
  if (matchesKey(data, "pageUp")) {
    scrollDetail(panel, DETAIL_OUTPUT_LINES);
    return;
  }
  if (matchesKey(data, "pageDown")) {
    scrollDetail(panel, -DETAIL_OUTPUT_LINES);
    return;
  }
  if (data === "r") {
    follow(panel);
    return;
  }
  if (data === "k") stopSelected(panel);
  if (data === "R") rerunSelected(panel);
  if (data === "c") showOutputPath(panel);
}

export function handleLoopDetailInput(panel: TasksPanel, data: string, task: PromptLoopTask): void {
  if (matchesKey(data, "left")) {
    panel.mode = "list";
    panel.iterationTop = 0;
    panel.callTop = 0;
    panel.paint();
    return;
  }
  if (matchesKey(data, "up")) {
    moveIteration(panel, -1, task);
    return;
  }
  if (matchesKey(data, "down")) {
    moveIteration(panel, 1, task);
    return;
  }
  if (matchesKey(data, "pageUp")) {
    moveIteration(panel, -LIST_VISIBLE_ROWS, task);
    return;
  }
  if (matchesKey(data, "pageDown")) {
    moveIteration(panel, LIST_VISIBLE_ROWS, task);
    return;
  }
  if (matchesKey(data, "enter") || matchesKey(data, "right")) {
    openIteration(panel);
    return;
  }
  if (data === "k") stopSelected(panel);
}

export function handleCmdLoopDetailInput(panel: TasksPanel, data: string, task: CmdLoopTask): void {
  if (matchesKey(data, "left")) {
    panel.mode = "list";
    panel.iterationTop = 0;
    panel.paint();
    return;
  }
  if (matchesKey(data, "up")) {
    moveFire(panel, -1, task);
    return;
  }
  if (matchesKey(data, "down")) {
    moveFire(panel, 1, task);
    return;
  }
  if (matchesKey(data, "pageUp")) {
    moveFire(panel, -LIST_VISIBLE_ROWS, task);
    return;
  }
  if (matchesKey(data, "pageDown")) {
    moveFire(panel, LIST_VISIBLE_ROWS, task);
    return;
  }
  if (matchesKey(data, "enter") || matchesKey(data, "right")) {
    openFire(panel);
    return;
  }
  // On the loop row `k` stops the schedule and cascades to its running fire.
  if (data === "k") stopSelected(panel);
}

/** Walk the newest-first fire list, keeping the selected row on screen. */
/** Walk the newest-first fire list, keeping the selected row on screen. */
export function moveFire(panel: TasksPanel, delta: number, task: CmdLoopTask): void {
  const newestFirst = [...task.fireHistory].reverse();
  if (newestFirst.length === 0) return;
  const selected = panel.currentFire(task);
  const current = newestFirst.findIndex((fire) => fire.fire === selected?.fire);
  const base = current === -1 ? 0 : current;
  const next = Math.min(newestFirst.length - 1, Math.max(0, base + delta));
  const chosen = newestFirst[next];
  if (chosen === undefined) return;
  panel.iterationFire = chosen.fire;
  if (next < panel.iterationTop) panel.iterationTop = next;
  if (next >= panel.iterationTop + LIST_VISIBLE_ROWS) {
    panel.iterationTop = next - LIST_VISIBLE_ROWS + 1;
  }
  panel.paint();
}

/** Enter on a fire: its process record, or a notice when it never ran. */
/** Enter on a fire: its process record, or a notice when it never ran. */
export function openFire(panel: TasksPanel): void {
  const row = panel.detailRow();
  if (row === undefined || row.task.kind !== "cmd-loop") return;
  const fire = panel.currentFire(row.task);
  if (fire === undefined) {
    panel.notice = "No fire to open yet — this loop has not fired.";
    panel.paint();
    return;
  }
  if (fire.taskId === undefined) {
    panel.notice =
      fire.outcome === "skipped"
        ? `fire #${String(fire.fire)} was skipped: the previous fire was still running.`
        : `fire #${String(fire.fire)} left no process record (${fire.outcome}).`;
    panel.paint();
    return;
  }
  panel.iterationFire = fire.fire;
  panel.detailId = fire.taskId;
  panel.mode = "detail";
  panel.following = true;
  panel.scrollBack = 0;
  panel.enqueue(async () => {
    await panel.readTail();
    panel.paint();
  });
}

/** The iteration view scrolls the turn's calls; the left arrow goes back to the loop. */
/** The iteration view scrolls the turn's calls; the left arrow goes back to the loop. */
export function handleIterationInput(panel: TasksPanel, data: string): void {
  if (matchesKey(data, "left")) {
    panel.mode = "detail";
    panel.callTop = 0;
    panel.paint();
    return;
  }
  if (matchesKey(data, "up")) {
    scrollCalls(panel, -1);
    return;
  }
  if (matchesKey(data, "down")) {
    scrollCalls(panel, 1);
    return;
  }
  if (matchesKey(data, "pageUp")) {
    scrollCalls(panel, -DETAIL_OUTPUT_LINES);
    return;
  }
  if (matchesKey(data, "pageDown")) {
    scrollCalls(panel, DETAIL_OUTPUT_LINES);
    return;
  }
  if (data === "k") stopSelected(panel);
}

/** Walk the newest-first iteration list, keeping the selected row on screen. */
/** Walk the newest-first iteration list, keeping the selected row on screen. */
export function moveIteration(panel: TasksPanel, delta: number, task: PromptLoopTask): void {
  const newestFirst = [...task.iterations].reverse();
  if (newestFirst.length === 0) return;
  const selected = panel.currentIteration(task);
  const current = newestFirst.findIndex((iteration) => iteration.fire === selected?.fire);
  const base = current === -1 ? 0 : current;
  const next = Math.min(newestFirst.length - 1, Math.max(0, base + delta));
  const chosen = newestFirst[next];
  if (chosen === undefined) return;
  panel.iterationFire = chosen.fire;
  if (next < panel.iterationTop) panel.iterationTop = next;
  if (next >= panel.iterationTop + LIST_VISIBLE_ROWS) {
    panel.iterationTop = next - LIST_VISIBLE_ROWS + 1;
  }
  panel.paint();
}

export function openIteration(panel: TasksPanel): void {
  const row = panel.detailRow();
  if (row === undefined || row.task.kind !== "prompt-loop") return;
  const iteration = panel.currentIteration(row.task);
  if (iteration === undefined) {
    panel.notice = "No iteration to open yet — this loop has not fired.";
    panel.paint();
    return;
  }
  panel.iterationFire = iteration.fire;
  panel.callTop = 0;
  panel.mode = "iteration";
  panel.paint();
}

export function scrollCalls(panel: TasksPanel, delta: number): void {
  const row = panel.detailRow();
  if (row === undefined || row.task.kind !== "prompt-loop") return;
  const iteration = panel.currentIteration(row.task);
  if (iteration === undefined) return;
  const oldest = Math.max(0, iteration.calls.length - DETAIL_OUTPUT_LINES);
  const next = Math.min(oldest, Math.max(0, panel.callTop + delta));
  if (next === panel.callTop) return;
  panel.callTop = next;
  panel.paint();
}

export function moveSelection(panel: TasksPanel, delta: number): void {
  if (panel.rows.length === 0) return;
  const current = panel.rows.findIndex((row) => row.task.id === panel.selectedId);
  const base = current === -1 ? 0 : current;
  const next = Math.min(panel.rows.length - 1, Math.max(0, base + delta));
  panel.selectedId = panel.rows[next]?.task.id;
  if (next < panel.listTop) panel.listTop = next;
  if (next >= panel.listTop + LIST_VISIBLE_ROWS) panel.listTop = next - LIST_VISIBLE_ROWS + 1;
  panel.paint();
}

export function openDetail(panel: TasksPanel): void {
  if (panel.rows.length === 0) {
    panel.notice =
      "No tasks to open yet — run a command with pretty_task_bg_run and it appears here.";
    panel.paint();
    return;
  }
  panel.detailId = panel.selectedId;
  panel.mode = "detail";
  panel.following = true;
  panel.scrollBack = 0;
  panel.callTop = 0;
  const row = panel.detailRow();
  // A loop opens on its newest history row; a process opens on its output tail.
  panel.iterationFire =
    row?.task.kind === "prompt-loop"
      ? row.task.iterations.at(-1)?.fire
      : row?.task.kind === "cmd-loop"
        ? row.task.fireHistory.at(-1)?.fire
        : undefined;
  panel.iterationTop = 0;
  panel.enqueue(async () => {
    await panel.readTail();
    panel.paint();
  });
}

/** Scroll up (`delta > 0`) or down from the newest line, freezing on the way up. */
/** Scroll up (`delta > 0`) or down from the newest line, freezing on the way up. */
export function scrollDetail(panel: TasksPanel, delta: number): void {
  const oldest = Math.max(0, panel.detailLines.length - DETAIL_OUTPUT_LINES);
  const next = Math.min(oldest, Math.max(0, panel.scrollBack + delta));
  if (next === panel.scrollBack) return;
  panel.scrollBack = next;
  if (next > 0) {
    // Scrolled up: the buffer is frozen so the reader's place stays put.
    panel.following = false;
    panel.paint();
    return;
  }
  // Back at the newest line: the tail moves again, freshly read.
  follow(panel);
}

export function follow(panel: TasksPanel): void {
  panel.following = true;
  panel.scrollBack = 0;
  panel.enqueue(async () => {
    await panel.readTail();
    panel.paint();
  });
}

export function stopSelected(panel: TasksPanel): void {
  // In a task detail `k` stops what is open: an expanded fire is its own record,
  // so stopping it must not end the schedule behind it (ADR-0015).
  const row = panel.mode === "detail" ? panel.detailRow() : panel.rows[selectedIndex(panel)];
  const id = row?.task.id;
  if (id === undefined) return;
  // Another session's task belongs to that session: this panel may read it, never
  // end it, so `k` says why and leaves the store alone (ticket #27).
  if (foreign(panel, row)) {
    panel.notice = READ_ONLY;
    panel.paint();
    return;
  }
  panel.enqueue(async () => {
    let result: PanelStopResult | undefined;
    try {
      result = await panel.source.stop(id);
    } catch (error) {
      panel.notice = `stop failed: ${messageOf(error)}`;
      panel.paint();
      return;
    }
    if (result === undefined) {
      panel.notice = `no such task: ${id}`;
    } else {
      const detail = result.detail === undefined ? "" : ` · ${result.detail}`;
      panel.notice = `stopped ${id} · ${result.outcome}${detail}`;
    }
    await panel.refresh();
    panel.paint();
  });
}

/** `a` stops every row the list shows, one store call at a time. */
/** `a` stops every row the list shows, one store call at a time. */
export function stopAll(panel: TasksPanel): void {
  // `o` can put another session's rows on the page, and `a` stops only the ones
  // this session owns: the rest are there to be read (ticket #27).
  const ids = panel.rows.filter((row) => !foreign(panel, row)).map((row) => row.task.id);
  if (ids.length === 0) {
    panel.notice = panel.rows.length === 0 ? "No tasks to stop." : READ_ONLY;
    panel.paint();
    return;
  }
  panel.enqueue(async () => {
    let stopped = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const result = await panel.source.stop(id);
        if (result === undefined) failed += 1;
        else stopped += 1;
      } catch {
        failed += 1;
      }
    }
    // A stop that finds nothing is not a failure the reader can act on, so the
    // notice names both counts and leaves the detail in the rows themselves.
    panel.notice =
      failed === 0
        ? `stopped ${String(stopped)} tasks`
        : `stopped ${String(stopped)} · ${String(failed)} could not be stopped`;
    await panel.refresh();
    panel.paint();
  });
}

export function selectTab(panel: TasksPanel, next: PanelTab): void {
  if (next === panel.tab && panel.mode === "list" && !panel.searching) return;
  panel.selectedByTab[panel.tab] = panel.selectedId;
  panel.tab = next;
  panel.remember(next);
  panel.mode = "list";
  panel.searching = false;
  panel.detailId = undefined;
  panel.detailLines = [];
  panel.detailError = undefined;
  panel.following = true;
  panel.scrollBack = 0;
  panel.selectedId = panel.selectedByTab[next];
  panel.listTop = 0;
  panel.notice = undefined;
  panel.applyFilters();
  panel.paint();
}

/** `f` walks all → running → failed → done inside the open page, and round again. */
/** `f` walks all → running → failed → done inside the open page, and round again. */
export function cycleFilter(panel: TasksPanel): void {
  const index = PANEL_FILTERS.indexOf(panel.filter);
  panel.filter = PANEL_FILTERS[(index + 1) % PANEL_FILTERS.length] ?? "all";
  panel.notice = panel.filter === "all" ? "showing every status" : `showing ${panel.filter}`;
  // Every record is already in hand, so the filter narrows the view without a read.
  panel.applyFilters();
  panel.paint();
}

export function toggleOthers(panel: TasksPanel): void {
  panel.showOthers = !panel.showOthers;
  if (!panel.showOthers) panel.otherRows = [];
  if (panel.showOthers && panel.source.others === undefined) {
    panel.notice = "No other sessions can be seen from here.";
  } else {
    panel.notice = panel.showOthers
      ? "showing other sessions read-only"
      : "showing this session only";
  }
  panel.applyFilters();
  panel.paint();
  if (panel.showOthers) {
    panel.enqueue(async () => {
      await panel.refresh();
      panel.paint();
    });
  }
}

/** `R` runs the selected command again; the old row stays as its own record. */
/** `R` runs the selected command again; the old row stays as its own record. */
export function rerunSelected(panel: TasksPanel): void {
  // The key belongs to the page in front of the reader: an open fire is a process
  // record of its own, so `R` repeats that fire, not the loop above it (ticket #35).
  const row = panel.mode === "detail" ? panel.detailRow() : panel.rows[selectedIndex(panel)];
  if (row === undefined) {
    panel.notice = "No task selected.";
    panel.paint();
    return;
  }
  // Another session started this command, so running it again is its decision, not
  // a reader's on a page that only borrowed the row (ticket #27).
  if (foreign(panel, row)) {
    panel.notice = READ_ONLY;
    panel.paint();
    return;
  }
  if (row.task.kind === "chain") {
    // A chain is a queue, and its steps are the commands: `R` has nothing to repeat
    // here, so the panel says so instead of starting something the reader did not ask
    // for. Starting the same pipeline again is a `pretty_task_bg_run` with the same `after`.
    panel.notice = "A chain is a queue; run its steps again with pretty_task_bg_run.";
    panel.paint();
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
    panel.notice =
      "A chain step runs inside its queue; run the chain again with pretty_task_bg_run.";
    panel.paint();
    return;
  }
  if (row.task.kind !== "process") {
    panel.notice = "A loop is scheduled, not run; create a new one instead.";
    panel.paint();
    return;
  }
  if (panel.source.rerun === undefined) {
    panel.notice = "This view cannot start tasks.";
    panel.paint();
    return;
  }
  const id = row.task.id;
  panel.enqueue(async () => {
    try {
      // Called through the source: the store, not the panel, starts the process.
      const again = await panel.source.rerun?.(id);
      panel.notice =
        again === undefined ? `no such task: ${id}` : `ran ${id} again as ${again.task.id}`;
      if (again !== undefined) panel.selectedId = again.task.id;
    } catch (error) {
      panel.notice = `rerun failed: ${messageOf(error)}`;
    }
    await panel.refresh();
    panel.paint();
  });
}

/** `c` puts the output path where it can be read, since the panel cannot copy it. */
/** `c` puts the output path where it can be read, since the panel cannot copy it. */
export function showOutputPath(panel: TasksPanel): void {
  // As with `R`: the path belongs to the page in front of the reader, so an open
  // fire names its own file and a loop detail names the loop's (ticket #35).
  const row = panel.mode === "detail" ? panel.detailRow() : panel.rows[selectedIndex(panel)];
  if (row === undefined) {
    panel.notice = "No task selected.";
    panel.paint();
    return;
  }
  const task = row.task;
  panel.notice =
    task.kind === "process"
      ? `output: ${task.outputPath}`
      : task.kind === "cmd-loop" && task.lastOutputPath !== undefined
        ? `output: ${task.lastOutputPath}`
        : task.kind === "chain"
          ? "a chain writes no output of its own; each step has its own file."
          : "a loop writes no output file";
  panel.paint();
}
