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
import { formatDuration } from "../base/format.js";
import type { TaskScope } from "../base/runtime-state.js";
import type { LoopTask } from "../base/task.js";
import {
  LoopInputError,
  type LoopTasks,
  type LoopTaskView,
  type LoopUpdateAction,
} from "./loop-tasks.js";

const CreateParameters = Type.Object({
  schedule: Type.String({
    description:
      "When to fire: interval shorthand such as 30s, 10m or 2h (seconds allowed), or a five-field cron expression in local time such as 0 9 * * 1-5 (minute hour day-of-month month day-of-week; * every, 1-5 ranges, 9,17 lists, */15 steps). Six fields are refused: use the shorthand for second-level timing.",
  }),
  prompt: Type.String({
    description:
      "Message sent into the session each time the loop fires; it starts a new turn. There is no command to run.",
  }),
  name: Type.Optional(
    Type.String({ description: "Short label for the loop; defaults to its prompt's first line." }),
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
  action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("complete")], {
    description:
      "pause stops fires but keeps the record; resume re-arms from now; complete ends the loop.",
  }),
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
  lines.push(iterationSummary(task));
  if (task.expiresAt !== undefined) {
    lines.push(`expires: ${new Date(task.expiresAt).toISOString()}`);
  }
  if (task.endedAt !== undefined) {
    lines.push(`ended: ${new Date(task.endedAt).toISOString()}`);
  }
  if (task.error !== undefined) lines.push(`error: ${task.error}`);
  lines.push(`prompt: ${task.prompt}`);
  return lines.join("\n");
}

/**
 * One line for the loop's block: how many turns it woke and what the newest one
 * did. A loop with no iteration yet says so, because `iterations: none` is a fact
 * a caller can act on, unlike a missing line.
 */
function iterationSummary(task: LoopTask): string {
  const dropped = task.droppedIterations ?? 0;
  const droppedText = dropped > 0 ? ` (${String(dropped)} older dropped)` : "";
  const newest = task.iterations.at(-1);
  if (newest === undefined) return `iterations: none${droppedText}`;
  const ended =
    newest.endedAt === undefined ? "" : `, ${formatDuration(newest.endedAt - newest.startedAt)}`;
  return `iterations: ${String(task.iterations.length)}${droppedText} · newest fire ${String(newest.fire)} ${newest.status}${ended}, ${String(newest.calls.length)} calls`;
}

/**
 * The iteration listing for one loop, newest first, with the tool calls each turn
 * made. This is the listing `loop_list id=…` returns and the panel (#9) draws:
 * an iteration is reachable from the loop, never as a row of its own (ADR-0002).
 * A truncated record says how much it dropped rather than hiding it.
 */
export function describeIterations(task: LoopTask): string {
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
 * The facts a caller can inspect without parsing the prose. The iteration
 * summary is always here; the iterations themselves only when asked for, because
 * a listing of every loop must not carry every tool call of every wake.
 */
function loopDetails(
  view: LoopTaskView,
  options: { readonly iterations?: boolean } = {},
): Record<string, unknown> {
  const { task } = view;
  return {
    id: task.id,
    name: task.name,
    kind: task.kind,
    status: task.status,
    schedule: task.schedule,
    prompt: task.prompt,
    fires: task.fires,
    maxFires: task.maxFires,
    nextFireAt: task.nextFireAt,
    lastFireAt: task.lastFireAt,
    expiresAt: task.expiresAt,
    endedAt: task.endedAt,
    untilNextFireMs: view.untilNextFireMs,
    error: task.error,
    iterationCount: task.iterations.length,
    droppedIterations: task.droppedIterations,
    ...(options.iterations === true ? { iterations: task.iterations } : {}),
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
      "Schedule a prompt to be sent into this session, starting a new agent turn each time the loop fires. The schedule is an interval (30s, 10m, 2h) or a five-field cron expression in local time (0 9 * * 1-5). This does not run a command; the prompt is the work. A fire is delivered when the agent is idle, so a busy agent delays the wake instead of losing it. Use loop_list to watch it and loop_delete to stop it.",
    parameters: CreateParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const view = await loops.create({
          ...scopeOf(ctx),
          schedule: params.schedule,
          prompt: params.prompt,
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
      "Show loops of this session with their raw schedule, next fire time, fire count and status. A fire is counted at its scheduled time but delivered only when the agent is idle, so a fire count can lead the wakes actually sent. Pass an id to also get that loop's iterations, newest first, each with the tool calls the turn made. Omit the id to list them all.",
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
              text: [describeLoop(view), "", describeIterations(view.task)].join("\n"),
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
    label: "Pause, resume or complete a loop",
    description:
      "Change a loop without deleting its history: pause stops fires, resume re-arms from now, complete ends it. Pausing or completing also cancels a wake that is still waiting for the agent to be idle, so the loop will not wake the model after you stop it.",
    parameters: UpdateParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = params.id.trim();
      if (id.length === 0) {
        return text("Pass the id of the loop to update; loop_list lists the ids of this session.");
      }

      const result = await loops.update(scopeOf(ctx), id, params.action as LoopUpdateAction);
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
