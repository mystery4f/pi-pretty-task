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
import { readOutputTail } from "../tasks/base/output.js";
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
    `${details.name} finished`,
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
  lines.push(`read more: bg_logs id=${details.id}`);
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
    { deliverAs: "followUp", triggerTurn: true },
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
    lines.push(theme.fg("dim", `… older output left out — bg_logs id=${details.id}`));
  }
  return new Text(lines.join("\n"), 0, 0);
};
