/**
 * `pretty_task_loop_create`, `pretty_task_loop_list`, `pretty_task_loop_update` and `pretty_task_loop_delete`: what the agent
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
import { fireLabel, formatBytes, formatDuration } from "../base/format.js";
import type { TaskScope } from "../base/runtime-state.js";
import type { CmdLoopTask, FireRecord, PromptLoopTask } from "../base/task.js";
import { iterationVerdict } from "./iteration.js";
import {
  LoopInputError,
  type LoopTasks,
  type LoopTaskView,
  type LoopUpdateResult,
} from "./loop-tasks.js";

const CreateParameters = Type.Object({
  schedule: Type.String({
    description:
      "When to fire: interval shorthand such as 30s, 10m or 2h (seconds allowed), or a five-field cron expression in local time such as 0 9 * * 1-5 (minute hour day-of-month month day-of-week; * every, 1-5 ranges, 9,17 lists, */15 steps). Weekdays: 0-6 start on Sunday and 7 is Sunday too. A day-of-month and a day-of-week both given fire on either match; when only one is given it must match. Six fields are refused: use the shorthand for second-level timing.",
  }),
  prompt: Type.Optional(
    Type.String({
      description:
        "Message sent into the session each time the loop fires; it starts a new turn. It is saved as the loop's prompt file, and every fire reads that file, so editing it changes what the loop says without recreating the loop. Give this or `command`, never both.",
    }),
  ),
  command: Type.Optional(
    Type.String({
      description:
        "Shell command to run as a background process on each fire, exactly like pretty_task_bg_run. Give this or `prompt`, never both. A fire that comes due while the previous one still runs is skipped and shown as skipped, not started twice.",
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
  notifyExitCodes: Type.Optional(
    Type.Array(Type.Integer({ minimum: 1, maximum: 255 }), {
      description:
        "Exit codes that mean `the check has something to report`, not `the loop is broken`, for example [1]. A fire with one of them is recorded as signalled: it wakes this session once per raised condition, keeps its schedule and never backs off; a later success clears the signal. Exit 0 is always success. Only valid with `command`.",
    }),
  ),
  wakeOnFailure: Type.Optional(
    Type.Boolean({
      description:
        "Send a notice into this session when a fire fails (exit code, duration, last output lines); a healthy fire stays silent. Defaults to true. A fire whose exit code is listed in `notifyExitCodes` is a signal rather than a failure and wakes the session either way. Only valid with `command`.",
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
    Type.Union(
      [
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("complete"),
        Type.Literal("rearm"),
        Type.Literal("clear-signal"),
      ],
      {
        description:
          "pause stops fires but keeps the record; resume re-arms from now; complete ends the loop; rearm recomputes the next fire from now on the unchanged schedule (the way back onto a slot after a backoff or a resume pushed it late); clear-signal drops an outstanding signal without waiting for a healthy round, and is only meaningful on a command loop that declared notifyExitCodes. Omit it to change only the schedule or the prompt.",
      },
    ),
  ),
  schedule: Type.Optional(
    Type.String({
      description:
        "New schedule for the same loop, in the forms pretty_task_loop_create accepts. The loop keeps its id, fire count and every recorded iteration; a running loop is re-armed from this update, never from the slot the old schedule had picked. An invalid expression is refused and the old schedule stays in force.",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "New text for a prompt loop to send on every fire, replacing what its prompt file holds now. This is how to refine the wording: the loop keeps its id, fire count and every recorded iteration, and the prompt given at create time stays the seed it falls back to. Only for a prompt loop (a command loop runs no prompt), and the text cannot be blank. If the file cannot be written, the old text stays in place and the reply says so.",
    }),
  ),
});

const DeleteParameters = Type.Object({
  id: Type.String({ description: "Loop id to delete." }),
});

const FireParameters = Type.Object({
  id: Type.String({ description: "Command loop id to fire now." }),
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
  lines.push(task.kind === "prompt-loop" ? iterationSummary(task) : fireSummary(task));
  if (task.expiresAt !== undefined) {
    lines.push(`expires: ${new Date(task.expiresAt).toISOString()}`);
  }
  if (task.endedAt !== undefined) {
    lines.push(`ended: ${new Date(task.endedAt).toISOString()}`);
  }
  if (task.error !== undefined) lines.push(`error: ${task.error}`);
  if (task.kind === "prompt-loop") {
    // The file, not the record: the record keeps the text the loop was created
    // with, while the file is what every fire reads (ADR-0024).
    if (view.promptFile !== undefined) lines.push(`prompt file: ${view.promptFile}`);
    if (task.promptWarning !== undefined) lines.push(`prompt warning: ${task.promptWarning}`);
  } else {
    if (task.cwd !== undefined) lines.push(`cwd: ${task.cwd}`);
    if (task.wakeOnFailure === false) lines.push("wake on failure: off");
    if (task.notifyExitCodes !== undefined && task.notifyExitCodes.length > 0) {
      const codes = task.notifyExitCodes.map((code) => `exit ${String(code)}`).join(", ");
      lines.push(`signal on: ${codes}`);
      const since =
        task.signalRaisedAt === undefined
          ? ""
          : ` since ${new Date(task.signalRaisedAt).toISOString()}`;
      lines.push(`latch: ${task.signalRaised === true ? "raised" : "clear"}${since}`);
    }
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
function iterationSummary(task: PromptLoopTask): string {
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
 * expands to, so a caller reading `pretty_task_loop_list id=…` sees what the user sees.
 * A trimmed record says how many older fires it dropped.
 */
export function describeFires(task: CmdLoopTask): string {
  const dropped = Math.max(0, task.fires - task.fireHistory.length);
  if (task.fireHistory.length === 0) {
    return dropped > 0
      ? `No fire recorded; ${String(dropped)} older ones were dropped.`
      : "No fire yet: this loop has not fired.";
  }

  const rows = [...task.fireHistory].toReversed().map((fire) => {
    const time = fire.at === undefined ? undefined : new Date(fire.at).toISOString();
    const head = [fireLabel(fire.fire), time, fire.outcome]
      .filter((part) => part !== undefined)
      .join(" · ");
    return `${head}${fireMeta(fire)}`;
  });
  if (dropped > 0) rows.push(`… ${String(dropped)} older`);
  return rows.join("\n");
}

/**
 * The iteration listing for one loop, newest first, with the tool calls each turn
 * made. This is the listing `pretty_task_loop_list id=…` returns and the panel (#9) draws:
 * an iteration is reachable from the loop, never as a row of its own (ADR-0002).
 * A truncated record says how much it dropped rather than hiding it.
 */
export function describeIterations(task: PromptLoopTask): string {
  if (task.iterations.length === 0) {
    return task.droppedIterations === undefined || task.droppedIterations === 0
      ? "No iteration yet: this loop has not fired."
      : `No iteration recorded; ${String(task.droppedIterations)} older ones were dropped.`;
  }

  return [...task.iterations]
    .toReversed()
    .map((iteration) => {
      const head = [
        `fire ${String(iteration.fire)}`,
        iterationVerdict(iteration),
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
  if (task.kind === "prompt-loop") {
    return {
      ...shared,
      // The record keeps the seed; promptFile is what every fire actually reads
      // (ADR-0024), so the two can differ once the file has been edited.
      prompt: task.prompt,
      promptFile: view.promptFile,
      promptWarning: task.promptWarning,
      iterationCount: task.iterations.length,
      droppedIterations: task.droppedIterations,
      lastError: task.lastError,
      lastFailureAt: task.lastFailureAt,
      ...(options.iterations === true ? { iterations: task.iterations } : {}),
    };
  }
  return {
    ...shared,
    command: task.command,
    cwd: task.cwd,
    wakeOnFailure: task.wakeOnFailure,
    notifyExitCodes: task.notifyExitCodes,
    signalRaised: task.signalRaised,
    signalRaisedAt: task.signalRaisedAt,
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
  // pi-lens-ignore: switch-without-default -- exhaustive over the closed outcome union; a default would hide a new outcome from the compiler
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
    case "rearmed":
      return `Realigned loop ${id} (${name}); its next fire is ${nextFireText(result.view)}.`;
    case "signal-cleared":
      return `Cleared the signal on loop ${id} (${name}); the next fire that reports again raises it.`;
    case "no-signal":
      return `Loop ${id} had no signal to clear.`;
    case "failed":
      return `Loop ${id} could not be resumed: ${result.view.task.error ?? "invalid schedule"}.`;
    case "prompt-updated": {
      // What the loop "now sends" depends on whether it can still fire: a finished
      // loop never reads the file again, so promising a fire would describe an event
      // that cannot happen (the same reply would say "its next fire is none").
      const replaced = `Rewrote the prompt of loop ${id} (${name})`;
      const status = result.view.task.status;
      if (status === "running") {
        return `${replaced}; its next fire is ${nextFireText(result.view)}.`;
      }
      if (status === "paused") return `${replaced}; it stays paused until resumed.`;
      return `${replaced}; the loop is ${status} and will not fire again, so only its prompt file changed.`;
    }
    case "prompt-write-failed":
      return `Could not replace the prompt of loop ${id} (${name}); its prompt file still holds the previous text.`;
  }
}

/**
 * What an update did with the text it was given, in the words the caller needs to know
 * whether every fire will now read the new wording. Absent when the call carried no
 * prompt, because then nothing happened to the file worth a line.
 */
function describePromptWrite(result: LoopUpdateResult): string | undefined {
  const write = result.promptWrite;
  if (write === undefined) return undefined;
  const path = result.view.promptFile ?? "the prompt file";
  if (write.outcome === "failed") {
    return `prompt text: not replaced (${write.error}); ${path} still holds the previous text.`;
  }
  return [
    `prompt text: replaced — ${path} now holds the new wording, and every fire reads it from there.`,
    "The prompt given at create time stays the record's seed, so it is still what restores the file if it is ever lost.",
  ].join("\n");
}

/** The loop-task tools, bound to one store. */
export function loopTaskTools(loops: LoopTasks): ToolDefinition[] {
  const create: ToolDefinition<typeof CreateParameters> = {
    name: "pretty_task_loop_create",
    label: "Create a loop",
    description:
      "Schedule something to happen on a recurrence. With `prompt`, each fire sends that message into this session and starts a new agent turn; the wake is delivered when the agent is idle, so a busy agent delays it instead of losing it. With `command`, each fire runs that shell command as an ordinary background process task (like pretty_task_bg_run) and nothing is sent into the session unless the fire fails and wakeOnFailure is on, or its exit code is one of `notifyExitCodes` (a signal: it wakes once per raised condition and keeps its schedule); a fire that comes due while the previous one still runs is skipped and recorded as skipped. A fire that fails backs the schedule off: its next fire moves later, doubling on each consecutive failure up to one hour, and the first success puts it back on the slot — so a loop that keeps failing runs less often than its expression says. Give exactly one of prompt and command. The schedule is an interval (30s, 10m, 2h) or a five-field cron expression in local time (0 9 * * 1-5). Use pretty_task_loop_list to watch it and pretty_task_loop_delete to stop it.",
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
          ...(params.notifyExitCodes === undefined
            ? {}
            : { notifyExitCodes: params.notifyExitCodes }),
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
                `Watch it with pretty_task_loop_list id=${view.task.id}; pause it with pretty_task_loop_update id=${view.task.id} action=pause.`,
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
    name: "pretty_task_loop_list",
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
                view.task.kind === "prompt-loop"
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
        return text("No loops in this session yet. Create one with pretty_task_loop_create.", {
          loops: [],
        });
      }
      return {
        content: [{ type: "text", text: all.map((view) => describeLoop(view)).join("\n\n") }],
        details: { loops: all.map((view) => loopDetails(view)) },
      };
    },
  };

  const update: ToolDefinition<typeof UpdateParameters> = {
    name: "pretty_task_loop_update",
    label: "Pause, resume, complete, retune or reword a loop",
    description:
      "Change a loop without deleting its history: pause stops fires, resume re-arms from now, complete ends it, and schedule retunes when it fires. A retune keeps the id, the fire count and every recorded iteration; a running loop's next fire is computed from this update rather than from the slot the old schedule had already picked, a paused loop keeps the new schedule and arms onto it when resumed, and an invalid expression is refused with the old schedule still in force. action=rearm does the same arithmetic without changing the expression, which is the way back onto a slot after a failure or a resume pushed the next fire late; action=clear-signal drops an outstanding signal on a command loop that declared notifyExitCodes, so a condition you have already dealt with stops muting the next report. Both keep the id, the fire count and every iteration. Pausing or completing also cancels a wake that is still waiting for the agent to be idle, so the loop will not wake the model after you stop it. prompt replaces the text a prompt loop sends on every fire, which is the way to refine its wording without deleting the loop: the id, the fire count and every recorded iteration survive, and the text given at create time stays the seed the file falls back to. A prompt only fits a prompt loop; if its file cannot be written the old text stays in place and the reply says so.",
    parameters: UpdateParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = params.id.trim();
      if (id.length === 0) {
        return text(
          "Pass the id of the loop to update; pretty_task_loop_list lists the ids of this session.",
        );
      }

      // A retune, a transition and a new prompt may arrive together, and the store
      // applies them in one fixed order: the schedule is retimed first, then the
      // prompt file is written, then the action is applied, so `resume` with a new
      // schedule already lands on the new interval.
      const input = {
        ...scopeOf(ctx),
        id,
        ...(params.action === undefined ? {} : { action: params.action }),
        ...(params.schedule === undefined ? {} : { schedule: params.schedule }),
        ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
      };
      try {
        const result = await loops.update(input);
        if (result === undefined) {
          return text(`No loop with id ${id} in this session.`);
        }
        const promptLine = describePromptWrite(result);
        return {
          content: [
            {
              type: "text",
              text: [
                updateHeadline(id, result),
                "",
                describeLoop(result.view),
                ...(promptLine === undefined ? [] : ["", promptLine]),
              ].join("\n"),
            },
          ],
          details: {
            ...loopDetails(result.view),
            outcome: result.outcome,
            ...(result.promptWrite === undefined ? {} : { promptWrite: result.promptWrite }),
          },
        };
      } catch (error) {
        if (error instanceof LoopInputError) return inputError(error);
        throw error;
      }
    },
  };

  const fire: ToolDefinition<typeof FireParameters> = {
    name: "pretty_task_loop_fire",
    label: "Fire a command loop now",
    description:
      "Run one fire of a command loop right now instead of waiting for its slot: the way to test a command without paying a schedule slot and a backoff. The fire goes into the loop's history as `m1`, `m2`, … with its own output file; it takes no fire number from the schedule, does not move the next fire time, and leaves the failure streak and any outstanding signal exactly as they were. Only a command loop can be fired this way, and only while it is running or paused.",
    parameters: FireParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = params.id.trim();
      if (id.length === 0) {
        return text(
          "Pass the id of the loop to fire; pretty_task_loop_list lists the ids of this session.",
        );
      }

      try {
        const view = await loops.fireNow({ ...scopeOf(ctx), id });
        if (view === undefined) return text(`No loop with id ${id} in this session.`);
        const started = view.task.kind === "cmd-loop" ? view.task.fireHistory.at(-1) : undefined;
        const label = started === undefined ? "a fire" : fireLabel(started.fire);
        return {
          content: [
            {
              type: "text",
              text: [
                `Fired loop ${id} (${view.task.name}) by hand as ${label}; it is not one of the schedule's fires.`,
                `The fire keeps its own output file, and pretty_task_loop_list id=${id} shows how it ended.`,
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

  const remove: ToolDefinition<typeof DeleteParameters> = {
    name: "pretty_task_loop_delete",
    label: "Delete a loop",
    description:
      "Delete a loop record and stop its schedule. Use pretty_task_loop_update action=complete instead when the history should remain.",
    parameters: DeleteParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = params.id.trim();
      if (id.length === 0) {
        return text(
          "Pass the id of the loop to delete; pretty_task_loop_list lists the ids of this session.",
        );
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

  return [create, list, update, fire, remove];
}
