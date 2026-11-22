/**
 * The completion notice: one session message per finished task, so a task that
 * ends finds the user instead of waiting to be polled.
 *
 * The message is sent as a follow-up with `triggerTurn`, so it reaches the
 * transcript through the normal delivery path and the model can act on it.
 * Everything the notice says lives in `details`; the renderer draws those
 * facts and never parses the prose.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatDuration } from "../tasks/base/format.js";
import { readOutputFrom, readOutputTail } from "../tasks/base/output.js";
import type { TaskKind, TaskStatus } from "../tasks/base/task.js";
import type { ProcessTaskView } from "../tasks/process/process-tasks.js";
import { STATUS_COLOUR } from "./status-colour.js";

/** Custom message type the completion renderer is registered under. */
export const TASK_FINISHED_CUSTOM_TYPE = "task-finished";

/**
 * Trailing output lines quoted in a notice. Deliberately fewer than the panel's
 * detail view (#10): a scrollback message should read at a glance.
 */
export const NOTICE_OUTPUT_LINES = 8;

/** What a completion notice carries, whatever kind of task ended. */
export interface FinishedTaskDetails {
  readonly id: string;
  readonly name: string;
  readonly kind: TaskKind;
  readonly status: TaskStatus;
  /** Milliseconds from start to end. */
  readonly durationMs: number;
  /** Process tasks: the exit code, or null when a signal ended the task. */
  readonly exitCode?: number | null;
  /** Why the task ended abnormally, when the record knows: a kill or a failure. */
  readonly reason?: string;
  /** Process tasks: the trailing output the notice quotes. */
  readonly outputTail?: string;
  /** True when older output was left out of the tail. */
  readonly outputTruncated?: boolean;
}

/** The message body a notice sends: facts, plus the same facts as prose. */
export interface FinishedTaskMessage {
  readonly content: string;
  readonly details: FinishedTaskDetails;
}

/** Non-empty trailing lines of an output tail, newest last. */
function tailLines(text: string | undefined): string[] {
  if (text === undefined || text.trim().length === 0) return [];
  return text.replace(/\n+$/, "").split("\n");
}

/** The prose the model reads: the same facts as the renderer draws. */
function noticeText(details: FinishedTaskDetails): string {
  const lines = [
    `name: ${details.name}`,
    `id: ${details.id}`,
    `kind: ${details.kind}`,
    `status: ${details.status}`,
    `duration: ${formatDuration(details.durationMs)}`,
  ];
  if (details.exitCode !== undefined && details.exitCode !== null) {
    lines.push(`exit code: ${details.exitCode}`);
  }
  if (details.reason !== undefined) lines.push(`reason: ${details.reason}`);
  const tail = tailLines(details.outputTail);
  if (tail.length > 0) {
    lines.push("last output:");
    for (const line of tail) lines.push(`  ${line}`);
  }
  lines.push(`read more: pretty_task_bg_logs id=${details.id}`);
  return lines.join("\n");
}

/** Build the notice for one finished task. Pure, so tests can drive any status. */
export function finishedTaskMessage(details: FinishedTaskDetails): FinishedTaskMessage {
  return { content: noticeText(details), details };
}

async function describeFinishedTask(view: ProcessTaskView): Promise<FinishedTaskDetails> {
  const details: FinishedTaskDetails = {
    id: view.task.id,
    name: view.task.name,
    kind: view.task.kind,
    status: view.task.status,
    durationMs: view.elapsedMs,
    exitCode: view.task.exitCode,
    // A killed task carries no error by design, so the kill reason is the answer.
    reason: view.task.killReason ?? view.task.error,
  };
  try {
    const tail = await readOutputTail(view.task.outputPath, { lines: NOTICE_OUTPUT_LINES });
    return { ...details, outputTail: tail.text, outputTruncated: tail.truncated };
  } catch {
    // Unreadable output must not cost the user the notice that points at it.
    return details;
  }
}

/** Announce one finished task in the session. */
export async function notifyTaskFinished(pi: ExtensionAPI, view: ProcessTaskView): Promise<void> {
  const message = finishedTaskMessage(await describeFinishedTask(view));
  pi.sendMessage(
    {
      customType: TASK_FINISHED_CUSTOM_TYPE,
      content: message.content,
      display: true,
      details: message.details,
    },
    // `steer`, not `followUp`: a follow-up queued while a run is in flight is
    // delivered when the agent goes idle, and a user prompt arriving in that same
    // instant wins the race and takes the notice with it (ADR-0021). Steering puts
    // the ending in front of the next model call, which is the moment it matters.
    { deliverAs: "steer", triggerTurn: true },
  );
}

/**
 * Draws one completion notice. Facts come from `details`, colour from the
 * theme, so this stays readable under any palette and never shows raw JSON.
 */
export const renderTaskFinished: MessageRenderer<FinishedTaskDetails> = (
  message,
  _options,
  theme,
) => {
  const details = message.details;
  if (details === undefined) return undefined;
  const colour = STATUS_COLOUR[details.status];
  const header = [
    theme.fg(colour, `● ${details.status}`),
    theme.bold(details.name),
    theme.fg("muted", `(${details.id})`),
    theme.fg("muted", `· ${details.kind} · ${formatDuration(details.durationMs)}`),
  ].join(" ");
  const lines = [header];
  if (details.exitCode !== undefined && details.exitCode !== null) {
    lines.push(theme.fg(colour, `exit code: ${details.exitCode}`));
  }
  // The reason wears the ending's colour: a kill reads as a warning, a failure as an error.
  if (details.reason !== undefined) lines.push(theme.fg(colour, details.reason));
  const tail = tailLines(details.outputTail);
  if (tail.length > 0) {
    lines.push(theme.fg("muted", "last output:"));
    for (const line of tail) lines.push(theme.fg("dim", `  ${line}`));
  }
  if (details.outputTruncated === true) {
    lines.push(theme.fg("dim", `… older output left out — pretty_task_bg_logs id=${details.id}`));
  }
  return new Text(lines.join("\n"), 0, 0);
};

/** Custom message type a signalled fire's notice is registered under. */
export const LOOP_SIGNAL_CUSTOM_TYPE = "loop-signal";

/**
 * Leading output lines a signal notice quotes. A check's report opens with its
 * findings, so the head is the part worth reading; the rest stays in the file.
 */
export const SIGNAL_OUTPUT_LINES = 10;

/** What a signal notice carries: the loop, the fire and the head of its report. */
export interface LoopSignalDetails {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  /** One-based fire number of the loop, the same number the child process carries. */
  readonly fire: number;
  /** The exit code the loop declared as a signal. */
  readonly exitCode?: number | null;
  /** Milliseconds the fire ran. */
  readonly durationMs: number;
  /** Epoch milliseconds the fire ended. */
  readonly endedAt: number;
  /** The fire's own report, first lines only. */
  readonly outputHead?: string;
  /** Lines the fire wrote, so a cut report says how much it left out. */
  readonly outputLines?: number;
  /** Output file of the fire, for the lines the notice does not quote. */
  readonly outputPath?: string;
}

/** The prose the model reads: the same facts the renderer draws. */
function signalText(details: LoopSignalDetails): string {
  const lines = [
    `name: ${details.name}`,
    `id: ${details.id}`,
    "kind: cmd-loop",
    `fire: #${String(details.fire)} signalled at ${new Date(details.endedAt).toISOString()}`,
  ];
  if (details.exitCode !== undefined && details.exitCode !== null) {
    lines.push(`exit code: ${String(details.exitCode)}`);
  }
  lines.push(`ran for: ${formatDuration(details.durationMs)}`);
  const head = tailLines(details.outputHead);
  if (head.length > 0) {
    const total = details.outputLines ?? head.length;
    lines.push(`report (${String(head.length)} of ${String(total)} lines):`);
    for (const line of head) lines.push(`  ${line}`);
  }
  if (details.outputPath !== undefined) lines.push(`full output: ${details.outputPath}`);
  lines.push(`read more: pretty_task_loop_list id=${details.id}`);
  return lines.join("\n");
}

/**
 * The report a check produced: its leading lines and how many it wrote. Reading
 * the whole file is what makes the total honest, and a report is bounded by the
 * output cap; an unreadable file costs the notice its quote, not its existence.
 */
async function readSignalReport(
  path: string | undefined,
): Promise<Pick<LoopSignalDetails, "outputHead" | "outputLines">> {
  if (path === undefined) return {};
  try {
    const { text } = await readOutputFrom(path, 0);
    const all = tailLines(text);
    return {
      outputHead: all.slice(0, SIGNAL_OUTPUT_LINES).join("\n"),
      outputLines: all.length,
    };
  } catch {
    return {};
  }
}

/**
 * Announce one signalled fire. A signal is the check speaking, not the loop
 * breaking, so this message carries no failure vocabulary (ADR-0018).
 */
export async function notifyLoopSignal(
  pi: ExtensionAPI,
  details: LoopSignalDetails,
): Promise<void> {
  const report = await readSignalReport(details.outputPath);
  const message = { ...details, ...report };
  pi.sendMessage(
    {
      customType: LOOP_SIGNAL_CUSTOM_TYPE,
      content: signalText(message),
      display: true,
      details: message,
    },
    { deliverAs: "followUp", triggerTurn: true },
  );
}

/** Draws one signal notice: the check's report, never a failure badge. */
export const renderLoopSignal: MessageRenderer<LoopSignalDetails> = (message, _options, theme) => {
  const details = message.details;
  if (details === undefined) return undefined;
  const header = [
    theme.fg("warning", "⚑ signalled"),
    theme.bold(details.name),
    theme.fg("muted", `(${details.id})`),
    theme.fg("muted", `· fire #${String(details.fire)} · ${formatDuration(details.durationMs)}`),
  ].join(" ");
  const lines = [header];
  if (details.exitCode !== undefined && details.exitCode !== null) {
    lines.push(theme.fg("muted", `exit code: ${String(details.exitCode)}`));
  }
  const head = tailLines(details.outputHead);
  if (head.length > 0) {
    const total = details.outputLines ?? head.length;
    lines.push(theme.fg("muted", `report (${String(head.length)} of ${String(total)} lines):`));
    for (const line of head) lines.push(theme.fg("dim", `  ${line}`));
  }
  if (details.outputPath !== undefined) {
    lines.push(theme.fg("dim", `full output: ${details.outputPath}`));
  }
  return new Text(lines.join("\n"), 0, 0);
};
