/**
 * Which rows a tab and a filter let through: the one place that decides
 * whether a record is on screen at all.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { Task } from "../../tasks/base/task.js";
import type { PanelFilter, PanelTab } from "./model.js";

/**
 * True when the task is a root row of the given page (ADR-0012). A chain's step and
 * a loop's fire are records with a `parentId`, and they belong to no page's list:
 * the parent's expansion is where they are read (ADR-0014). Processes are the only
 * kind that has children, so the other two kinds are roots by construction.
 */
export function inTab(task: Task, tab: PanelTab): boolean {
  switch (tab) {
    case "processes":
      return task.kind === "process" && task.parentId === undefined;
    case "loops":
      return task.kind === "prompt-loop" || task.kind === "cmd-loop";
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
export function passesFilter(task: Task, filter: PanelFilter): boolean {
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
