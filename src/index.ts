/**
 * pi-pretty-task — background processes and scheduled agent wake-ups for pi.
 *
 * One session hub owns every Task record, whatever its kind. The process store
 * and the loop store share it, so a save from either kind keeps the other kind's
 * records. The extension's pump is the only clock: a timer and the turn
 * boundaries call it, and tests call it with a fake instant.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TaskSessions } from "./tasks/base/task-sessions.js";
import { type LoopFire, LoopTasks } from "./tasks/loop/loop-tasks.js";
import { loopTaskTools } from "./tasks/loop/tools.js";
import { parseOutputCapBytes } from "./tasks/process/limits.js";
import { ProcessTasks } from "./tasks/process/process-tasks.js";
import { processTaskTools } from "./tasks/process/tools.js";
import { LOOP_WAKE_CUSTOM_TYPE, renderLoopWake, sendLoopWake } from "./ui/loop-wake.js";
import {
  notifyTaskFinished,
  renderTaskFinished,
  TASK_FINISHED_CUSTOM_TYPE,
} from "./ui/notification.js";
import { registerTasksCommand } from "./ui/tasks-command.js";

export interface ExtensionOptions {
  /** Clock seam for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Pump period in milliseconds; `0` disables the timer so tests drive the pump. */
  readonly pumpIntervalMs?: number;
  /** Where the configuration is read from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/** The wired extension, returned so tests can drive its clock explicitly. */
export interface ExtensionController {
  readonly loops: LoopTasks;
  readonly processTasks: ProcessTasks;
  /** Handle every loop due at `at` in this extension's loaded sessions. */
  pump(at: number): Promise<LoopFire[]>;
}

const DEFAULT_PUMP_INTERVAL_MS = 1_000;

/** Build the stores, tools, renderers and pump; shared by production and tests. */
export function createExtension(
  pi: ExtensionAPI,
  options: ExtensionOptions = {},
): ExtensionController {
  // Configuration is read first, before anything is registered: a value that is
  // not usable has to fail the load with a message that names the key, because a
  // limit that silently becomes `NaN` would end every task on its first byte.
  const outputCapBytes = parseOutputCapBytes(options.env ?? process.env);
  const now = options.now ?? Date.now;
  const sessions = new TaskSessions({ now });
  const loops = new LoopTasks({
    sessions,
    now,
    onFire: (fire) => {
      sendLoopWake(pi, fire);
    },
  });
  const processTasks = new ProcessTasks({
    sessions,
    now,
    outputCapBytes,
    // The store does not await the announcement; a notice outlives the task.
    onFinish: (view) => {
      void notifyTaskFinished(pi, view);
    },
  });

  for (const tool of processTaskTools(processTasks)) pi.registerTool(tool);
  for (const tool of loopTaskTools(loops)) pi.registerTool(tool);
  pi.registerMessageRenderer(TASK_FINISHED_CUSTOM_TYPE, renderTaskFinished);
  pi.registerMessageRenderer(LOOP_WAKE_CUSTOM_TYPE, renderLoopWake);
  registerTasksCommand(pi, processTasks);

  const interval = options.pumpIntervalMs ?? DEFAULT_PUMP_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;

  // A timer failure must not become an unhandled rejection that kills pi.
  const pumpSafely = async (): Promise<void> => {
    try {
      await loops.pump(now());
    } catch (error) {
      process.stderr.write(`pi-pretty-task: loop pump failed: ${String(error)}\n`);
    }
  };

  const startTimer = (): void => {
    if (interval <= 0 || timer !== undefined) return;
    timer = setInterval(() => {
      void pumpSafely();
    }, interval);
  };
  const stopTimer = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  startTimer();

  pi.on("session_start", async (_event, ctx) => {
    await loops.attach({ cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
    startTimer();
  });
  // One pump on a turn boundary covers the case where the timer was delayed by
  // a long turn; a loop that became due during the turn wakes right after it.
  pi.on("turn_end", pumpSafely);
  pi.on("session_shutdown", stopTimer);

  return {
    loops,
    processTasks,
    pump: (at) => loops.pump(at),
  };
}

/** Extension entry: register this package's tools and commands on the running pi. */
export default function extension(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
  createExtension(pi, { env });
}
