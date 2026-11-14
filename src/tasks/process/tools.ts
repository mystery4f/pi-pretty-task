/**
 * `bg_run`, `bg_status`, `bg_logs`, `bg_kill` and `bg_wait`: what the agent can
 * do with process tasks.
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
import type { ProcessTask } from "../base/task.js";

import { parseTimeoutSeconds, parseWaitSeconds } from "./limits.js";
import type { ProcessTasks, ProcessTaskView, TaskScope } from "./process-tasks.js";

const RunParameters = Type.Object({
  command: Type.String({
    description:
      "Shell command to run in the background. The shell depends on the platform and on the extension's configuration; `shell` picks another one for this call. Write the command in the dialect of that shell: cmd joins with `&`, while sh and bash treat `&` as background and need `;` or `&&`. Output is stored as raw bytes.",
  }),
  name: Type.Optional(
    Type.String({
      description:
        "Short purpose of the task, not its command: why it runs, in a few words the panel can show. Example: `为 CI 生成 changelog`. Optional; without it the task falls back to a label derived from the command.",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description:
        "Optional runtime cap in seconds. When it passes, the task is stopped with kill reason `timeout`; without it the task runs until it ends or is stopped.",
    }),
  ),
  shell: Type.Optional(
    Type.Union(
      [Type.Literal("default"), Type.Literal("cmd"), Type.Literal("bash"), Type.Literal("sh")],
      {
        description:
          "Shell for this call: `default` follows the configured shell, the others name one. Windows has `cmd` and `bash`, POSIX has `bash` and `sh`; anything else is rejected. Syntax is not translated: in cmd `&` runs the next command in turn, in bash it backgrounds the left side, so use `;` or `&&` there.",
      },
    ),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Directory the command runs in. A relative path is resolved against the session's working directory; the resolved absolute path is kept in the task record and shown by the panel and bg_status. The directory must already exist.",
    }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "Environment variables for this command only, merged over the extension's environment for the child. An empty string blanks a variable. Neither names nor values are written to the task record or printed by any tool.",
    }),
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

const KillParameters = Type.Object({
  id: Type.String({ description: "Task id to stop, with everything its command started." }),
});

const WaitParameters = Type.Object({
  id: Type.String({ description: "Task id to wait for." }),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description:
        "How long to wait before returning the still-running task. Defaults to 60 seconds and is capped at 600. A timeout is not an error.",
    }),
  ),
});

const DEFAULT_LOG_LINES = 50;
const MAX_LOG_LINES = 2000;
/**
 * `full` reads a much larger window than a tail, but still a window: the output
 * cap bounds the file (20 MiB unless configured), and this bound keeps one call
 * from reading all of it into memory.
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
    `cwd: ${task.cwd}`,
    `command: ${options.full === true ? task.command : commandPreview(task.command, COMMAND_PREVIEW_LENGTH)}`,
  ];
  if (task.exitCode !== undefined && task.exitCode !== null) {
    lines.push(`exit code: ${String(task.exitCode)}`);
  }
  if (task.error !== undefined) lines.push(`error: ${task.error}`);
  if (task.killReason !== undefined) lines.push(`kill reason: ${task.killReason}`);
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
    cwd: view.task.cwd,
    outputPath: view.task.outputPath,
    killReason: view.task.killReason,
  };
}

/** The process-task tools, bound to one store. */
export function processTaskTools(tasks: ProcessTasks): ToolDefinition[] {
  const run: ToolDefinition<typeof RunParameters> = {
    name: "bg_run",
    label: "Run in background",
    description:
      "Run a shell command in the background and return a task id at once, without waiting for the command to finish. stdout and stderr are captured together in one output file.",
    parameters: RunParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // A bad runtime is reported before anything is spawned: a task that can
      // never be capped is worse than a rejected request.
      let timeoutMs: number | undefined;
      if (params.timeoutSeconds !== undefined) {
        try {
          timeoutMs = parseTimeoutSeconds(params.timeoutSeconds);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return text(`${reason} The task was not started.`);
        }
      }
      let task: ProcessTask;
      try {
        task = await tasks.start({
          ...scopeOf(ctx),
          command: params.command,
          ...(params.name === undefined ? {} : { name: params.name }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(params.shell === undefined ? {} : { shell: params.shell }),
          ...(params.cwd === undefined ? {} : { workingDirectory: params.cwd }),
          ...(params.env === undefined ? {} : { env: params.env }),
        });
      } catch (error) {
        // A shell this call cannot have, a shell that is not installed, or a
        // directory that cannot be used: the store throws before a record is
        // written, so the turn gets the reason and no task.
        const reason = error instanceof Error ? error.message : String(error);
        return text(`${reason} The task was not started.`);
      }
      const view = (await tasks.get(scopeOf(ctx), task.id)) ?? {
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
        const view = await tasks.get(scope, wantedId);
        if (view === undefined) {
          return text(`No background task with id ${wantedId} in this session.`);
        }
        return {
          content: [{ type: "text", text: describeTask(view, { full }) }],
          details: taskDetails(view),
        };
      }

      const all = await tasks.list(scope);
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
        `name: ${view.task.name} · ${view.task.id} · ${view.task.kind} · ${view.task.status}`,
        `elapsed ${formatDuration(view.elapsedMs)} · output ${formatBytes(view.outputBytes)}`,
        // The output is the story here, so the reason it stopped belongs in the
        // same header as the status instead of being a line the reader must ask for.
        ...(view.task.killReason === undefined ? [] : [`kill reason: ${view.task.killReason}`]),
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
          killReason: view.task.killReason,
        },
      };
    },
  };

  const wait: ToolDefinition<typeof WaitParameters> = {
    name: "bg_wait",
    label: "Wait for a background task",
    description:
      "Wait for a background task to end, then return its final view. A timeout is not an error: it returns the running view with waited: false.",
    parameters: WaitParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = params.id.trim();
      if (id.length === 0) {
        return text(
          "Pass the id of the task to wait for; bg_status lists the ids of this session.",
        );
      }

      // A wait that cannot be counted would hold the turn forever, so a bad
      // bound is reported before the store is called.
      let timeoutMs: number;
      try {
        timeoutMs = parseWaitSeconds(params.timeoutSeconds);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return text(`${reason} Nothing was waited for.`);
      }

      const result = await tasks.wait(scopeOf(ctx), id, timeoutMs);
      if (result === undefined) {
        return text(`No background task with id ${id} in this session.`);
      }

      const { view, waited } = result;
      const headline = waited
        ? `Background task ${id} (${view.task.name}) ended as ${view.task.status} after ${formatDuration(view.elapsedMs)}.`
        : `Background task ${id} (${view.task.name}) is still running after ${formatDuration(view.elapsedMs)}; it did not finish within the wait.`;
      return {
        content: [{ type: "text", text: [headline, "", describeTask(view)].join("\n") }],
        details: { ...taskDetails(view), waited },
      };
    },
  };

  const kill: ToolDefinition<typeof KillParameters> = {
    name: "bg_kill",
    label: "Stop a background task",
    description:
      "Stop a background task and every process its command started: a polite signal, a short grace period, then force. A task that already finished is reported as such instead of failing.",
    parameters: KillParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = params.id.trim();
      if (id.length === 0) {
        return text("Pass the id of the task to stop; bg_status lists the ids of this session.");
      }

      const result = await tasks.stop(scopeOf(ctx), id);
      if (result === undefined) {
        return text(`No background task with id ${id} in this session.`);
      }

      const headline =
        result.outcome === "killed"
          ? `Stopped background task ${id} (${result.view.task.name}) in ${formatDuration(result.tookMs)}.`
          : result.outcome === "already-finished"
            ? `Background task ${id} had already finished (${result.view.task.status}); nothing was signalled.`
            : `Background task ${id} could not be stopped: ${result.detail ?? "its processes are still running"}.`;
      return {
        content: [{ type: "text", text: [headline, "", describeTask(result.view)].join("\n") }],
        details: {
          ...taskDetails(result.view),
          stopOutcome: result.outcome,
          tookMs: result.tookMs,
        },
      };
    },
  };

  return [run, status, logs, kill, wait];
}
