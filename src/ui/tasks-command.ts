/**
 * The `/tasks` command: it opens the panel and, once the panel is gone, leaves
 * exactly one status-line summary in its place (#10, ADR 0003).
 *
 * This module is the seam between pi's command API and the panel: it builds the
 * session scope, binds the panel to the store, and never registers a widget.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { TaskScope } from "../tasks/base/runtime-state.js";
import type { Task } from "../tasks/base/task.js";
import type { ProcessTasks } from "../tasks/process/process-tasks.js";
import { DETAIL_TAIL_LINES, type PanelSource, TasksPanel } from "./tasks-panel.js";

/** Command name the user types, without the leading slash. */
export const TASKS_COMMAND = "tasks";

/** Status-line slot this package owns; one line, replaced in place. */
export const STATUS_LINE_KEY = "pi-pretty-task";

/**
 * The one line that stands in for the panel while it is closed: how many tasks
 * are running, how many have ended, and how to get the panel back.
 */
export function statusLineText(tasks: readonly Task[]): string {
  const running = tasks.filter((task) => task.status === "running").length;
  const finished = tasks.length - running;
  const parts: string[] = [];
  if (running > 0) parts.push(`${String(running)} running`);
  if (finished > 0) parts.push(`${String(finished)} finished`);
  if (parts.length === 0) parts.push("no tasks");
  return `${parts.join(" · ")} · /${TASKS_COMMAND}`;
}

/**
 * Bind the panel to one session's store. The panel only ever sees these three
 * calls, so it cannot signal a process or bypass the store's rules.
 */
export function panelSourceFor(tasks: ProcessTasks, scope: TaskScope): PanelSource {
  return {
    list: () => tasks.list(scope),
    async tail(id) {
      const logs = await tasks.logs(scope, id, { lines: DETAIL_TAIL_LINES });
      return logs?.tail;
    },
    stop: (id) => tasks.stop(scope, id),
  };
}

/**
 * Register `/tasks`. The panel is an overlay component, and the only lasting
 * trace of it is one status line — never a widget, never a footer.
 */
export function registerTasksCommand(pi: ExtensionAPI, tasks: ProcessTasks): void {
  pi.registerCommand(TASKS_COMMAND, {
    description: "Open the task panel: running and finished background tasks",
    handler: async (_args, ctx) => {
      await openPanel(ctx, tasks);
    },
  });
}

async function openPanel(ctx: ExtensionCommandContext, tasks: ProcessTasks): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(
      "The task panel needs the interactive UI; use bg_status and bg_logs here.",
      "warning",
    );
    return;
  }
  const scope: TaskScope = { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
  const source = panelSourceFor(tasks, scope);

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new TasksPanel({ tui, theme, done: () => done(undefined), source }),
    {
      overlay: true,
      // Wide enough for the list columns, short enough to keep the transcript in view.
      overlayOptions: () => ({ width: "90%", maxHeight: "80%", margin: 1 }),
    },
  );

  await publishStatus(ctx.ui, tasks, scope);
}

/** Replace the status line with the panel's one-line summary. */
async function publishStatus(
  ui: ExtensionUIContext,
  tasks: ProcessTasks,
  scope: TaskScope,
): Promise<void> {
  try {
    const views = await tasks.list(scope);
    ui.setStatus(STATUS_LINE_KEY, statusLineText(views.map((view) => view.task)));
  } catch {
    // The count is a courtesy: a store that cannot list still gets the way back in.
    ui.setStatus(STATUS_LINE_KEY, `/${TASKS_COMMAND}`);
  }
}
