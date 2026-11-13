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
  completed: "success",
  failed: "error",
  killed: "warning",
  interrupted: "warning",
};
