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
import { publishLoopFired, publishTaskFinished } from "./tasks/base/events.js";
import { pruneSessions } from "./tasks/base/retention.js";
import type { TaskScope } from "./tasks/base/runtime-state.js";
import { readSettings } from "./tasks/base/settings.js";
import { TaskSessions } from "./tasks/base/task-sessions.js";
import { ChainTasks } from "./tasks/chain/chain-tasks.js";
import { Iterations } from "./tasks/loop/iterations.js";
import { type LoopFire, LoopTasks } from "./tasks/loop/loop-tasks.js";
import { loopTaskTools } from "./tasks/loop/tools.js";
import { LoopWakes } from "./tasks/loop/wake-queue.js";
import { ProcessTasks, type ProcessTaskView } from "./tasks/process/process-tasks.js";
import { loadTemplates } from "./tasks/process/templates.js";
import { processTaskTools } from "./tasks/process/tools.js";
import { LOOP_WAKE_CUSTOM_TYPE, renderLoopWake, sendLoopWake } from "./ui/loop-wake.js";
import {
  notifyTaskFinished,
  renderTaskFinished,
  TASK_FINISHED_CUSTOM_TYPE,
} from "./ui/notification.js";
import { publishStatus, registerTasksCommand } from "./ui/tasks-command.js";
import { createTerminalNotifications } from "./ui/terminal-notification.js";

export interface ExtensionOptions {
  /** Clock seam for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Pump period in milliseconds; `0` disables the timer so tests drive the pump. */
  readonly pumpIntervalMs?: number;
  /** The environment the configuration is read from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Tool calls one Iteration keeps; defaults to ITERATION_CALL_LIMIT. Lowering it
   * is how a test sees a truncated record without a hundred calls.
   */
  readonly iterationCallLimit?: number;
  /** Iterations one Loop keeps; defaults to ITERATION_HISTORY_LIMIT. */
  readonly iterationHistoryLimit?: number;
  /** Project root holding `.pi/pretty-task.json`; defaults to `process.cwd()`. */
  readonly projectDir?: string;
  /** Agent settings directory; defaults to `PI_CODING_AGENT_DIR`, then pi's own default. */
  readonly agentDir?: string;
  /**
   * Where the terminal notification bytes go; defaults to stdout, and then only
   * when stdout is a terminal. A test captures the bytes instead of a terminal.
   */
  readonly writeTerminal?: (text: string) => void;
  /**
   * Receives a configuration problem as one line, without the `pi-pretty-task:`
   * prefix. Defaults to stderr: a bad template file must be loud at load and
   * still leave the extension running.
   */
  readonly reportProblem?: (message: string) => void;
}

/** The wired extension, returned so tests can drive its clock explicitly. */
export interface ExtensionController {
  readonly loops: LoopTasks;
  readonly processTasks: ProcessTasks;
  /** The queues that run process tasks one at a time (ADR-0013). */
  readonly chainTasks: ChainTasks;
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
  const settings = readSettings({
    env: options.env,
    projectDir: options.projectDir,
    agentDir: options.agentDir,
  });
  // Templates are configuration too, but a bad file only costs that file's
  // names: say what is wrong, keep the extension loaded, and let the other file
  // still supply templates.
  const templates = loadTemplates(settings.templatePaths);
  const reportProblem =
    options.reportProblem ??
    ((message: string) => {
      process.stderr.write(`pi-pretty-task: ${message}\n`);
    });
  for (const problem of templates.problems) reportProblem(problem);
  const now = options.now ?? Date.now;
  // Retention is housekeeping, not a task: a sweep that cannot judge or remove
  // one session keeps it, says why, and leaves the session start to finish.
  const pruneOldSessions = async (scope: TaskScope): Promise<void> => {
    try {
      await pruneSessions({
        scope,
        retentionDays: settings.retentionDays,
        now,
        report: reportProblem,
      });
    } catch (error) {
      reportProblem(
        `retention sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
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
      // Published once the iteration is on disk, so a listener that loads the
      // loop finds the fire it was told about (issue #23).
      publishLoopFired(pi.events, {
        kind: "llm-loop",
        id: fire.task.id,
        name: fire.task.name,
        fire: fire.fire,
        at: fire.at,
        iteration: { fire: fire.fire, startedAt: fire.at },
      });
      wakes.record(fire);
      // A fire changes a loop's countdown, and its status line entry.
      publishStatusLine();
    },
    onCommandFire: async (fire) => {
      // A fire is an ordinary process task carrying its loop id and fire number
      // (ADR-0014), started by the same path `bg_run` uses — never a second spawn.
      const child = await processTasks.start({
        cwd: fire.scope.cwd,
        sessionId: fire.scope.sessionId,
        command: fire.task.command,
        // The human alias of ADR-0016 is rendered here; the fire's id stays opaque.
        name: `${fire.task.name} #${String(fire.fire)}`,
        ...(fire.task.cwd === undefined ? {} : { workingDirectory: fire.task.cwd }),
        ...(fire.task.env === undefined ? {} : { env: fire.task.env }),
        parentId: fire.task.id,
        fire: fire.fire,
      });
      // The child record is on disk — `start` persisted it — so the fire is
      // announced with the task a listener can load (issue #23).
      publishLoopFired(pi.events, {
        kind: "cmd-loop",
        id: fire.task.id,
        name: fire.task.name,
        fire: fire.fire,
        at: fire.at,
        taskId: child.id,
      });
      publishStatusLine();
      return { taskId: child.id };
    },
    onCancel: async (taskId) => {
      // The loop stopped while its wake waited: the wake must never reach pi, and
      // the pending iteration must not claim a turn that will not happen.
      for (const fire of wakes.cancel(taskId)) await recordSafely(iterations.drop(fire));
      // A command loop that stops must not leave a fire running: its process is
      // killed through the same polite-then-force path as `bg_kill` (ADR-0014).
      await processTasks.stopChildren(taskId, { reason: "user" });
      publishStatusLine();
    },
  });
  // Where a task's ending reaches the terminal (issue #15). The gate is a UI this
  // session actually has: a headless run writes nothing, and a session that has
  // shut down must not write into a terminal it no longer owns.
  let uiAttached = false;
  const terminal = createTerminalNotifications({
    enabled: settings.notify,
    attached: () => uiAttached,
    write: options.writeTerminal,
  });
  const processTasks = new ProcessTasks({
    sessions,
    now,
    outputCapBytes: settings.outputCapBytes,
    shellPolicy: settings.shellPolicy,
    // The store does not await the announcement; a notice outlives the task.
    onFinish: (view) => {
      // Published first, and only here: the store awaited the write before
      // calling this, so a listener reading the record finds the ending (issue
      // #23). A fire's child task is a task too, and ends the same way.
      publishTaskFinished(pi.events, view);
      if (view.task.parentId === undefined) {
        void notifyTaskFinished(pi, view);
      } else if (view.task.fire === undefined) {
        // A chain's step ended: the queue reads the step's own record and starts the
        // next one, or fails the chain and skips what was left (ADR-0013). The step
        // itself stays silent; the chain speaks for it when the queue ends.
        void chainTasks.advance(view).catch((error: unknown) => {
          process.stderr.write(`pi-pretty-task: chain advance failed: ${String(error)}\n`);
        });
      } else {
        // A fire ended: its outcome lands on the owning loop, and only a failed
        // fire may speak (ADR-0014) — a healthy fire adds nothing to the transcript.
        void finishFire(view).catch((error: unknown) => {
          process.stderr.write(`pi-pretty-task: fire record failed: ${String(error)}\n`);
        });
      }
      // The terminal is told about every ending, fire or not: it is not a transcript.
      terminal.finished(view.task.name, view.task.status);
      // A finished task changes the count, so the line is refreshed with it.
      publishStatusLine();
    },
  });

  /**
   * The queues that run process tasks in order (ADR-0013). A step is an ordinary
   * task, so the process store reports every step end here; the chain reads the
   * step's own record — never a copy — and starts the next one.
   */
  const chainTasks = new ChainTasks({
    sessions,
    now,
    processes: () => processTasks,
    onFinish: (view) => {
      // A chain's ending is coarser than its steps': the steps already had theirs,
      // and the queue adds one line when the whole run is over.
      terminal.finished(view.task.name, view.task.status);
      publishStatusLine();
    },
  });
  /**
   * Close one fire on its loop. The child record is the truth for exit code,
   * duration and bytes; the loop keeps the history row and the failure backoff.
   */
  async function finishFire(view: ProcessTaskView): Promise<void> {
    const { parentId, fire } = view.task;
    if (parentId === undefined || fire === undefined) return;
    const completed = await loops.completeFire({
      parentId,
      taskId: view.task.id,
      fire,
      status: view.task.status,
      exitCode: view.task.exitCode,
      outputPath: view.task.outputPath,
      outputBytes: view.task.outputBytes,
      durationMs: view.elapsedMs,
      killReason: view.task.killReason,
      error: view.task.error,
      endedAt: view.task.endedAt,
    });
    if (completed === undefined || !completed.failed) return;
    if (completed.loop.wakeOnFailure === false) return;
    // The child is already named `loop #N`, which is the alias the notice shows.
    await notifyTaskFinished(pi, view);
  }
  for (const tool of processTaskTools(processTasks, chainTasks, templates.templates))
    pi.registerTool(tool);
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
  /**
   * Adopt the UI of whatever event is running. `session_start` is the normal way
   * in, but an extension loaded mid-session (`/reload`) never sees it, and the
   * footer would then stay empty for the rest of the session.
   */
  const remember = async (ctx: {
    readonly cwd: string;
    readonly sessionManager: { getSessionId(): string };
    readonly ui: ExtensionUIContext;
    /** pi says whether this mode has a UI at all; a tool call's context may omit it. */
    readonly hasUI?: boolean;
  }): Promise<void> => {
    const fresh = statusUi === undefined;
    const scope = scopeOf(ctx);
    statusUi = ctx.ui;
    statusScope = scope;
    uiAttached = ctx.hasUI === true;
    if (fresh) await publishStatus(ctx.ui, processTasks, loops, scope);
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
    if (task?.kind !== "llm-loop") return false;
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
    uiAttached = ctx.hasUI;
    // The line exists before the panel is ever opened; `/tasks` only refreshes it,
    // so the first paint is awaited rather than left to race the session start.
    await publishStatus(ctx.ui, processTasks, loops, scope);
    // Old sessions are reclaimed here, once per session start and never on a
    // timer: a sweep only runs where its cost can be waited out, and a process
    // that stays up for days never deletes history a user is still reading.
    await pruneOldSessions(scope);
    startTimer();
    // A fresh session has no run in flight, so a wake left queued by the last one
    // may go out now.
    agentIdle = true;
    await flushWakes();
  });
  // A turn is running: a fire recorded now waits for `agent_settled`, because pi
  // queues a `followUp` and cannot take it back (ADR-0009).
  pi.on("agent_start", async (_event, ctx) => {
    await remember(ctx);
    agentIdle = false;
  });
  // One pump on a turn boundary covers the case where the timer was delayed by
  // a long turn; a loop that became due during the turn wakes right after it.
  pi.on("turn_end", async (_event, ctx) => {
    await remember(ctx);
    await pumpSafely();
  });
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
    await remember(ctx);
    await recordSafely(iterations.settle(scopeOf(ctx), event.aborted));
    agentIdle = true;
    await flushWakes();
  });
  pi.on("session_shutdown", () => {
    stopTimer();
    statusUi = undefined;
    statusScope = undefined;
    uiAttached = false;
  });

  return {
    loops,
    processTasks,
    chainTasks,
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
