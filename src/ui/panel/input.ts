/**
 * The panel's keyboard, one dispatch for every view.
 *
 * A key press arrives as one string and leaves as a call on the panel: this
 * module reads the key and names the intent — move the cursor, open a page, ask
 * the store for a stop — and the panel decides what that intent does to its
 * state. It paints nothing and formats nothing. The three views share one key
 * model (ADR-0012), so the mode dispatch lives in `handlePanelInput` and each
 * view keeps only the keys that make sense in it.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */
import { matchesKey } from "@earendil-works/pi-tui";
import type { CmdLoopTask, PromptLoopTask } from "../../tasks/base/task.js";
import { detailRows, windowRowsFor } from "./detail.js";
import { messageOf } from "./format.js";
import { pageKey } from "./keys.js";
import { foreign, selectedIndex } from "./list.js";
import { LIST_VISIBLE_ROWS, listWindow, type PanelStopResult, READ_ONLY } from "./model.js";
import { pastedQuery, typedQuery } from "./query.js";
import type { TasksPanel } from "./tasks-panel.js";

/** One page of a detail's history: the rows its window draws, without the two
 *  lines that say what is scrolled out. */
function detailWindowRows(panel: TasksPanel): number {
  return Math.max(1, detailRows(panel.renderHeight, 2, LIST_VISIBLE_ROWS, 2).window - 2);
}

export function handlePanelInput(panel: TasksPanel, data: string): void {
  if (matchesKey(data, "alt+q")) {
    // Leaving search keeps the query, which the header goes on showing; a second
    // press closes the panel, exactly as `x` does.
    if (panel.mode === "list" && panel.searching) {
      panel.endSearch();
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
      panel.selectPage(page);
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

function handleListInput(panel: TasksPanel, data: string): void {
  if (data === "/") {
    panel.beginSearch();
    return;
  }
  if (matchesKey(data, "up")) {
    panel.moveCursor(-1);
    return;
  }
  if (matchesKey(data, "down")) {
    panel.moveCursor(1);
    return;
  }
  if (matchesKey(data, "pageUp")) {
    panel.moveCursor(-listWindow(panel.rows.length, panel.renderHeight).rows);
    return;
  }
  if (matchesKey(data, "pageDown")) {
    panel.moveCursor(listWindow(panel.rows.length, panel.renderHeight).rows);
    return;
  }
  if (matchesKey(data, "enter") || matchesKey(data, "right")) {
    panel.openPage();
    return;
  }
  if (data === "k") stopSelected(panel);
  if (data === "a") stopAll(panel);
  if (data === "f") panel.cycleFilter();
  if (data === "o") panel.toggleOthers();
  if (data === "R") rerunSelected(panel);
  if (data === "c") showOutputPath(panel);
}

function handleSearchInput(panel: TasksPanel, data: string): void {
  if (data === "\x7f" || data === "\b") {
    panel.enterQuery(panel.query.slice(0, -1));
    return;
  }
  const pasted = pastedQuery(data);
  if (pasted !== undefined) {
    panel.enterQuery(`${panel.query}${pasted}`);
    return;
  }
  const typed = typedQuery(data);
  if (typed !== undefined) panel.enterQuery(`${panel.query}${typed}`);
}

function handleDetailInput(panel: TasksPanel, data: string): void {
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
function handleProcessDetailInput(panel: TasksPanel, data: string): void {
  if (matchesKey(data, "left")) {
    const task = panel.detailRow()?.task;
    if (task?.kind === "process" && task.parentId !== undefined) {
      // A fire opened from its loop: the left arrow goes back to that loop, so
      // the reader never loses the schedule behind the run (ADR-0014).
      panel.showDetailOf(task.parentId);
      return;
    }
    panel.backToList();
    return;
  }
  if (matchesKey(data, "up")) {
    panel.scrollTail(1);
    return;
  }
  if (matchesKey(data, "down")) {
    panel.scrollTail(-1);
    return;
  }
  if (matchesKey(data, "pageUp")) {
    panel.scrollTail(windowRowsFor(panel.renderHeight));
    return;
  }
  if (matchesKey(data, "pageDown")) {
    panel.scrollTail(-windowRowsFor(panel.renderHeight));
    return;
  }
  if (data === "r") {
    panel.followTail();
    return;
  }
  if (data === "k") stopSelected(panel);
  if (data === "R") rerunSelected(panel);
  if (data === "c") showOutputPath(panel);
}

function handleLoopDetailInput(panel: TasksPanel, data: string, task: PromptLoopTask): void {
  if (matchesKey(data, "left")) {
    panel.clearFireCursor();
    panel.clearCallCursor();
    panel.backToList();
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
    moveIteration(panel, -detailWindowRows(panel), task);
    return;
  }
  if (matchesKey(data, "pageDown")) {
    moveIteration(panel, detailWindowRows(panel), task);
    return;
  }
  if (matchesKey(data, "enter") || matchesKey(data, "right")) {
    openIteration(panel);
    return;
  }
  if (data === "k") stopSelected(panel);
}

function handleCmdLoopDetailInput(panel: TasksPanel, data: string, task: CmdLoopTask): void {
  if (matchesKey(data, "left")) {
    panel.clearFireCursor();
    panel.backToList();
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
    moveFire(panel, -detailWindowRows(panel), task);
    return;
  }
  if (matchesKey(data, "pageDown")) {
    moveFire(panel, detailWindowRows(panel), task);
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
function moveFire(panel: TasksPanel, delta: number, task: CmdLoopTask): void {
  const newestFirst = [...task.fireHistory].reverse();
  if (newestFirst.length === 0) return;
  const selected = panel.currentFire(task);
  const current = newestFirst.findIndex((fire) => fire.fire === selected?.fire);
  const base = current === -1 ? 0 : current;
  const next = Math.min(newestFirst.length - 1, Math.max(0, base + delta));
  const chosen = newestFirst[next];
  if (chosen === undefined) return;
  panel.showFire(chosen.fire, next);
}

/** Enter on a fire: its process record, or a notice when it never ran. */
function openFire(panel: TasksPanel): void {
  const row = panel.detailRow();
  if (row === undefined || row.task.kind !== "cmd-loop") return;
  const fire = panel.currentFire(row.task);
  if (fire === undefined) {
    panel.notify("No fire to open yet — this loop has not fired.");
    return;
  }
  if (fire.taskId === undefined) {
    panel.notify(
      fire.outcome === "skipped"
        ? `fire #${String(fire.fire)} was skipped: the previous fire was still running.`
        : `fire #${String(fire.fire)} left no process record (${fire.outcome}).`,
    );
    return;
  }
  panel.openProcessPage(fire.taskId, fire.fire);
}

/** The iteration view scrolls the turn's calls; the left arrow goes back to the loop. */
function handleIterationInput(panel: TasksPanel, data: string): void {
  if (matchesKey(data, "left")) {
    panel.backToLoopPage();
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
    scrollCalls(panel, -detailWindowRows(panel));
    return;
  }
  if (matchesKey(data, "pageDown")) {
    scrollCalls(panel, detailWindowRows(panel));
    return;
  }
  if (data === "k") stopSelected(panel);
}

/** Walk the newest-first iteration list, keeping the selected row on screen. */
function moveIteration(panel: TasksPanel, delta: number, task: PromptLoopTask): void {
  const newestFirst = [...task.iterations].reverse();
  if (newestFirst.length === 0) return;
  const selected = panel.currentIteration(task);
  const current = newestFirst.findIndex((iteration) => iteration.fire === selected?.fire);
  const base = current === -1 ? 0 : current;
  const next = Math.min(newestFirst.length - 1, Math.max(0, base + delta));
  const chosen = newestFirst[next];
  if (chosen === undefined) return;
  panel.showFire(chosen.fire, next);
}

function openIteration(panel: TasksPanel): void {
  const row = panel.detailRow();
  if (row === undefined || row.task.kind !== "prompt-loop") return;
  const iteration = panel.currentIteration(row.task);
  if (iteration === undefined) {
    panel.notify("No iteration to open yet — this loop has not fired.");
    return;
  }
  panel.openIterationPage(iteration.fire);
}

function scrollCalls(panel: TasksPanel, delta: number): void {
  const row = panel.detailRow();
  if (row === undefined || row.task.kind !== "prompt-loop") return;
  const iteration = panel.currentIteration(row.task);
  if (iteration === undefined) return;
  panel.scrollCalls(delta, iteration.calls.length);
}

function stopSelected(panel: TasksPanel): void {
  // In a task detail `k` stops what is open: an expanded fire is its own record,
  // so stopping it must not end the schedule behind it (ADR-0015).
  const row = panel.mode === "detail" ? panel.detailRow() : panel.rows[selectedIndex(panel)];
  const id = row?.task.id;
  if (id === undefined) return;
  // Another session's task belongs to that session: this panel may read it, never
  // end it, so `k` says why and leaves the store alone (ticket #27).
  if (foreign(panel, row)) {
    panel.notify(READ_ONLY);
    return;
  }
  panel.enqueue(async () => {
    let result: PanelStopResult | undefined;
    try {
      result = await panel.source.stop(id);
    } catch (error) {
      panel.notify(`stop failed: ${messageOf(error)}`);
      return;
    }
    if (result === undefined) {
      panel.notify(`no such task: ${id}`);
    } else {
      const detail = result.detail === undefined ? "" : ` · ${result.detail}`;
      panel.notify(`stopped ${id} · ${result.outcome}${detail}`);
    }
    await panel.refresh();
    panel.paint();
  });
}

/** `a` stops every row the list shows, one store call at a time. */
function stopAll(panel: TasksPanel): void {
  // `o` can put another session's rows on the page, and `a` stops only the ones
  // this session owns: the rest are there to be read (ticket #27).
  const ids = panel.rows.filter((row) => !foreign(panel, row)).map((row) => row.task.id);
  if (ids.length === 0) {
    panel.notify(panel.rows.length === 0 ? "No tasks to stop." : READ_ONLY);
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
    panel.notify(
      failed === 0
        ? `stopped ${String(stopped)} tasks`
        : `stopped ${String(stopped)} · ${String(failed)} could not be stopped`,
    );
    await panel.refresh();
    panel.paint();
  });
}

/** `R` runs the selected command again; the old row stays as its own record. */
function rerunSelected(panel: TasksPanel): void {
  // The key belongs to the page in front of the reader: an open fire is a process
  // record of its own, so `R` repeats that fire, not the loop above it (ticket #35).
  const row = panel.mode === "detail" ? panel.detailRow() : panel.rows[selectedIndex(panel)];
  if (row === undefined) {
    panel.notify("No task selected.");
    return;
  }
  // Another session started this command, so running it again is its decision, not
  // a reader's on a page that only borrowed the row (ticket #27).
  if (foreign(panel, row)) {
    panel.notify(READ_ONLY);
    return;
  }
  if (row.task.kind === "chain") {
    // A chain is a queue, and its steps are the commands: `R` has nothing to repeat
    // here, so the panel says so instead of starting something the reader did not ask
    // for. Starting the same pipeline again is a `pretty_task_bg_run` with the same `after`.
    panel.notify("A chain is a queue; run its steps again with pretty_task_bg_run.");
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
    panel.notify(
      "A chain step runs inside its queue; run the chain again with pretty_task_bg_run.",
    );
    return;
  }
  if (row.task.kind !== "process") {
    panel.notify("A loop is scheduled, not run; create a new one instead.");
    return;
  }
  if (panel.source.rerun === undefined) {
    panel.notify("This view cannot start tasks.");
    return;
  }
  const id = row.task.id;
  panel.enqueue(async () => {
    try {
      // Called through the source: the store, not the panel, starts the process.
      const again = await panel.source.rerun?.(id);
      panel.notify(
        again === undefined ? `no such task: ${id}` : `ran ${id} again as ${again.task.id}`,
      );
      if (again !== undefined) panel.selectRow(again.task.id);
    } catch (error) {
      panel.notify(`rerun failed: ${messageOf(error)}`);
    }
    await panel.refresh();
    panel.paint();
  });
}

/** `c` puts the output path where it can be read, since the panel cannot copy it. */
function showOutputPath(panel: TasksPanel): void {
  // As with `R`: the path belongs to the page in front of the reader, so an open
  // fire names its own file and a loop detail names the loop's (ticket #35).
  const row = panel.mode === "detail" ? panel.detailRow() : panel.rows[selectedIndex(panel)];
  if (row === undefined) {
    panel.notify("No task selected.");
    return;
  }
  const task = row.task;
  panel.notify(
    task.kind === "process"
      ? `output: ${task.outputPath}`
      : task.kind === "cmd-loop" && task.lastOutputPath !== undefined
        ? `output: ${task.lastOutputPath}`
        : task.kind === "chain"
          ? "a chain writes no output of its own; each step has its own file."
          : "a loop writes no output file",
  );
}
