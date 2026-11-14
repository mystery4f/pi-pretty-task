/**
 * The one colour table for task endings. A finished task reads the same in the
 * completion notice, the panel list and the status line; keeping the table here
 * means a new status cannot be coloured differently in one of them.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { TaskStatus } from "../tasks/base/task.js";

/** Theme foreground token per ending, so the palette stays the user's theme. */
export const STATUS_COLOUR: Record<TaskStatus, ThemeColor> = {
  running: "accent",
  /** A paused loop task is neither running nor finished. */
  paused: "muted",
  /** Queued behind another step: work that has not started, like a paused task. */
  waiting: "muted",
  completed: "success",
  failed: "error",
  killed: "warning",
  interrupted: "warning",
  /** A step that never ran because the one ahead of it failed. */
  skipped: "muted",
  /** A step the user's stop settled before it could run. */
  stopped: "warning",
};
