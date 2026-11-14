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

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TaskScope } from "./tasks/base/runtime-state.js";
import { TaskSessions } from "./tasks/base/task-sessions.js";
import { Iterations } from "./tasks/loop/iterations.js";
import { type LoopFire, LoopTasks } from "./tasks/loop/loop-tasks.js";
import { loopTaskTools } from "./tasks/loop/tools.js";
import { LoopWakes } from "./tasks/loop/wake-queue.js";
import { parseOutputCapBytes } from "./tasks/process/limits.js";
import { ProcessTasks } from "./tasks/process/process-tasks.js";
import { resolveShellPolicy } from "./tasks/process/shell.js";
import { processTaskTools } from "./tasks/process/tools.js";
import { LOOP_WAKE_CUSTOM_TYPE, renderLoopWake, sendLoopWake } from "./ui/loop-wake.js";
import {
  notifyTaskFinished,
  renderTaskFinished,
  TASK_FINISHED_CUSTOM_TYPE,
} from "./ui/notification.js";
import { publishStatus, registerTasksCommand } from "./ui/tasks-command.js";

export interface ExtensionOptions {
  /** Clock seam for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Pump period in milliseconds; `0` disables the timer so tests drive the pump. */
  readonly pumpIntervalMs?: number;
  /** Where the configuration is read from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Tool calls one Iteration keeps; defaults to ITERATION_CALL_LIMIT. Lowering it
   * is how a test sees a truncated record without a hundred calls.
   */
  readonly iterationCallLimit?: number;
  /** Iterations one Loop keeps; defaults to ITERATION_HISTORY_LIMIT. */
  readonly iterationHistoryLimit?: number;
}

/** The wired extension, returned so tests can drive its clock explicitly. */
export interface ExtensionController {
  readonly loops: LoopTasks;
  readonly processTasks: ProcessTasks;
  /** The wakes a fire produced that pi has not been given yet (ADR-0009). */
  readonly wakes: LoopWakes;
  /** Handle every loop due at `at` in this extension's loaded sessions. */
  pump(at: number): Promise<LoopFire[]>;
  /**
   * Hand the queued wakes to pi if the agent is idle. The pump enqueues, and
   * `agent_settled`, `session_start` and this call flush; a busy agent keeps
   * its wakes queued until it settles (ADR-0009).
   */
  flushWakes(): Promise<void>;
}

const DEFAULT_PUMP_INTERVAL_MS = 1_000;

/** Recording is bookkeeping: a failure belongs on stderr, never in the session. */
async function recordSafely(work: Promise<void>): Promise<void> {
  try {
    await work;
  } catch (error) {
    process.stderr.write(`pi-pretty-task: iteration record failed: ${String(error)}\n`);
  }
}

/** The session a pi event belongs to, in the shape the stores take. */
function scopeOf(ctx: {
  readonly cwd: string;
  readonly sessionManager: { getSessionId(): string };
}): TaskScope {
  return { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
}

/** Build the stores, tools, renderers and pump; shared by production and tests. */
export function createExtension(
  pi: ExtensionAPI,
  options: ExtensionOptions = {},
): ExtensionController {
  // Configuration is read first, before anything is registered: a value that is
  // not usable has to fail the load with a message that names the key, because a
  // limit that silently becomes `NaN` would end every task on its first byte.
  const env = options.env ?? process.env;
  const outputCapBytes = parseOutputCapBytes(env);
  // The shell is settled here for the same reason: a selector that names a shell
  // this platform does not have must fail the load, not the first `bg_run`.
  const shellPolicy = resolveShellPolicy({ env });
  const now = options.now ?? Date.now;
  const sessions = new TaskSessions({ now });
  const iterations = new Iterations({
    sessions,
    now,
    callLimit: options.iterationCallLimit,
    historyLimit: options.iterationHistoryLimit,
  });
  // Wakes wait here until the agent is idle: pi's own follow-up queue cannot be
  // recalled, so sending one mid-turn would survive a `loop_update` (ADR-0009).
  const wakes = new LoopWakes();
  let agentIdle = true;
  const loops = new LoopTasks({
    sessions,
    now,
    onFire: async (fire) => {
      // The iteration opens pending, before the wake can be delivered, so even a
      // turn that ends before its first tool call leaves a record; it binds to
      // the wake's own turn in `flushWakes`. Awaited: the fire is on disk before
      // the wake can be sent or the loop cancelled.
      await recordSafely(iterations.open(fire));
      wakes.record(fire);
      // A fire changes a loop's countdown, and its status line entry.
      publishStatusLine();
    },
    onCancel: async (taskId) => {
      // The loop stopped while its wake waited: the wake must never reach pi, and
      // the pending iteration must not claim a turn that will not happen.
      for (const fire of wakes.cancel(taskId)) await recordSafely(iterations.drop(fire));
      publishStatusLine();
    },
  });
  const processTasks = new ProcessTasks({
    sessions,
    now,
    outputCapBytes,
    shellPolicy,
    // The store does not await the announcement; a notice outlives the task.
    onFinish: (view) => {
      void notifyTaskFinished(pi, view);
      // A finished task changes the count, so the line is refreshed with it.
      publishStatusLine();
    },
  });

  for (const tool of processTaskTools(processTasks)) pi.registerTool(tool);
  for (const tool of loopTaskTools(loops)) pi.registerTool(tool);
  pi.registerMessageRenderer(TASK_FINISHED_CUSTOM_TYPE, renderTaskFinished);
  pi.registerMessageRenderer(LOOP_WAKE_CUSTOM_TYPE, renderLoopWake);
  registerTasksCommand(pi, processTasks, loops);

  // The status line is the panel's lasting trace (ADR-0003): it has to exist
  // before anyone opens `/tasks`, and it has to follow the tasks it counts.
  let statusUi: ExtensionUIContext | undefined;
  let statusScope: TaskScope | undefined;
  const publishStatusLine = (): void => {
    const ui = statusUi;
    const scope = statusScope;
    if (ui === undefined || scope === undefined) return;
    void publishStatus(ui, processTasks, loops, scope);
  };
  const interval = options.pumpIntervalMs ?? DEFAULT_PUMP_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;

  /**
   * A queued wake still belongs to the model while its loop runs; a fire that
   * used the last of `maxFires` completed the loop and must still be delivered,
   * because that turn is the reason the count reached the limit. Every other
   * stopped loop drops its wake: pause, complete, expiry, delete.
   */
  const isDeliverable = (fire: LoopFire): boolean => {
    const task = fire.session.tasks.get(fire.task.id);
    if (task?.kind !== "loop") return false;
    return task.status === "running" || fire.final;
  };

  /**
   * Deliver what an idle agent may receive, drop what may not. A wake goes out
   * only after its iteration binds, so the turn it wakes records its own calls;
   * a dropped wake takes its pending iteration with it (ADR-0009).
   */
  const flushWakes = async (): Promise<void> => {
    if (!agentIdle) return;
    const { deliver, drop } = wakes.drain(isDeliverable);
    for (const fire of drop) await recordSafely(iterations.drop(fire));
    for (const fire of deliver) {
      iterations.bind(fire);
      sendLoopWake(pi, fire);
    }
    if (deliver.length > 0 || drop.length > 0) publishStatusLine();
  };

  // A timer failure must not become an unhandled rejection that kills pi.
  const pumpSafely = async (): Promise<void> => {
    try {
      await loops.pump(now());
      await flushWakes();
      // The countdown is part of the line, so every tick repaints it.
      publishStatusLine();
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
    const scope = { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
    await loops.attach(scope);
    statusUi = ctx.ui;
    statusScope = scope;
    // The line exists before the panel is ever opened; `/tasks` only refreshes it,
    // so the first paint is awaited rather than left to race the session start.
    await publishStatus(ctx.ui, processTasks, loops, scope);
    startTimer();
    // A fresh session has no run in flight, so a wake left queued by the last one
    // may go out now.
    agentIdle = true;
    await flushWakes();
  });
  // A turn is running: a fire recorded now waits for `agent_settled`, because pi
  // queues a `followUp` and cannot take it back (ADR-0009).
  pi.on("agent_start", () => {
    agentIdle = false;
  });
  // One pump on a turn boundary covers the case where the timer was delayed by
  // a long turn; a loop that became due during the turn wakes right after it.
  pi.on("turn_end", pumpSafely);
  // The tool events are the only description of the turn a fire woke. Starts are
  // recorded into the newest open iteration of the session, ends are paired by
  // tool call id — parallel calls start in source order and finish in completion
  // order, so position can never be the pairing key (ADR-0002).
  pi.on("tool_execution_start", async (event, ctx) => {
    await recordSafely(iterations.recordStart(scopeOf(ctx), event));
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    await recordSafely(iterations.recordEnd(scopeOf(ctx), event));
  });
  // `agent_settled` is the end of the turn: no retry, compaction or queued
  // continuation will run after it, so the iteration can close. The settle runs
  // first, then the wakes this turn was blocking go out — a wake never shares a
  // settle with the turn before it, and its own events open the next run.
  pi.on("agent_settled", async (event, ctx) => {
    await recordSafely(iterations.settle(scopeOf(ctx), event.aborted));
    agentIdle = true;
    await flushWakes();
  });
  pi.on("session_shutdown", () => {
    stopTimer();
    statusUi = undefined;
    statusScope = undefined;
  });

  return {
    loops,
    processTasks,
    wakes,
    // A pump that lands while the agent is idle delivers in the same call, so a
    // test or an idle timer sees the wake; while busy it only queues.
    pump: async (at) => {
      const fires = await loops.pump(at);
      await flushWakes();
      return fires;
    },
    flushWakes,
  };
}

/** Extension entry: register this package's tools and commands on the running pi. */
export default function extension(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
  createExtension(pi, { env });
}
