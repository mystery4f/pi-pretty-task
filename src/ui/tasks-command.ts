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
import type { LoopTasks, LoopTaskView } from "../tasks/loop/loop-tasks.js";
import type { ProcessTasks } from "../tasks/process/process-tasks.js";
import {
  DETAIL_TAIL_LINES,
  type PanelSource,
  type PanelTaskView,
  TasksPanel,
} from "./tasks-panel.js";

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
 * Bind the panel to one session's stores. Process tasks and loop tasks arrive as
 * one list; the panel still only ever sees these three calls, so it cannot signal
 * a process, fire a loop or bypass the stores' rules.
 */
export function panelSourceFor(
  processes: ProcessTasks,
  loops: LoopTasks,
  scope: TaskScope,
  now: () => number = Date.now,
): PanelSource {
  const loopRow = (view: LoopTaskView): PanelTaskView => ({
    task: view.task,
    elapsedMs: Math.max(0, (view.task.endedAt ?? now()) - view.task.createdAt),
    outputBytes: 0,
    ...(view.untilNextFireMs === undefined ? {} : { untilNextFireMs: view.untilNextFireMs }),
  });

  return {
    async list() {
      const [running, scheduled] = await Promise.all([processes.list(scope), loops.list(scope)]);
      return [...running, ...scheduled.map(loopRow)];
    },
    async tail(id) {
      const logs = await processes.logs(scope, id, { lines: DETAIL_TAIL_LINES });
      return logs?.tail;
    },
    async stop(id) {
      // A loop is stopped by ending its schedule; a process by killing its tree.
      const loop = await loops.get(scope, id);
      if (loop !== undefined) {
        const result = await loops.update(scope, id, "complete");
        if (result === undefined) return undefined;
        return { outcome: result.outcome, view: loopRow(result.view) };
      }
      return processes.stop(scope, id);
    },
  };
}

/**
 * Register `/tasks`. The panel is an overlay component, and the only lasting
 * trace of it is one status line — never a widget, never a footer.
 */
export function registerTasksCommand(
  pi: ExtensionAPI,
  processes: ProcessTasks,
  loops: LoopTasks,
): void {
  pi.registerCommand(TASKS_COMMAND, {
    description: "Open the task panel: background processes and scheduled loops",
    handler: async (_args, ctx) => {
      await openPanel(ctx, processes, loops);
    },
  });
}

async function openPanel(
  ctx: ExtensionCommandContext,
  processes: ProcessTasks,
  loops: LoopTasks,
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(
      "The task panel needs the interactive UI; use bg_status and bg_logs here.",
      "warning",
    );
    return;
  }
  const scope: TaskScope = { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
  const source = panelSourceFor(processes, loops, scope);

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new TasksPanel({ tui, theme, done: () => done(undefined), source }),
    {
      overlay: true,
      // Wide enough for the list columns, short enough to keep the transcript in view.
      overlayOptions: () => ({ width: "90%", maxHeight: "80%", margin: 1 }),
    },
  );

  await publishStatus(ctx.ui, processes, loops, scope);
}

/** Replace the status line with the panel's one-line summary of both kinds. */
export async function publishStatus(
  ui: ExtensionUIContext,
  processes: ProcessTasks,
  loops: LoopTasks,
  scope: TaskScope,
): Promise<void> {
  try {
    const [running, scheduled] = await Promise.all([processes.list(scope), loops.list(scope)]);
    const tasks = [...running.map((view) => view.task), ...scheduled.map((view) => view.task)];
    ui.setStatus(STATUS_LINE_KEY, statusLineText(tasks));
  } catch {
    // The count is a courtesy: a store that cannot list still gets the way back in.
    ui.setStatus(STATUS_LINE_KEY, `/${TASKS_COMMAND}`);
  }
}
