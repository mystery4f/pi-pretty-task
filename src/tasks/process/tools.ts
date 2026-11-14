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
import {
  clampSearchMatches,
  DEFAULT_SEARCH_BYTES,
  DEFAULT_SEARCH_MATCHES,
  MAX_SEARCH_MATCHES,
  searchOutputFile,
} from "../base/search.js";
import type { ProcessTask } from "../base/task.js";

import { parseFollowSeconds, parseTimeoutSeconds, parseWaitSeconds } from "./limits.js";
import type { ProcessTasks, ProcessTaskView, TaskScope } from "./process-tasks.js";
import type { CommandTemplate } from "./templates.js";

const RunParameters = Type.Object({
  command: Type.Optional(
    Type.String({
      description:
        "Shell command to run in the background. Omit it to use the command from `template`; when both are given, this command wins. The shell depends on the platform and on the extension's configuration; `shell` picks another one for this call. Write the command in the dialect of that shell: cmd joins with `&`, while sh and bash treat `&` as background and need `;` or `&&`. Output is stored as raw bytes.",
    }),
  ),
  template: Type.Optional(
    Type.String({
      description:
        "Name of a command template. The project's `.pi/pretty-task.json` wins over the agent's `pretty-task.json`, which sits in `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`). The template fills in `command`, `cwd` and `timeoutSeconds`; an explicit field on this call wins. An unknown name is rejected with the names that do exist.",
    }),
  ),
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
  follow: Type.Optional(
    Type.Boolean({
      description:
        "Return only the output appended since this task's previous follow call in this session, waiting for new bytes instead of repeating what was already shown. `lines` and `full` do not apply. The answer says when the task has finished and nothing more will arrive.",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description:
        "With `follow`, how long to wait for new bytes before answering an empty delta. Defaults to 10 seconds; the longest single read is 60.",
    }),
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

const GrepParameters = Type.Object({
  id: Type.String({ description: "Task id whose output to search." }),
  pattern: Type.String({
    description:
      "Plain text to look for, matched as a substring of a single line. Not a regular expression: `.` and `*` are ordinary characters. Case is ignored unless `ignoreCase` is false.",
  }),
  ignoreCase: Type.Optional(
    Type.Boolean({
      description:
        "Match whatever the case. Defaults to true; pass false for an exact-case search.",
    }),
  ),
  maxMatches: Type.Optional(
    Type.Number({
      description: `How many matching lines to return at most. Defaults to ${String(DEFAULT_SEARCH_MATCHES)}, never more than ${String(MAX_SEARCH_MATCHES)}.`,
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
/**
 * One `bg_grep` answer is capped as a whole — header, matching lines and the
 * trailer together — so a noisy pattern cannot flood the context. The trailer is
 * paid for before the search runs, because its length decides how much room the
 * match list gets.
 */
const GREP_RESULT_BYTES = DEFAULT_SEARCH_BYTES;
const GREP_TRAILER_BYTES = 48;
/** Characters of the pattern the header and the verdict quote back at most. */
const PATTERN_PREVIEW_LENGTH = 120;

function scopeOf(ctx: ExtensionToolContext): TaskScope {
  return { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
}

function text(content: string): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text: content }], details: {} };
}

/** `1 line`, `40 lines`: a line count as an answer reads it. */
function lineCount(lines: number): string {
  return `${String(lines)} ${lines === 1 ? "line" : "lines"}`;
}

/**
 * The pattern as an answer echoes it. A long pattern would otherwise be quoted
 * back in full and spend the byte budget the matching lines need — the caller
 * already knows what it asked for; `details` still carries it whole.
 */
function patternPreview(pattern: string): string {
  const quoted = JSON.stringify(pattern);
  return quoted.length <= PATTERN_PREVIEW_LENGTH
    ? quoted
    : `${quoted.slice(0, PATTERN_PREVIEW_LENGTH)}…`;
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

/**
 * Read by the model, so it has to say plainly why a freshly written template is
 * not in the list yet: the file is read once at load, not per call.
 */
const RELOAD_NOTE =
  "Templates are read when the extension loads, so a file edited during this session applies only after /reload or a new session.";
/**
 * The tool description carries the template names, because an agent cannot read
 * `.pi/pretty-task.json` on its own: without this line the names are only
 * discovered by failing a call. The budget keeps the description short enough
 * to stay in a model's attention even with a large template file.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */
function runDescription(templates: ReadonlyMap<string, CommandTemplate>): string {
  const base =
    "Run a shell command in the background and return a task id at once, without waiting for the command to finish. stdout and stderr are captured together in one output file.";
  const names = [...templates.keys()].sort();
  if (names.length === 0) {
    return `${base} No command templates are configured, so \`template\` is rejected. ${RELOAD_NOTE}`;
  }
  // Three shapes, cheapest that still fits: every name with its command, then names
  // alone, then as many names as the budget holds. The description must not grow
  // with the file, or a large `pretty-task.json` would bloat every request.
  const entries = names.map(
    (name) => `${name} (${commandHint(templates.get(name)?.command ?? "")})`,
  );
  const list =
    withinBudget(entries, TEMPLATE_BUDGET) ??
    withinBudget(names, TEMPLATE_BUDGET) ??
    clipped(names, TEMPLATE_BUDGET);
  return `${base} Command templates available here: ${list}. ${RELOAD_NOTE}`;
}

/** Characters the template list may take in the description, commands included. */
const TEMPLATE_BUDGET = 300;

/** The whole list, or nothing when it does not fit. */
function withinBudget(parts: readonly string[], budget: number): string | undefined {
  const shown: string[] = [];
  let room = budget;
  for (const part of parts) {
    if (part.length > room) return undefined;
    shown.push(part);
    room -= part.length + 2;
  }
  return shown.join(", ");
}

/** As many parts as fit, with an ellipsis standing for the rest. */
function clipped(parts: readonly string[], budget: number): string {
  const shown: string[] = [];
  let room = budget;
  for (const part of parts) {
    if (part.length + 1 > room) break;
    shown.push(part);
    room -= part.length + 2;
  }
  return `${shown.join(", ")}…`;
}
/** One template's command on a single line, short enough to sit in a sentence. */
function commandHint(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  const room = 60;
  return flat.length <= room ? flat : `${flat.slice(0, room - 1)}…`;
}

/** The process-task tools, bound to one store and this session's templates. */
export function processTaskTools(
  tasks: ProcessTasks,
  templates: ReadonlyMap<string, CommandTemplate> = new Map(),
): ToolDefinition[] {
  const run: ToolDefinition<typeof RunParameters> = {
    name: "bg_run",
    label: "Run in background",
    description: runDescription(templates),
    parameters: RunParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Resolve the template before any store call: an unknown name must not
      // leave a task behind, and an explicit field on the call wins over the
      // template's value. `env` is deliberately never templated.
      const template = params.template === undefined ? undefined : templates.get(params.template);
      if (params.template !== undefined && template === undefined) {
        const known = [...templates.keys()].sort();
        // The error is read in context too, so it lists the first names and says
        // how many there are instead of dumping a large file.
        const shownNames = known.slice(0, 20).map((name) => JSON.stringify(name));
        const list =
          known.length === 0
            ? "(none)"
            : known.length <= 20
              ? shownNames.join(", ")
              : `${shownNames.join(", ")}, … (${String(known.length)} in total)`;
        return text(
          `Unknown template ${JSON.stringify(params.template)}. Known templates: ${list}. The task was not started. ${RELOAD_NOTE}`,
        );
      }

      const command = params.command ?? template?.command;
      if (command === undefined) {
        return text("Either command or template is required. The task was not started.");
      }
      const workingDirectory = params.cwd ?? template?.cwd;
      const timeoutSeconds = params.timeoutSeconds ?? template?.timeoutSeconds;

      // A bad runtime is reported before anything is spawned: a task that can
      // never be capped is worse than a rejected request.
      let timeoutMs: number | undefined;
      if (timeoutSeconds !== undefined) {
        try {
          timeoutMs = parseTimeoutSeconds(timeoutSeconds);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return text(`${reason} The task was not started.`);
        }
      }
      let task: ProcessTask;
      try {
        task = await tasks.start({
          ...scopeOf(ctx),
          command,
          ...(params.name === undefined ? {} : { name: params.name }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(params.shell === undefined ? {} : { shell: params.shell }),
          ...(workingDirectory === undefined ? {} : { workingDirectory }),
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
              `Read its output with bg_logs id=${task.id}, search it with bg_grep id=${task.id}, check it with bg_status id=${task.id}.`,
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
      "Return the tail of a background task's output, stdout and stderr in emission order. Ask again while it runs to see more, or pass `follow` to get only what arrived since the previous follow call.",
    parameters: LogsParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.follow === true) {
        const windowMs = parseFollowSeconds(params.timeoutSeconds);
        const followed = await tasks.follow(scopeOf(ctx), params.id.trim(), windowMs);
        if (followed === undefined) {
          return text(`No background task with id ${params.id} in this session.`);
        }

        const { view } = followed;
        const note = followed.finished
          ? "the task has finished; nothing more will arrive"
          : followed.timedOut
            ? `no new output in ${formatDuration(windowMs)}; the task is still running`
            : `followed ${formatBytes(followed.deltaBytes)}`;
        const header = [
          `name: ${view.task.name} · ${view.task.id} · ${view.task.kind} · ${view.task.status}`,
          `elapsed ${formatDuration(view.elapsedMs)} · output ${formatBytes(view.outputBytes)} · follow`,
          note,
        ].join("\n");
        const delta = followed.delta.length > 0 ? followed.delta : "(no new output)";
        return {
          content: [{ type: "text", text: `${header}\n\n${delta}` }],
          details: {
            id: view.task.id,
            status: view.task.status,
            follow: true,
            from: followed.from,
            offset: followed.offset,
            deltaBytes: followed.deltaBytes,
            finished: followed.finished,
            timedOut: followed.timedOut,
          },
        };
      }

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
  const grep: ToolDefinition<typeof GrepParameters> = {
    name: "bg_grep",
    label: "Search background task output",
    description:
      "Search a background task's whole output file for a plain substring and return only the matching lines, each prefixed with its line number. Case is ignored unless `ignoreCase` is false. The answer is bounded in lines and bytes, and it says how many matches it left out.",
    parameters: GrepParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = params.id.trim();
      if (id.length === 0) {
        return text("Pass the id of the task to search; bg_status lists the ids of this session.");
      }
      if (params.pattern.length === 0) {
        return text(
          "Pass the text to look for. bg_grep matches a plain substring, and an empty one would match every line.",
        );
      }

      const view = await tasks.get(scopeOf(ctx), id);
      if (view === undefined) {
        return text(`No background task with id ${id} in this session.`);
      }

      const ignoreCase = params.ignoreCase !== false;
      const maxMatches = clampSearchMatches(params.maxMatches);
      const header = [
        `name: ${view.task.name} · ${view.task.id} · ${view.task.kind} · ${view.task.status}`,
        `elapsed ${formatDuration(view.elapsedMs)} · output ${formatBytes(view.outputBytes)} · ${
          ignoreCase ? "case-insensitive" : "case-sensitive"
        } search for ${patternPreview(params.pattern)}`,
      ].join("\n");
      // The cap covers the whole answer, so the header and the trailer are paid
      // for first and only what is left goes to the match list.
      const room = GREP_RESULT_BYTES - Buffer.byteLength(header) - GREP_TRAILER_BYTES;
      const search = await searchOutputFile(view.task.outputPath, {
        pattern: params.pattern,
        ignoreCase,
        maxMatches,
        maxBytes: Math.max(1, room),
        // Every caller in production reads the host's output files, so the host
        // is the fallback encoding. A test needing another one calls the reader.
        platform: process.platform,
      });
      const details = {
        id: view.task.id,
        status: view.task.status,
        pattern: params.pattern,
        ignoreCase,
        maxMatches,
        matches: search.matches.length,
        total: search.total,
        omitted: search.omitted,
        scannedLines: search.scannedLines,
        clipped: search.clipped,
        outputBytes: view.outputBytes,
      };

      const body = search.matches.map((match) => `${String(match.line)}: ${match.text}`).join("\n");
      if (body.length === 0) {
        // An empty string would read as "nothing to say"; a search owes a verdict.
        // The two verdicts differ: nothing matched, or the header ate the budget.
        const verdict =
          search.total === 0
            ? `No matches for ${patternPreview(params.pattern)} in ${lineCount(search.scannedLines)} of output.`
            : `Found ${lineCount(search.total)} matching lines, but none fit in this answer's byte budget.`;
        return {
          content: [{ type: "text", text: `${header}\n\n${verdict}` }],
          details,
        };
      }

      const trailer = search.omitted > 0 ? `… ${String(search.omitted)} more matches` : "";
      return {
        content: [
          {
            type: "text",
            text: [header, "", body, ...(trailer.length > 0 ? ["", trailer] : [])].join("\n"),
          },
        ],
        details,
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

  return [run, status, logs, grep, kill, wait];
}
