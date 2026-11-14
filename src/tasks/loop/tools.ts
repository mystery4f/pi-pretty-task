/**
 * `loop_create`, `loop_list`, `loop_update` and `loop_delete`: what the agent
 * can do with loop tasks.
 *
 * Like the process tools these are thin: they turn a turn into a scope, call the
 * loop store, and render the record as text. Nothing here owns a timer; the
 * extension's pump is the only clock.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type {
  AgentToolResult,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatBytes, formatDuration } from "../base/format.js";
import type { TaskScope } from "../base/runtime-state.js";
import type { CmdLoopTask, FireRecord, LlmLoopTask } from "../base/task.js";
import { LoopInputError, type LoopTasks, type LoopTaskView } from "./loop-tasks.js";

const CreateParameters = Type.Object({
  schedule: Type.String({
    description:
      "When to fire: interval shorthand such as 30s, 10m or 2h (seconds allowed), or a five-field cron expression in local time such as 0 9 * * 1-5 (minute hour day-of-month month day-of-week; * every, 1-5 ranges, 9,17 lists, */15 steps). Weekdays: 0-6 start on Sunday and 7 is Sunday too. A day-of-month and a day-of-week both given fire on either match; when only one is given it must match. Six fields are refused: use the shorthand for second-level timing.",
  }),
  prompt: Type.Optional(
    Type.String({
      description:
        "Message sent into the session each time the loop fires; it starts a new turn. Give this or `command`, never both.",
    }),
  ),
  command: Type.Optional(
    Type.String({
      description:
        "Shell command to run as a background process on each fire, exactly like bg_run. Give this or `prompt`, never both. A fire that comes due while the previous one still runs is skipped and shown as skipped, not started twice.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory of a command loop; relative paths resolve against the session directory. Only valid with `command`.",
    }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "Extra environment variables for a command loop, layered over the session environment. Only valid with `command`.",
    }),
  ),
  wakeOnFailure: Type.Optional(
    Type.Boolean({
      description:
        "Send a notice into this session when a fire fails (exit code, duration, last output lines); a healthy fire stays silent. Defaults to true. Only valid with `command`.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Short purpose of the loop, not its prompt: why it keeps waking the session, in a few words the panel can show. Example: `为 CI 生成 changelog`. Optional; without it the loop falls back to its prompt's first line.",
    }),
  ),
  maxFires: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Stop after this many fires. Omit it for no limit.",
    }),
  ),
  expiresIn: Type.Optional(
    Type.String({
      description:
        "Stop this long after creation, using the same shorthand (for example 30m or 2h).",
    }),
  ),
});

const ListParameters = Type.Object({
  id: Type.Optional(
    Type.String({ description: "Loop id to describe. Omit it to list every loop of the session." }),
  ),
});

const UpdateParameters = Type.Object({
  id: Type.String({ description: "Loop id to update." }),
  action: Type.Optional(
    Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("complete")], {
      description:
        "pause stops fires but keeps the record; resume re-arms from now; complete ends the loop. Omit it to change only the schedule.",
    }),
  ),
  schedule: Type.Optional(
    Type.String({
      description:
        "New schedule for the same loop, in the forms loop_create accepts. The loop keeps its id, fire count and every recorded iteration; a running loop is re-armed from this update, never from the slot the old schedule had picked. An invalid expression is refused and the old schedule stays in force.",
    }),
  ),
});

const DeleteParameters = Type.Object({
  id: Type.String({ description: "Loop id to delete." }),
});

function scopeOf(ctx: ExtensionToolContext): TaskScope {
  return { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
}

function text(
  content: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text: content }], details };
}

function inputError(error: LoopInputError): AgentToolResult<Record<string, unknown>> {
  return text(error.message, { error: error.message });
}

function nextFireText(view: LoopTaskView): string {
  const { task } = view;
  if (task.nextFireAt === undefined) {
    return task.status === "paused" ? "none (paused)" : "none";
  }
  const absolute = new Date(task.nextFireAt).toISOString();
  const relative =
    view.untilNextFireMs === undefined ? "" : ` (in ${formatDuration(view.untilNextFireMs)})`;
  return `${absolute}${relative}`;
}

/** One loop as a labelled block, shared by the loop tools. */
export function describeLoop(view: LoopTaskView): string {
  const { task } = view;
  const lines = [
    `name: ${task.name}`,
    `id: ${task.id}`,
    `kind: ${task.kind}`,
    `status: ${task.status}`,
    `schedule: ${task.schedule}`,
    `fires: ${String(task.fires)}${task.maxFires === undefined ? "" : ` / ${String(task.maxFires)}`}`,
    `next fire: ${nextFireText(view)}`,
  ];
  if (task.lastFireAt !== undefined) {
    lines.push(`last fire: ${new Date(task.lastFireAt).toISOString()}`);
  }
  lines.push(task.kind === "llm-loop" ? iterationSummary(task) : fireSummary(task));
  if (task.expiresAt !== undefined) {
    lines.push(`expires: ${new Date(task.expiresAt).toISOString()}`);
  }
  if (task.endedAt !== undefined) {
    lines.push(`ended: ${new Date(task.endedAt).toISOString()}`);
  }
  if (task.error !== undefined) lines.push(`error: ${task.error}`);
  if (task.kind === "llm-loop") {
    lines.push(`prompt: ${task.prompt}`);
  } else {
    if (task.cwd !== undefined) lines.push(`cwd: ${task.cwd}`);
    if (task.wakeOnFailure === false) lines.push("wake on failure: off");
    if (task.lastOutputPath !== undefined) {
      const exit =
        task.lastExitCode === undefined || task.lastExitCode === null
          ? "—"
          : String(task.lastExitCode);
      lines.push(
        `last output: ${exit} · ${formatBytes(task.lastOutputBytes ?? 0)} · ${task.lastOutputPath}`,
      );
    }
    lines.push(`command: ${task.command}`);
  }
  return lines.join("\n");
}

/**
 * One line for the loop's block: how many turns it woke and what the newest one
 * did. A loop with no iteration yet says so, because `iterations: none` is a fact
 * a caller can act on, unlike a missing line.
 */
function iterationSummary(task: LlmLoopTask): string {
  const dropped = task.droppedIterations ?? 0;
  const droppedText = dropped > 0 ? ` (${String(dropped)} older dropped)` : "";
  const newest = task.iterations.at(-1);
  if (newest === undefined) return `iterations: none${droppedText}`;
  const ended =
    newest.endedAt === undefined ? "" : `, ${formatDuration(newest.endedAt - newest.startedAt)}`;
  return `iterations: ${String(task.iterations.length)}${droppedText} · newest fire ${String(newest.fire)} ${newest.status}${ended}, ${String(newest.calls.length)} calls`;
}

/**
 * One line for a command loop's block: how many fires it has had, and the newest
 * recorded one. Skipped fires are counted, so a stuck command cannot look quiet.
 */
function fireSummary(task: CmdLoopTask): string {
  const dropped = Math.max(0, task.fires - task.fireHistory.length);
  const droppedText = dropped > 0 ? ` (${String(dropped)} older dropped)` : "";
  const newest = task.fireHistory.at(-1);
  if (newest === undefined) return `fires: none${droppedText}`;
  return `fires: ${String(task.fires)}${droppedText} · newest #${String(newest.fire)} ${newest.outcome}${fireMeta(newest)}`;
}

/** The changing facts of one fire, in the order a person reads them. */
function fireMeta(fire: FireRecord): string {
  const parts = [
    fire.exitCode === undefined ? undefined : `exit ${String(fire.exitCode)}`,
    fire.durationMs === undefined ? undefined : formatDuration(fire.durationMs),
    fire.outputBytes === undefined ? undefined : formatBytes(fire.outputBytes),
    fire.taskId,
    fire.error,
  ];
  return parts
    .filter((part) => part !== undefined && part.length > 0)
    .map((part) => ` · ${part as string}`)
    .join("");
}

/**
 * The fire listing for one command loop, newest first: the same rows the panel
 * expands to, so a caller reading `loop_list id=…` sees what the user sees.
 * A trimmed record says how many older fires it dropped.
 */
export function describeFires(task: CmdLoopTask): string {
  const dropped = Math.max(0, task.fires - task.fireHistory.length);
  if (task.fireHistory.length === 0) {
    return dropped > 0
      ? `No fire recorded; ${String(dropped)} older ones were dropped.`
      : "No fire yet: this loop has not fired.";
  }

  const rows = [...task.fireHistory].reverse().map((fire) => {
    const time = fire.at === undefined ? undefined : new Date(fire.at).toISOString();
    const head = [`#${String(fire.fire)}`, time, fire.outcome]
      .filter((part) => part !== undefined)
      .join(" · ");
    return `${head}${fireMeta(fire)}`;
  });
  if (dropped > 0) rows.push(`… ${String(dropped)} older`);
  return rows.join("\n");
}

/**
 * The iteration listing for one loop, newest first, with the tool calls each turn
 * made. This is the listing `loop_list id=…` returns and the panel (#9) draws:
 * an iteration is reachable from the loop, never as a row of its own (ADR-0002).
 * A truncated record says how much it dropped rather than hiding it.
 */
export function describeIterations(task: LlmLoopTask): string {
  if (task.iterations.length === 0) {
    return task.droppedIterations === undefined || task.droppedIterations === 0
      ? "No iteration yet: this loop has not fired."
      : `No iteration recorded; ${String(task.droppedIterations)} older ones were dropped.`;
  }

  return [...task.iterations]
    .reverse()
    .map((iteration) => {
      const head = [
        `fire ${String(iteration.fire)}`,
        iteration.status,
        new Date(iteration.startedAt).toISOString(),
        iteration.endedAt === undefined
          ? undefined
          : formatDuration(iteration.endedAt - iteration.startedAt),
        `${String(iteration.calls.length)} calls`,
        iteration.droppedCalls > 0
          ? `+${String(iteration.droppedCalls)} earlier calls dropped`
          : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(" · ");
      if (iteration.calls.length === 0) return `${head}\n  (no tool calls)`;
      const calls = iteration.calls.map((call) => {
        const line = [
          `  ${call.tool}`,
          call.subject,
          call.status,
          call.durationMs === undefined ? undefined : formatDuration(call.durationMs),
        ]
          .filter((part) => part !== undefined && part.length > 0)
          .join(" · ");
        return call.error === undefined ? line : `${line}\n    error: ${call.error}`;
      });
      return [head, ...calls].join("\n");
    })
    .join("\n\n");
}

/**
 * The facts a caller can inspect without parsing the prose. The per-kind summary
 * is always here; the iterations and fires themselves only when asked for,
 * because a listing of every loop must not carry every tool call of every wake.
 */
function loopDetails(
  view: LoopTaskView,
  options: { readonly iterations?: boolean } = {},
): Record<string, unknown> {
  const { task } = view;
  const shared = {
    id: task.id,
    name: task.name,
    kind: task.kind,
    status: task.status,
    schedule: task.schedule,
    fires: task.fires,
    maxFires: task.maxFires,
    nextFireAt: task.nextFireAt,
    lastFireAt: task.lastFireAt,
    missedFires: task.missedFires,
    consecutiveFailures: task.consecutiveFailures,
    expiresAt: task.expiresAt,
    endedAt: task.endedAt,
    untilNextFireMs: view.untilNextFireMs,
    error: task.error,
  };
  if (task.kind === "llm-loop") {
    return {
      ...shared,
      prompt: task.prompt,
      iterationCount: task.iterations.length,
      droppedIterations: task.droppedIterations,
      ...(options.iterations === true ? { iterations: task.iterations } : {}),
    };
  }
  return {
    ...shared,
    command: task.command,
    cwd: task.cwd,
    wakeOnFailure: task.wakeOnFailure,
    lastExitCode: task.lastExitCode,
    lastOutputPath: task.lastOutputPath,
    lastOutputBytes: task.lastOutputBytes,
    fireCount: task.fireHistory.length,
    ...(options.iterations === true ? { fireHistory: task.fireHistory } : {}),
  };
}

function updateHeadline(id: string, result: Awaited<ReturnType<LoopTasks["update"]>>): string {
  if (result === undefined) return `No loop with id ${id} in this session.`;
  const name = result.view.task.name;
  switch (result.outcome) {
    case "paused":
      return `Paused loop ${id} (${name}); it will not fire until resumed.`;
    case "already-paused":
      return `Loop ${id} was already paused.`;
    case "resumed":
      return `Resumed loop ${id} (${name}); its next fire is ${nextFireText(result.view)}.`;
    case "rescheduled": {
      const retuned = `Retuned loop ${id} (${name}) to ${result.view.task.schedule}`;
      return result.view.task.status === "paused"
        ? `${retuned}; it stays paused until resumed.`
        : `${retuned}; its next fire is ${nextFireText(result.view)}.`;
    }
    case "already-running":
      return `Loop ${id} is already running.`;
    case "completed":
      return `Completed loop ${id} (${name}); it will not fire again.`;
    case "already-completed":
      return `Loop ${id} had already finished (${result.view.task.status}).`;
    case "completed-at-limit":
      return `Loop ${id} reached its maximum number of fires; it is completed.`;
    case "completed-expired":
      return `Loop ${id} expired before it was resumed; it is completed.`;
    case "failed":
      return `Loop ${id} could not be resumed: ${result.view.task.error ?? "invalid schedule"}.`;
  }
}

/** The loop-task tools, bound to one store. */
export function loopTaskTools(loops: LoopTasks): ToolDefinition[] {
  const create: ToolDefinition<typeof CreateParameters> = {
    name: "loop_create",
    label: "Create a loop",
    description:
      "Schedule something to happen on a recurrence. With `prompt`, each fire sends that message into this session and starts a new agent turn; the wake is delivered when the agent is idle, so a busy agent delays it instead of losing it. With `command`, each fire runs that shell command as an ordinary background process task (like bg_run) and nothing is sent into the session unless the fire fails and wakeOnFailure is on; a fire that comes due while the previous one still runs is skipped and recorded as skipped. Give exactly one of prompt and command. The schedule is an interval (30s, 10m, 2h) or a five-field cron expression in local time (0 9 * * 1-5). Use loop_list to watch it and loop_delete to stop it.",
    parameters: CreateParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const view = await loops.create({
          ...scopeOf(ctx),
          schedule: params.schedule,
          ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
          ...(params.command === undefined ? {} : { command: params.command }),
          ...(params.cwd === undefined ? {} : { workingDirectory: params.cwd }),
          ...(params.env === undefined ? {} : { env: params.env }),
          ...(params.wakeOnFailure === undefined ? {} : { wakeOnFailure: params.wakeOnFailure }),
          ...(params.name === undefined ? {} : { name: params.name }),
          ...(params.maxFires === undefined ? {} : { maxFires: params.maxFires }),
          ...(params.expiresIn === undefined ? {} : { expiresIn: params.expiresIn }),
        });
        return {
          content: [
            {
              type: "text",
              text: [
                `Created loop ${view.task.id} (${view.task.name}).`,
                "",
                describeLoop(view),
                "",
                `Watch it with loop_list id=${view.task.id}; pause it with loop_update id=${view.task.id} action=pause.`,
              ].join("\n"),
            },
          ],
          details: loopDetails(view),
        };
      } catch (error) {
        if (error instanceof LoopInputError) return inputError(error);
        throw error;
      }
    },
  };

  const list: ToolDefinition<typeof ListParameters> = {
    name: "loop_list",
    label: "List loops",
    description:
      "Show loops of this session with their raw schedule, next fire time, fire count and status. A fire is counted at its scheduled time; for a prompt loop it is delivered only when the agent is idle, and for a command loop it is started immediately or skipped when the previous fire still runs. Pass an id to also get that loop's history, newest first: a prompt loop's iterations with the tool calls each turn made, or a command loop's fires with their time, outcome, exit code, duration and output size. Omit the id to list them all.",
    parameters: ListParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = scopeOf(ctx);
      const wantedId = params.id?.trim();

      if (wantedId !== undefined && wantedId.length > 0) {
        const view = await loops.get(scope, wantedId);
        if (view === undefined) {
          return text(`No loop with id ${wantedId} in this session.`);
        }
        return {
          content: [
            {
              type: "text",
              text: [
                describeLoop(view),
                "",
                view.task.kind === "llm-loop"
                  ? describeIterations(view.task)
                  : describeFires(view.task),
              ].join("\n"),
            },
          ],
          details: loopDetails(view, { iterations: true }),
        };
      }

      const all = await loops.list(scope);
      if (all.length === 0) {
        return text("No loops in this session yet. Create one with loop_create.", { loops: [] });
      }
      return {
        content: [{ type: "text", text: all.map((view) => describeLoop(view)).join("\n\n") }],
        details: { loops: all.map((view) => loopDetails(view)) },
      };
    },
  };

  const update: ToolDefinition<typeof UpdateParameters> = {
    name: "loop_update",
    label: "Pause, resume, complete or retune a loop",
    description:
      "Change a loop without deleting its history: pause stops fires, resume re-arms from now, complete ends it, and schedule retunes when it fires. A retune keeps the id, the fire count and every recorded iteration; a running loop's next fire is computed from this update rather than from the slot the old schedule had already picked, a paused loop keeps the new schedule and arms onto it when resumed, and an invalid expression is refused with the old schedule still in force. Pausing or completing also cancels a wake that is still waiting for the agent to be idle, so the loop will not wake the model after you stop it.",
    parameters: UpdateParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = params.id.trim();
      if (id.length === 0) {
        return text("Pass the id of the loop to update; loop_list lists the ids of this session.");
      }

      // A retune and a transition may arrive together; the store applies the
      // schedule first, so `resume` with a new schedule lands on the new interval.
      const input = {
        ...scopeOf(ctx),
        id,
        ...(params.action === undefined ? {} : { action: params.action }),
        ...(params.schedule === undefined ? {} : { schedule: params.schedule }),
      };
      try {
        const result = await loops.update(input);
        if (result === undefined) {
          return text(`No loop with id ${id} in this session.`);
        }
        return {
          content: [
            {
              type: "text",
              text: [updateHeadline(id, result), "", describeLoop(result.view)].join("\n"),
            },
          ],
          details: { ...loopDetails(result.view), outcome: result.outcome },
        };
      } catch (error) {
        if (error instanceof LoopInputError) return inputError(error);
        throw error;
      }
    },
  };

  const remove: ToolDefinition<typeof DeleteParameters> = {
    name: "loop_delete",
    label: "Delete a loop",
    description:
      "Delete a loop record and stop its schedule. Use loop_update action=complete instead when the history should remain.",
    parameters: DeleteParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = params.id.trim();
      if (id.length === 0) {
        return text("Pass the id of the loop to delete; loop_list lists the ids of this session.");
      }

      const removed = await loops.delete(scopeOf(ctx), id);
      if (removed === undefined) {
        return text(`No loop with id ${id} in this session.`);
      }
      return {
        content: [
          {
            type: "text",
            text: `Deleted loop ${id} (${removed.task.name}); it will not fire again.`,
          },
        ],
        details: loopDetails(removed),
      };
    },
  };

  return [create, list, update, remove];
}
