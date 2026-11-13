/**
 * `bg_run`, `bg_status` and `bg_logs`: what the agent can do with process tasks.
 *
 * The tools are thin. They translate a turn into a scope, call the store, and
 * render the result as text a model can read — all knowledge of shells,
 * files and process state stays behind the store.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type {
  AgentToolResult,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { commandPreview, formatBytes, formatDuration } from "../base/format.js";

import type { ProcessTasks, ProcessTaskView, TaskScope } from "./process-tasks.js";

const RunParameters = Type.Object({
  command: Type.String({ description: "Shell command to run in the background." }),
  name: Type.Optional(
    Type.String({ description: "Short label for the task; defaults to the command itself." }),
  ),
});

const StatusParameters = Type.Object({
  id: Type.Optional(
    Type.String({ description: "Task id to describe. Omit it to list every task of the session." }),
  ),
  full: Type.Optional(
    Type.Boolean({ description: "Show the untruncated record, including the whole command." }),
  ),
});

const LogsParameters = Type.Object({
  id: Type.String({ description: "Task id to read output from." }),
  lines: Type.Optional(
    Type.Number({ description: "How many trailing lines to return. Defaults to 50." }),
  ),
  full: Type.Optional(
    Type.Boolean({ description: "Return the whole output file instead of a tail." }),
  ),
});

const DEFAULT_LOG_LINES = 50;
const MAX_LOG_LINES = 2000;
/**
 * `full` reads a much larger window than a tail, but still a window: the output
 * cap ticket owns the real ceiling, and this bound keeps one call from reading
 * an arbitrarily large file into memory.
 */
const FULL_MAX_BYTES = 4 * 1024 * 1024;
const COMMAND_PREVIEW_LENGTH = 80;

function scopeOf(ctx: ExtensionToolContext): TaskScope {
  return { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
}

function text(content: string): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text: content }], details: {} };
}

/** One task as a labelled block, the shape both `bg_run` and `bg_status` return. */
export function describeTask(view: ProcessTaskView, options: { full?: boolean } = {}): string {
  const { task } = view;
  const lines = [
    `name: ${task.name}`,
    `id: ${task.id}`,
    `kind: ${task.kind}`,
    `status: ${task.status}`,
    `elapsed: ${formatDuration(view.elapsedMs)}`,
    `output: ${formatBytes(view.outputBytes)}`,
    `output file: ${task.outputPath}`,
    `command: ${options.full === true ? task.command : commandPreview(task.command, COMMAND_PREVIEW_LENGTH)}`,
  ];
  if (task.exitCode !== undefined && task.exitCode !== null) {
    lines.push(`exit code: ${String(task.exitCode)}`);
  }
  if (task.error !== undefined) lines.push(`error: ${task.error}`);
  return lines.join("\n");
}

/** What a tool reports about one task, in a shape the caller can inspect. */
function taskDetails(view: ProcessTaskView) {
  return {
    id: view.task.id,
    name: view.task.name,
    kind: view.task.kind,
    status: view.task.status,
    elapsedMs: view.elapsedMs,
    outputBytes: view.outputBytes,
    pid: view.task.pid,
    exitCode: view.task.exitCode,
    command: view.task.command,
    outputPath: view.task.outputPath,
  };
}

/** The three process-task tools, bound to one store. */
export function processTaskTools(tasks: ProcessTasks): ToolDefinition[] {
  const run: ToolDefinition<typeof RunParameters> = {
    name: "bg_run",
    label: "Run in background",
    description:
      "Run a shell command in the background and return a task id at once, without waiting for the command to finish. stdout and stderr are captured together in one output file.",
    parameters: RunParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const task = await tasks.start({
        ...scopeOf(ctx),
        command: params.command,
        ...(params.name === undefined ? {} : { name: params.name }),
      });
      const view = tasks.get(scopeOf(ctx), task.id) ?? {
        task,
        elapsedMs: 0,
        outputBytes: task.outputBytes,
      };
      return {
        content: [
          {
            type: "text",
            text: [
              `Started background task ${task.id} (${task.name}).`,
              "",
              describeTask(view),
              "",
              `Read its output with bg_logs id=${task.id}; check it with bg_status id=${task.id}.`,
            ].join("\n"),
          },
        ],
        details: taskDetails(view),
      };
    },
  };

  const status: ToolDefinition<typeof StatusParameters> = {
    name: "bg_status",
    label: "Background task status",
    description:
      "Show background tasks of this session: status, elapsed time and output size. Pass an id for one task, or omit it to list them all.",
    parameters: StatusParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = scopeOf(ctx);
      const wantedId = params.id?.trim();
      const full = params.full === true;

      if (wantedId !== undefined && wantedId.length > 0) {
        const view = tasks.get(scope, wantedId);
        if (view === undefined) {
          return text(`No background task with id ${wantedId} in this session.`);
        }
        return {
          content: [{ type: "text", text: describeTask(view, { full }) }],
          details: taskDetails(view),
        };
      }

      const all = tasks.list(scope);
      if (all.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No background tasks in this session yet. Start one with bg_run.",
            },
          ],
          details: { tasks: [] },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: all.map((view) => describeTask(view, { full })).join("\n\n"),
          },
        ],
        details: { tasks: all.map((view) => taskDetails(view)) },
      };
    },
  };

  const logs: ToolDefinition<typeof LogsParameters> = {
    name: "bg_logs",
    label: "Background task output",
    description:
      "Return the tail of a background task's output, stdout and stderr in emission order. Ask again while it runs to see more.",
    parameters: LogsParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const full = params.full === true;
      const wanted = Math.floor(params.lines ?? DEFAULT_LOG_LINES);
      const lines = Number.isFinite(wanted)
        ? Math.min(MAX_LOG_LINES, Math.max(1, wanted))
        : DEFAULT_LOG_LINES;

      const found = await tasks.logs(scopeOf(ctx), params.id.trim(), {
        lines: full ? Number.MAX_SAFE_INTEGER : lines,
        ...(full ? { maxBytes: FULL_MAX_BYTES } : {}),
      });
      if (found === undefined) {
        return text(`No background task with id ${params.id} in this session.`);
      }

      const { view, tail } = found;
      const header = [
        `${view.task.name} · ${view.task.id} · ${view.task.kind} · ${view.task.status}`,
        `elapsed ${formatDuration(view.elapsedMs)} · output ${formatBytes(view.outputBytes)}`,
      ].join("\n");
      const note = tail.truncated ? `\n(showing the last ${String(tail.lines)} lines)` : "";
      const body = tail.text.length > 0 ? tail.text : "(no output yet)";
      return {
        content: [{ type: "text", text: `${header}${note}\n\n${body}` }],
        details: {
          id: view.task.id,
          status: view.task.status,
          lines: tail.lines,
          truncated: tail.truncated,
          outputBytes: view.outputBytes,
        },
      };
    },
  };

  return [run, status, logs];
}
