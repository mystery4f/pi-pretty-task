/**
 * The `/tasks` command: it opens the panel and, once the panel is gone, leaves
 * exactly one status-line summary in its place (#10, ADR 0003).
 *
 * This module is the seam between pi's command API and the panel: it builds the
 * session scope, binds the panel to the store, and never registers a widget.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  RUNTIME_STATE_DIRECTORY,
  sessionTaskDirectory,
  type TaskScope,
} from "../tasks/base/runtime-state.js";
import type { Task } from "../tasks/base/task.js";
import type { ChainTasks, ChainTaskView } from "../tasks/chain/chain-tasks.js";
import type { LoopTasks, LoopTaskView } from "../tasks/loop/loop-tasks.js";
import { readPromptPreview } from "../tasks/loop/prompt-file.js";
import type { ProcessTasks, ProcessTaskView } from "../tasks/process/process-tasks.js";
import { PANEL_HEIGHT_SHARE, PANEL_MARGIN, rowOf } from "./panel/model.js";
import {
  DETAIL_TAIL_LINES,
  type PanelSource,
  type PanelTaskView,
  TasksPanel,
} from "./panel/tasks-panel.js";

/**
 * The panel's door has two forms, and they are different kinds of thing:
 *
 * - `TASKS_SHORTCUT` is a **key**: pi binds it, the panel can be opened without
 *   typing, and it may appear in a key list (the status line, the README's keys, the
 *   animation's key trail).
 * - `TASKS_COMMAND` is **text**: it has to be typed after a slash, it is not a key,
 *   and it never belongs in a key list.
 *
 * Both open the same panel. The status line, the README and the animation's legend
 * quote `TASKS_HINT` instead of writing the door again — three copies of one string
 * is how a hint and a shortcut drift apart.
 */

/** Command name the user types, without the leading slash: the door's typing form. */
export const TASKS_COMMAND = "tasks";

/** The door's pressable form, in pi's keybinding syntax — what a shortcut is bound to. */
export const TASKS_SHORTCUT = "shift+down";

/** The pressable form as a person writes it. A key you press, never text you type. */
export const TASKS_SHORTCUT_LABEL = "Shift↓";

/** The typing form as a person writes it: a command, not a key. */
export const TASKS_COMMAND_LABEL = `/${TASKS_COMMAND}`;

/**
 * How the status line names the way back in. A terminal that never delivers the
 * shortcut still prints the command, so the hint is never the only door.
 */
export const TASKS_HINT = `${TASKS_COMMAND_LABEL} or ${TASKS_SHORTCUT_LABEL}`;

/** Widget slot this package owns; one line above the editor, replaced in place. */
export const SUMMARY_KEY = "pi-pretty-task";

/** Kept for the footer readers of the earlier build; the summary moved above the editor. */
export const STATUS_LINE_KEY = SUMMARY_KEY;

/**
 * The one line that stands in for the panel while it is closed: how many tasks
 * are running, how many have ended, and how to get the panel back. It lives just
 * above the editor — the footer row is shared with every other extension and the
 * count gets lost there.
 */
export function statusLineText(tasks: readonly Task[]): string {
  const running = tasks.filter((task) => task.status === "running").length;
  // A signal is counted beside the running count, not instead of it: the loop is
  // still live and its condition is still raised (ADR-0018).
  const signalled = tasks.filter(
    (task) => task.kind === "cmd-loop" && task.signalRaised === true,
  ).length;
  const finished = tasks.length - running;
  const parts: string[] = [];
  if (running > 0) parts.push(`${String(running)} running`);
  if (signalled > 0) parts.push(`${String(signalled)} signal`);
  if (finished > 0) parts.push(`${String(finished)} finished`);
  return `${parts.join(" · ")} · ${TASKS_HINT}`;
}

/**
 * Bind the panel to one session's stores. The panel asks for every record once and
 * decides for itself which ones get a row; it still only ever sees these four calls,
 * so it cannot signal a process, fire a loop or bypass the stores' rules.
 */
export function panelSourceFor(
  processes: ProcessTasks,
  loops: LoopTasks,
  chains: ChainTasks,
  scope: TaskScope,
  now: () => number = Date.now,
  foreground?: () => number,
  blocked?: () => number,
): PanelSource {
  // One projection builds every row; these three only say which field of their own
  // a view adds to it, so a new row field cannot reach one kind and miss another.
  const processRow = (view: ProcessTaskView, sessionId?: string): PanelTaskView =>
    rowOf(view.task, now(), { outputBytes: view.outputBytes, sessionId });
  const loopRow = (view: LoopTaskView, sessionId?: string): PanelTaskView =>
    rowOf(view.task, now(), { untilNextFireMs: view.untilNextFireMs, sessionId });
  const chainRow = (view: ChainTaskView, sessionId?: string): PanelTaskView =>
    rowOf(view.task, now(), { sessionId });

  return {
    sessionId: scope.sessionId,
    // A foreground run belongs to this session's runner, not to the store, so the
    // panel learns about it through this one call and nothing else (ADR-0020). A
    // blocked call is the store's own count, and the second waiting kind (ADR-0025).
    ...(foreground === undefined ? {} : { foreground }),
    ...(blocked === undefined ? {} : { blocked }),
    async list() {
      // Children are listed too: the header counts them even when no page shows them
      // as a row, and a chain's detail resolves its steps by id (ADR-0014).
      const [records, scheduled, queues] = await Promise.all([
        processes.listAll(scope),
        loops.list(scope),
        chains.list(scope),
      ]);
      return [
        ...records.map((view) => processRow(view)),
        ...scheduled.map((view) => loopRow(view)),
        ...queues.map((view) => chainRow(view)),
      ];
    },
    async others() {
      // Other sessions lose nothing by being seen: each keeps its own store under the
      // same runtime root, so the directories there name them. A session whose store
      // cannot be read drops out alone and never hides this session's own rows.
      const mine = sessionTaskDirectory(scope.cwd, scope.sessionId);
      const entries = await readdir(join(scope.cwd, RUNTIME_STATE_DIRECTORY), {
        withFileTypes: true,
      });
      const rows: PanelTaskView[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (sessionTaskDirectory(scope.cwd, entry.name) === mine) continue;
        try {
          const other: TaskScope = { cwd: scope.cwd, sessionId: entry.name };
          const [records, scheduled, queues] = await Promise.all([
            processes.listAll(other),
            loops.list(other),
            chains.list(other),
          ]);
          // The session is part of the row from the start, never a tag spread on
          // afterwards: a borrowed record is read-only, and its row says whose it is.
          rows.push(
            ...records.map((view) => processRow(view, entry.name)),
            ...scheduled.map((view) => loopRow(view, entry.name)),
            ...queues.map((view) => chainRow(view, entry.name)),
          );
        } catch {
          // One unreadable session is not a reason to hide the rest.
        }
      }
      return rows;
    },
    async prompt(id, sessionId) {
      // The prompt is a file the loop's own layer writes and reads, so the panel
      // asks that layer for its path, its first lines and its time (ticket #48).
      const owner = sessionId === undefined ? scope : { ...scope, sessionId };
      return readPromptPreview(sessionTaskDirectory(owner.cwd, owner.sessionId), id);
    },
    async tail(id, sessionId) {
      const logs = await processes.logs(
        sessionId === undefined ? scope : { ...scope, sessionId },
        id,
        { lines: DETAIL_TAIL_LINES },
      );
      return logs?.tail;
    },
    async stop(id) {
      // A loop is stopped by ending its schedule; a chain by stopping the step it is
      // on and telling every later step it never got its turn (ADR-0013, ADR-0014);
      // a process by killing its tree.
      const loop = await loops.get(scope, id);
      if (loop !== undefined) {
        const result = await loops.update({ ...scope, id, action: "complete" });
        if (result === undefined) return undefined;
        return { outcome: result.outcome, view: loopRow(result.view) };
      }
      const chain = await chains.get(scope, id);
      if (chain !== undefined) {
        const result = await chains.stop(scope, id);
        if (result === undefined) return undefined;
        // A survivor says why: the outcome alone would read like part of the kill
        // that failed, and the reader is owed the sentence the supervisor gave.
        const why = result.detail === undefined ? "" : ` · ${result.detail}`;
        const step =
          result.step === undefined
            ? {}
            : { detail: `step ${result.step.task.id} ${result.step.task.status}${why}` };
        return { outcome: result.outcome, view: chainRow(result.view), ...step };
      }
      return processes.stop(scope, id);
    },
    async rerun(id) {
      // Rerunning adds a row; it never rewrites the record the reader is looking at.
      const again = await processes.rerun(scope, id);
      return again === undefined
        ? undefined
        : rowOf(again.task, now(), { outputBytes: again.outputBytes });
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
  chains: ChainTasks,
  foreground?: () => number,
  blocked?: () => number,
): void {
  pi.registerCommand(TASKS_COMMAND, {
    description: "Open the task panel: background processes, loops and chains",
    handler: async (_args, ctx) => {
      await openPanel(ctx, processes, loops, chains, foreground, blocked);
    },
  });
  // The status line advertises this key, so it has to work: the panel is the only
  // way to a running task's output without a tool call.
  pi.registerShortcut(TASKS_SHORTCUT, {
    description: "Open the task panel",
    handler: async (ctx) => {
      await openPanel(ctx, processes, loops, chains, foreground, blocked);
    },
  });
}

/** What the panel needs from a command or shortcut context; both provide it. */
type PanelContext = Pick<
  ExtensionCommandContext,
  "cwd" | "hasUI" | "mode" | "sessionManager" | "ui"
>;

async function openPanel(
  ctx: PanelContext,
  processes: ProcessTasks,
  loops: LoopTasks,
  chains: ChainTasks,
  foreground?: () => number,
  blocked?: () => number,
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(
      "The task panel needs the interactive UI; use pretty_task_bg_status and pretty_task_bg_logs here.",
      "warning",
    );
    return;
  }
  const scope: TaskScope = { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
  const source = panelSourceFor(processes, loops, chains, scope, Date.now, foreground, blocked);

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new TasksPanel({ tui, theme, done: () => done(undefined), source }),
    {
      overlay: true,
      // Wide enough for the list columns, short enough to keep the transcript in
      // view. The share and the margin come from the panel, which budgets its own
      // body against them: two literals here would drift from the pages that plan
      // around them.
      overlayOptions: () => ({
        width: "90%",
        maxHeight: `${Math.round(PANEL_HEIGHT_SHARE * 100)}%`,
        margin: PANEL_MARGIN,
      }),
    },
  );

  await publishStatus(ctx.ui, processes, loops, chains, scope);
}

/**
 * Replace the one-line summary of both kinds. With no task there is nothing to
 * count, so the line is removed rather than left saying zero.
 */
export async function publishStatus(
  ui: ExtensionUIContext,
  processes: ProcessTasks,
  loops: LoopTasks,
  chains: ChainTasks,
  scope: TaskScope,
): Promise<void> {
  try {
    // Every record is counted, children included (ADR-0014): a fire that fails every
    // ten seconds has to show up in the line even though no page gives it a row.
    const [records, scheduled, queues] = await Promise.all([
      processes.listAll(scope),
      loops.list(scope),
      chains.list(scope),
    ]);
    const tasks = [
      ...records.map((view) => view.task),
      ...scheduled.map((view) => view.task),
      ...queues.map((view) => view.task),
    ];
    ui.setWidget(SUMMARY_KEY, tasks.length === 0 ? undefined : [statusLineText(tasks)]);
  } catch {
    // The count is a courtesy: a store that cannot list still gets the way back in.
    ui.setWidget(SUMMARY_KEY, [TASKS_HINT]);
  }
}
