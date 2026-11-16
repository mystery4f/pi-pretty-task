/**
 * The task detail: one record opened onto its numbers, its output tail, its fires
 * or the tool calls one iteration made. Pure drawing over the panel's state — the
 * tail is read by the panel and handed in, so nothing here touches a file.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatBytes, formatClockTime, formatDuration } from "../../tasks/base/format.js";
import type { IterationCall } from "../../tasks/loop/iteration.js";
import { STATUS_COLOUR } from "../status-colour.js";
import {
  CALL_COLOUR,
  callsHeading,
  callsText,
  callTopFor,
  failureStreak,
  fireLine,
  firesHeading,
  firesText,
  formatSize,
  ITERATION_COLOUR,
  isCommandCall,
  iterationLine,
  iterationsText,
  missedText,
  nextFireText,
  STEP_MARK,
  singleLine,
  stepColour,
} from "./format.js";
import { fittedFooter, PROCESS_KEYS, pad } from "./keys.js";
import { chainPlace, foreign, renderList, stepRecord } from "./list.js";
import {
  DETAIL_OUTPUT_LINES,
  LABEL_WIDTH,
  LIST_VISIBLE_ROWS,
  type PanelTaskView,
} from "./model.js";
import type { TasksPanel } from "./tasks-panel.js";

export function renderDetail(panel: TasksPanel, width: number): string[] {
  const row = panel.detailRow();
  if (row === undefined) return renderList(panel, width);
  if (row.task.kind === "prompt-loop") return renderLoopDetail(panel, row, width);
  if (row.task.kind === "cmd-loop") return renderCommandLoopDetail(panel, row, width);
  if (row.task.kind === "chain") return renderChainDetail(panel, row, width);
  return renderProcessDetail(panel, width);
}

export function renderChainDetail(panel: TasksPanel, row: PanelTaskView, width: number): string[] {
  const theme = panel.theme;
  const task = row.task;
  if (task.kind !== "chain") return renderList(panel, width);
  const colour = STATUS_COLOUR[task.status];
  const done = task.steps.filter((id) => stepRecord(panel, id)?.status === "completed").length;
  const body: string[] = [
    field(panel, "Name", theme.fg("accent", task.name)),
    field(panel, "ID", theme.fg("accent", task.id)),
    ...sessionField(panel, row),
    field(panel, "Status", theme.fg(colour, task.status)),
    field(panel, "Runtime", formatDuration(row.elapsedMs)),
    field(panel, "Updated", updatedText(panel, task.updatedAt)),
    field(
      panel,
      "Steps",
      `${String(done)} of ${String(task.steps.length)} done · ${chainPlace(panel, task)}`,
    ),
  ];
  if (task.endedAt !== undefined) {
    body.push(field(panel, "Ended", formatClockTime(task.endedAt)));
  }
  if (task.killReason !== undefined) body.push(field(panel, "Kill reason", task.killReason));
  if (task.error !== undefined) body.push(field(panel, "Error", theme.fg(colour, task.error)));

  body.push("", theme.fg("muted", ` Steps, in run order (${String(task.steps.length)}):`));
  if (task.steps.length === 0) {
    body.push(theme.fg("dim", "  no step queued yet"));
  }
  const room = Math.max(20, width - 4);
  task.steps.forEach((id, index) => {
    const step = stepRecord(panel, id);
    const status = step?.status ?? "waiting";
    const marker = index === task.cursor ? theme.fg("accent", "›") : " ";
    const mark = theme.fg(stepColour(status), STEP_MARK[status]);
    const name = `${String(index + 1)}. ${step?.name ?? id}`;
    // A step that has not run yet has no duration of its own, and a bare dash says
    // that more honestly than the wait since it was queued does.
    const duration =
      step === undefined || status === "waiting"
        ? "—"
        : formatDuration(Math.max(0, (step.endedAt ?? panel.now()) - step.createdAt));
    const code =
      step?.kind === "process" && step.exitCode !== undefined && step.exitCode !== null
        ? `exit ${String(step.exitCode)}`
        : "";
    const line = `${marker} ${mark} ${pad(name, 20)} ${pad(status, 10)} ${pad(duration, 6)} ${code}`;
    body.push(`${truncateToWidth(line.trimEnd(), room, "…", false)}  ${theme.fg("dim", id)}`);
  });

  if (panel.notice !== undefined) body.push(theme.fg("warning", `  ${panel.notice}`));
  return panel.frame(
    `chain: ${task.name}`,
    `${task.id} · ${task.status} · ${chainPlace(panel, task)}`,
    body,
    "← list · k stop from the running step · alt+q close",
    width,
  );
}

export function renderProcessDetail(panel: TasksPanel, width: number): string[] {
  const theme = panel.theme;
  const row = panel.detailRow();
  if (row === undefined || row.task.kind !== "process") return renderList(panel, width);
  const task = row.task;
  const colour = STATUS_COLOUR[task.status];
  const body: string[] = [
    field(panel, "Name", theme.fg("accent", task.name)),
    field(panel, "ID", theme.fg("accent", task.id)),
    ...sessionField(panel, row),
    field(panel, "Status", theme.fg(colour, task.status)),
    field(panel, "Runtime", formatDuration(row.elapsedMs)),
    field(panel, "Started", formatClockTime(task.createdAt)),
    field(panel, "Updated", updatedText(panel, task.updatedAt)),
    field(panel, "Output", task.outputPath),
    field(panel, "Size", formatSize(row)),
  ];
  if (task.endedAt !== undefined) {
    body.push(field(panel, "Ended", formatClockTime(task.endedAt)));
  }
  if (task.pid !== undefined) body.push(field(panel, "PID", String(task.pid)));
  body.push(field(panel, "Command", singleLine(task.command, Math.max(1, width - 14))));
  if (task.cwd !== undefined) body.push(field(panel, "CWD", task.cwd));
  if (task.exitCode !== undefined) {
    body.push(field(panel, "Exit code", theme.fg(colour, String(task.exitCode))));
  }
  if (task.killReason !== undefined) body.push(field(panel, "Kill reason", task.killReason));
  if (task.error !== undefined) body.push(field(panel, "Error", theme.fg(colour, task.error)));

  body.push(theme.fg("muted", " Output tail:"));
  body.push(...outputBox(panel, width - 2));
  body.push(theme.fg("dim", ` ${position(panel)}`));

  if (panel.notice !== undefined) body.push(theme.fg("warning", `  ${panel.notice}`));
  const live = task.status === "running" ? "live tail refreshes every second" : "final output";
  return panel.frame(
    `task: ${task.name}`,
    `${task.id} · ${task.status} · ${live}`,
    body,
    // The keys shed whole entries on a narrow terminal: the frame would otherwise
    // cut the last one in half and leave the border a column off (ticket #34).
    fittedFooter(PROCESS_KEYS, Math.max(1, width - 3)),
    width,
  );
}

export function outputBox(panel: TasksPanel, width: number): string[] {
  const theme = panel.theme;
  const inner = Math.max(1, width - 2);
  const edge = (glyph: string): string => theme.fg("borderAccent", glyph);
  const row = (content = ""): string => {
    const cut =
      visibleWidth(content) > inner ? truncateToWidth(content, inner, "…", false) : content;
    return `${edge("│")}${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))}${edge("│")}`;
  };
  const lines = [edge(`╭${"─".repeat(inner)}╮`)];
  if (panel.detailError !== undefined) {
    lines.push(row(theme.fg("error", ` output unavailable: ${panel.detailError}`)));
  } else if (panel.detailLines.length === 0) {
    lines.push(row(theme.fg("dim", " no output yet")));
  } else {
    const [from, to] = window(panel);
    for (const line of panel.detailLines.slice(from, to)) lines.push(row(` ${line}`));
    if (panel.detailTruncated) lines.push(row(theme.fg("dim", " … older output left out")));
  }
  // Keep the window the same height whatever the output does: a box that grows
  // and shrinks under the reader's eyes is harder to scan than an empty one.
  while (lines.length < DETAIL_OUTPUT_LINES + 1) lines.push(row());
  lines.push(edge(`╰${"─".repeat(inner)}╯`));
  return lines;
}

export function renderLoopDetail(panel: TasksPanel, row: PanelTaskView, width: number): string[] {
  const theme = panel.theme;
  const task = row.task;
  if (task.kind !== "prompt-loop") return renderList(panel, width);
  const colour = STATUS_COLOUR[task.status];
  const body: string[] = [
    field(panel, "Status", theme.fg(colour, task.status)),
    field(panel, "Kind", task.kind),
    ...sessionField(panel, row),
    field(panel, "Runtime", formatDuration(row.elapsedMs)),
    field(panel, "Updated", updatedText(panel, task.updatedAt)),
    field(panel, "Schedule", task.schedule),
    field(panel, "Fires", firesText(task)),
    field(panel, "Next fire", nextFireText(task, row)),
    field(
      panel,
      "Last fire",
      task.lastFireAt === undefined ? "—" : formatClockTime(task.lastFireAt),
    ),
  ];
  if (task.expiresAt !== undefined) {
    body.push(field(panel, "Expires", formatClockTime(task.expiresAt)));
  }
  if (task.endedAt !== undefined) {
    body.push(field(panel, "Ended", formatClockTime(task.endedAt)));
  }
  if (task.error !== undefined) body.push(field(panel, "Error", theme.fg(colour, task.error)));
  body.push(field(panel, "Prompt", singleLine(task.prompt, Math.max(1, width - 14))));
  body.push("", theme.fg("muted", iterationsText(task)));

  const newestFirst = [...task.iterations].reverse();
  if (newestFirst.length === 0) {
    body.push(theme.fg("dim", "  no iteration recorded yet"));
  } else {
    const selected = panel.currentIteration(task);
    const top = Math.min(
      Math.max(0, panel.iterationTop),
      Math.max(0, newestFirst.length - LIST_VISIBLE_ROWS),
    );
    const visible = newestFirst.slice(top, top + LIST_VISIBLE_ROWS);
    if (top > 0) body.push(theme.fg("dim", `  … ${String(top)} newer above`));
    for (const iteration of visible) {
      const marker = iteration.fire === selected?.fire ? theme.fg("accent", "›") : " ";
      const text = iterationLine(iteration);
      body.push(`${marker} ${truncateToWidth(text, Math.max(1, width - 4), "…", false)}`);
    }
    const below = newestFirst.length - top - visible.length;
    if (below > 0) body.push(theme.fg("dim", `  … ${String(below)} older below`));
  }

  if (panel.notice !== undefined) body.push(theme.fg("warning", `  ${panel.notice}`));
  return panel.frame(
    `loop: ${task.name}`,
    `${task.id} · ${task.status} · ${task.schedule}`,
    body,
    "↑/↓ select · Enter iteration · ← list · k stop · alt+q close",
    width,
  );
}

export function renderCommandLoopDetail(
  panel: TasksPanel,
  row: PanelTaskView,
  width: number,
): string[] {
  const theme = panel.theme;
  const task = row.task;
  if (task.kind !== "cmd-loop") return renderList(panel, width);
  const colour = STATUS_COLOUR[task.status];
  const envCount = Object.keys(task.env ?? {}).length;
  const body: string[] = [
    field(panel, "Status", theme.fg(colour, task.status)),
    field(panel, "Kind", task.kind),
    ...sessionField(panel, row),
    field(panel, "Runtime", formatDuration(row.elapsedMs)),
    field(panel, "Updated", updatedText(panel, task.updatedAt)),
    field(panel, "Schedule", task.schedule),
    field(panel, "Fires", `${firesText(task)}${missedText(task)}`),
    field(panel, "Next fire", nextFireText(task, row, failureStreak(task) > 0)),
    field(
      panel,
      "Last fire",
      task.lastFireAt === undefined ? "—" : formatClockTime(task.lastFireAt),
    ),
  ];
  // A streak explains why the next fire is later than the expression says, so
  // it sits with the schedule facts and never rewrites them (ADR-0017).
  const streak = failureStreak(task);
  if (streak > 0) body.push(field(panel, "Failures", `${String(streak)} in a row`));
  if (task.expiresAt !== undefined) {
    body.push(field(panel, "Expires", formatClockTime(task.expiresAt)));
  }
  if (task.endedAt !== undefined) {
    body.push(field(panel, "Ended", formatClockTime(task.endedAt)));
  }
  if (task.error !== undefined) body.push(field(panel, "Error", theme.fg(colour, task.error)));
  body.push(field(panel, "Command", singleLine(task.command, Math.max(1, width - 14))));
  if (task.cwd !== undefined) body.push(field(panel, "CWD", task.cwd));
  body.push(
    field(
      panel,
      "Env",
      envCount === 0 ? "—" : `${String(envCount)} variable${envCount === 1 ? "" : "s"}`,
    ),
  );
  body.push(field(panel, "Wake on failure", task.wakeOnFailure === false ? "off" : "on"));
  body.push(
    field(panel, "Last exit", task.lastExitCode === undefined ? "—" : String(task.lastExitCode)),
  );
  if (task.lastOutputPath !== undefined) {
    body.push(field(panel, "Last output", task.lastOutputPath));
  }
  body.push(
    field(
      panel,
      "Size",
      task.lastOutputBytes === undefined ? "—" : formatBytes(task.lastOutputBytes),
    ),
  );
  body.push("", theme.fg("muted", firesHeading(task)));

  const newestFirst = [...task.fireHistory].reverse();
  if (newestFirst.length === 0) {
    body.push(theme.fg("dim", "  no fire recorded yet"));
  } else {
    const selected = panel.currentFire(task);
    const top = Math.min(
      Math.max(0, panel.iterationTop),
      Math.max(0, newestFirst.length - LIST_VISIBLE_ROWS),
    );
    const visible = newestFirst.slice(top, top + LIST_VISIBLE_ROWS);
    if (top > 0) body.push(theme.fg("dim", `  … ${String(top)} newer above`));
    for (const fire of visible) {
      const marker = fire.fire === selected?.fire ? theme.fg("accent", "›") : " ";
      const text = fireLine(fire);
      body.push(`${marker} ${truncateToWidth(text, Math.max(1, width - 4), "…", false)}`);
    }
    const below = newestFirst.length - top - visible.length;
    if (below > 0) body.push(theme.fg("dim", `  … ${String(below)} older below`));
  }

  if (panel.notice !== undefined) body.push(theme.fg("warning", `  ${panel.notice}`));
  return panel.frame(
    `loop: ${task.name}`,
    `${task.id} · ${task.status} · ${task.schedule}`,
    body,
    "↑/↓ select · Enter fire · ← list · k stop · alt+q close",
    width,
  );
}

export function renderIterationDetail(panel: TasksPanel, width: number): string[] {
  const theme = panel.theme;
  const row = panel.detailRow();
  if (row === undefined || row.task.kind !== "prompt-loop") return renderList(panel, width);
  const task = row.task;
  const iteration = panel.currentIteration(task);
  if (iteration === undefined) return renderLoopDetail(panel, row, width);

  const body: string[] = [
    field(panel, "Status", theme.fg(ITERATION_COLOUR[iteration.status], iteration.status)),
    field(panel, "Started", formatClockTime(iteration.startedAt)),
  ];
  if (iteration.endedAt !== undefined) {
    body.push(field(panel, "Took", formatDuration(iteration.endedAt - iteration.startedAt)));
  }
  body.push(field(panel, "Calls", callsText(iteration)));
  body.push("", theme.fg("muted", callsHeading(iteration, panel.callTop)));

  const top = callTopFor(iteration, panel.callTop);
  const visible = iteration.calls.slice(top, top + DETAIL_OUTPUT_LINES);
  if (visible.length === 0) {
    body.push(theme.fg("dim", "  no tool call in this turn"));
  }
  visible.forEach((call, offset) => {
    body.push(callLine(panel, call, top + offset, width - 4));
    if (call.error !== undefined) {
      body.push(theme.fg(STATUS_COLOUR.failed, `     error: ${call.error}`));
    }
  });
  // The cap drops the oldest calls first; say so where they would have been.
  if (iteration.droppedCalls > 0) {
    body.push(
      theme.fg(
        STATUS_COLOUR.interrupted,
        `  … +${String(iteration.droppedCalls)} earlier calls dropped`,
      ),
    );
  }

  if (panel.notice !== undefined) body.push(theme.fg("warning", `  ${panel.notice}`));
  return panel.frame(
    `fire ${String(iteration.fire)}`,
    `${task.name} · ${task.id} · ${iteration.status}`,
    body,
    "↑/↓ scroll · ← loop · k stop · alt+q close",
    width,
  );
}

export function callLine(
  panel: TasksPanel,
  call: IterationCall,
  index: number,
  width: number,
): string {
  const theme = panel.theme;
  const prefix = ` ${String(index + 1).padStart(2)}. ${call.tool}  `;
  const duration = call.durationMs === undefined ? "" : ` ${formatDuration(call.durationMs)}`;
  const status = `  ${call.status}${duration}`;
  const room = Math.max(1, width - prefix.length - status.length);
  const subject = singleLine(call.subject, room);
  const body =
    subject.length === 0 ? "" : isCommandCall(call) ? theme.fg("accent", subject) : subject;
  return `${prefix}${body}${theme.fg(CALL_COLOUR[call.status], status)}`;
}

export function position(panel: TasksPanel): string {
  if (panel.following || panel.detailLines.length === 0) return "following tail · ↑ scroll";
  const [from, to] = window(panel);
  const total = panel.detailLines.length;
  return `lines ${String(from + 1)}–${String(to)} of ${String(total)} · ↑/↓ scroll · r follows`;
}

export function window(panel: TasksPanel): [number, number] {
  const total = panel.detailLines.length;
  const to = Math.max(0, total - panel.scrollBack);
  return [Math.max(0, to - DETAIL_OUTPUT_LINES), to];
}

export function field(panel: TasksPanel, label: string, value: string): string {
  // Cut here, once, against the frame: the border and the label take their share first.
  const room = Math.max(8, panel.renderWidth - 2 - LABEL_WIDTH - 2);
  const text = visibleWidth(value) > room ? truncateToWidth(value, room, "…", false) : value;
  return `${panel.theme.fg("muted", pad(`${label}:`, LABEL_WIDTH))}${text}`;
}

export function sessionField(panel: TasksPanel, row: PanelTaskView): string[] {
  if (!foreign(panel, row) || row.sessionId === undefined) return [];
  return [field(panel, "Session", panel.theme.fg("dim", row.sessionId))];
}

export function updatedText(panel: TasksPanel, updatedAt: number): string {
  const age = formatDuration(Math.max(0, panel.now() - updatedAt));
  return `${formatClockTime(updatedAt)} · ${age} ago`;
}
