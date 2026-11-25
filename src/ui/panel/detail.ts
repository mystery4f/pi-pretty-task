/**
 * The task detail: one record opened onto its numbers, its output tail, its fires
 * or the tool calls one iteration made. Pure drawing over the panel's state — the
 * tail is read by the panel and handed in, so nothing here touches a file.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
  promptBody,
  retryText,
  STEP_MARK,
  singleLine,
  stepColour,
} from "./format.js";
import { fittedFooter, PROCESS_KEYS, pad } from "./keys.js";
import { chainPlace, foreign, renderList, stepRecord } from "./list.js";
import {
  DETAIL_FIELD_RESERVE,
  DETAIL_MIN_OUTPUT_LINES,
  DETAIL_OUTPUT_LINES,
  DETAIL_WIDE_MIN_WIDTH,
  FRAME_ROWS,
  LABEL_WIDTH,
  LIST_VISIBLE_ROWS,
  type PanelTaskView,
} from "./model.js";
import type { PanelView } from "./view.js";

export function renderDetail(panel: PanelView, width: number): string[] {
  const row = panel.detailRow();
  if (row === undefined) return renderList(panel, width);
  if (row.task.kind === "prompt-loop") return renderLoopDetail(panel, row, width);
  if (row.task.kind === "cmd-loop") return renderCommandLoopDetail(panel, row, width);
  if (row.task.kind === "chain") return renderChainDetail(panel, row, width);
  return renderProcessDetail(panel, width);
}

export function renderChainDetail(panel: PanelView, row: PanelTaskView, width: number): string[] {
  const theme = panel.theme;
  const task = row.task;
  if (task.kind !== "chain") return renderList(panel, width);
  const colour = STATUS_COLOUR[task.status];
  const done = task.steps.filter((id) => stepRecord(panel, id)?.status === "completed").length;
  const groups: string[][] = [
    field(panel, "Name", theme.fg("accent", task.name)),
    field(panel, "ID", theme.fg("accent", task.id)),
    sessionField(panel, row),
    field(panel, "Status", theme.fg(colour, task.status)),
    field(panel, "Runtime", formatDuration(row.elapsedMs)),
    field(panel, "Updated", updatedText(panel, task.updatedAt)),
    field(
      panel,
      "Steps",
      `${String(done)} of ${String(task.steps.length)} done · ${chainPlace(panel, task)}`,
    ),
    task.endedAt === undefined ? [] : field(panel, "Ended", formatClockTime(task.endedAt)),
    task.killReason === undefined ? [] : field(panel, "Kill reason", task.killReason),
    task.error === undefined ? [] : block(panel, "Error", theme.fg(colour, task.error)),
  ];

  // The steps get what the pane leaves once the fields and the keys are paid
  // for, and the fields shed first: the step a chain is stuck on is why this
  // page was opened.
  const notice = panel.notice === undefined ? 0 : 1;
  const budget = detailRows(panel.renderHeight, 2 + notice, LIST_VISIBLE_ROWS, 2);
  const stepRows = budget.window;
  const body = fitFields(panel, groups, budget.fields);
  body.push("", theme.fg("muted", ` Steps, in run order (${String(task.steps.length)}):`));
  if (task.steps.length === 0) {
    body.push(theme.fg("dim", "  no step queued yet"));
  }
  // Two lines say how much is hidden, one above and one below, so they are taken
  // from the window rather than pushing the frame past the pane.
  const rows = Math.max(1, task.steps.length > stepRows ? stepRows - 2 : stepRows);
  const top = Math.max(0, Math.min(task.cursor - rows + 1, task.steps.length - rows));
  const room = Math.max(20, width - 4);
  if (top > 0) body.push(theme.fg("dim", `  … ${String(top)} earlier above`));
  task.steps.slice(top, top + rows).forEach((id, offset) => {
    const index = top + offset;
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
    // Status and name lead, so a narrow pane keeps the fact that explains the
    // chain and the step it is on; the numbers trail and go first when cut.
    const facts = [code, duration].filter((cell) => cell.length > 0).join(" · ");
    const line = `${marker} ${mark} ${pad(status, 9)} ${name}${facts.length > 0 ? ` · ${facts}` : ""}`;
    body.push(`${truncateToWidth(line.trimEnd(), room, "…", false)}  ${theme.fg("dim", id)}`);
  });
  const below = Math.max(0, task.steps.length - top - rows);
  if (below > 0)
    body.push(theme.fg("dim", `  … ${String(below)} more step${below === 1 ? "" : "s"}`));

  if (panel.notice !== undefined) body.push(theme.fg("warning", `  ${panel.notice}`));
  return panel.frame(
    `chain: ${task.name}`,
    `${task.id} · ${task.status} · ${chainPlace(panel, task)}`,
    body,
    "← list · k stop from the running step · alt+q close",
    width,
  );
}

export function renderProcessDetail(panel: PanelView, width: number): string[] {
  const theme = panel.theme;
  const row = panel.detailRow();
  if (row === undefined || row.task.kind !== "process") return renderList(panel, width);
  const task = row.task;
  const colour = STATUS_COLOUR[task.status];
  // Facts in the order a stuck run is diagnosed — what it is, whether it still
  // runs, how it ended — and the paperwork (paths, size) after that, so a short
  // pane keeps the verdict and hides the last lines instead of the tail output.
  const groups: string[][] = [
    field(panel, "Name", theme.fg("accent", task.name)),
    field(panel, "ID", theme.fg("accent", task.id)),
    sessionField(panel, row),
    field(panel, "Status", theme.fg(colour, task.status)),
    field(panel, "Runtime", formatDuration(row.elapsedMs)),
    field(panel, "Updated", updatedText(panel, task.updatedAt)),
    task.exitCode === undefined
      ? []
      : field(panel, "Exit code", theme.fg(colour, String(task.exitCode))),
    task.killReason === undefined ? [] : field(panel, "Kill reason", task.killReason),
    task.error === undefined ? [] : block(panel, "Error", theme.fg(colour, task.error)),
    task.endedAt === undefined ? [] : field(panel, "Ended", formatClockTime(task.endedAt)),
    block(panel, "Command", task.command),
    task.cwd === undefined ? [] : block(panel, "CWD", task.cwd),
    block(panel, "Output", task.outputPath),
    field(panel, "Size", formatSize(row)),
    field(panel, "Started", formatClockTime(task.createdAt)),
    task.pid === undefined ? [] : field(panel, "PID", String(task.pid)),
  ];

  // The tail keeps whatever the pane has once the frame and the fields are paid
  // for; under the box sit one blank line, its heading and the position line.
  const notice = panel.notice === undefined ? 0 : 1;
  const budget = detailRows(panel.renderHeight, 3 + notice);
  const tailRows = budget.window;
  const body = fitFields(panel, groups, budget.fields);
  body.push("", theme.fg("muted", " Output tail:"));
  body.push(...outputBox(panel, width - 2, tailRows));
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

export function outputBox(
  panel: PanelView,
  width: number,
  rows = windowRowsFor(panel.renderHeight),
): string[] {
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
  while (lines.length < rows + 1) lines.push(row());
  lines.push(edge(`╰${"─".repeat(inner)}╯`));
  return lines;
}

export function renderLoopDetail(panel: PanelView, row: PanelTaskView, width: number): string[] {
  const theme = panel.theme;
  const task = row.task;
  if (task.kind !== "prompt-loop") return renderList(panel, width);
  const colour = STATUS_COLOUR[task.status];
  const groups: string[][] = [
    field(panel, "Status", theme.fg(colour, task.status)),
    field(panel, "Kind", task.kind),
    sessionField(panel, row),
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
    task.expiresAt === undefined ? [] : field(panel, "Expires", formatClockTime(task.expiresAt)),
    task.endedAt === undefined ? [] : field(panel, "Ended", formatClockTime(task.endedAt)),
    task.error === undefined ? [] : block(panel, "Error", theme.fg(colour, task.error)),
    promptBlock(panel, task.promptWarning),
  ];

  const notice = panel.notice === undefined ? 0 : 1;
  const budget = detailRows(panel.renderHeight, 2 + notice, LIST_VISIBLE_ROWS, 2);
  const listRows = budget.window;
  const body = fitFields(panel, groups, budget.fields);
  body.push("", theme.fg("muted", iterationsText(task)));

  // What is scrolled out is said on two lines, so the list gives them up rather
  // than drawing past the pane.
  const rows = Math.max(1, listRows - 2);
  const newestFirst = [...task.iterations].toReversed();
  if (newestFirst.length === 0) {
    body.push(theme.fg("dim", "  no iteration recorded yet"));
  } else {
    const selected = panel.currentIteration(task);
    const top = Math.min(Math.max(0, panel.iterationTop), Math.max(0, newestFirst.length - rows));
    const visible = newestFirst.slice(top, top + rows);
    if (top > 0) body.push(theme.fg("dim", `  … ${String(top)} newer above`));
    for (const iteration of visible) {
      const marker = iteration.fire === selected?.fire ? theme.fg("accent", "›") : " ";
      // The row's mark depends on the fires before it, so the whole record is
      // handed over rather than a number the renderer would have to derive.
      const text = iterationLine(iteration, task.iterations);
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
  panel: PanelView,
  row: PanelTaskView,
  width: number,
): string[] {
  const theme = panel.theme;
  const task = row.task;
  if (task.kind !== "cmd-loop") return renderList(panel, width);
  const colour = STATUS_COLOUR[task.status];
  const envCount = Object.keys(task.env ?? {}).length;
  const variables = `${String(envCount)} variable${envCount === 1 ? "" : "s"}`;
  const streak = failureStreak(task);
  // A streak explains why the next fire is later than the expression says, so it
  // sits with the schedule facts and never rewrites them (ADR-0017). The signal
  // and the last exit follow the same rule (ADR-0018): what a subscriber reports
  // is a fact about the command, not part of its schedule.
  const streakFacts: string[] =
    streak > 0 ? field(panel, "Failures", `${String(streak)} in a row`) : [];
  const signalFacts: string[] = [];
  if (task.notifyExitCodes !== undefined && task.notifyExitCodes.length > 0) {
    const codes = task.notifyExitCodes.map((code) => `exit ${String(code)}`).join(", ");
    signalFacts.push(...field(panel, "Signal on", codes));
    const since =
      task.signalRaisedAt === undefined ? "" : ` since ${formatClockTime(task.signalRaisedAt)}`;
    signalFacts.push(
      ...field(
        panel,
        "Signal",
        task.signalRaised === true ? theme.fg("warning", `raised${since}`) : "clear",
      ),
    );
  }
  // A short pane keeps the schedule, the streak, the signal and the last exit —
  // everything that says whether this loop is healthy — and drops paths first.
  const groups: string[][] = [
    field(panel, "Status", theme.fg(colour, task.status)),
    field(panel, "Kind", task.kind),
    sessionField(panel, row),
    field(panel, "Runtime", formatDuration(row.elapsedMs)),
    field(panel, "Updated", updatedText(panel, task.updatedAt)),
    field(panel, "Schedule", task.schedule),
    field(panel, "Fires", `${firesText(task)}${missedText(task)}`),
    field(panel, "Next fire", nextFireText(task, row, streak > 0)),
    field(
      panel,
      "Last fire",
      task.lastFireAt === undefined ? "—" : formatClockTime(task.lastFireAt),
    ),
    streakFacts,
    signalFacts,
    field(panel, "Last exit", task.lastExitCode === undefined ? "—" : String(task.lastExitCode)),
    field(panel, "Env", envCount === 0 ? "—" : variables),
    field(panel, "Wake on failure", task.wakeOnFailure === false ? "off" : "on"),
    task.expiresAt === undefined ? [] : field(panel, "Expires", formatClockTime(task.expiresAt)),
    task.endedAt === undefined ? [] : field(panel, "Ended", formatClockTime(task.endedAt)),
    task.error === undefined ? [] : block(panel, "Error", theme.fg(colour, task.error)),
    block(panel, "Command", task.command),
    task.cwd === undefined ? [] : block(panel, "CWD", task.cwd),
    task.lastOutputPath === undefined ? [] : block(panel, "Last output", task.lastOutputPath),
    field(
      panel,
      "Size",
      task.lastOutputBytes === undefined ? "—" : formatBytes(task.lastOutputBytes),
    ),
  ];

  const notice = panel.notice === undefined ? 0 : 1;
  const budget = detailRows(panel.renderHeight, 2 + notice, LIST_VISIBLE_ROWS, 2);
  const listRows = budget.window;
  const body = fitFields(panel, groups, budget.fields);
  body.push("", theme.fg("muted", firesHeading(task)));

  const rows = Math.max(1, listRows - 2);
  const newestFirst = [...task.fireHistory].toReversed();
  if (newestFirst.length === 0) {
    body.push(theme.fg("dim", "  no fire recorded yet"));
  } else {
    const selected = panel.currentFire(task);
    const top = Math.min(Math.max(0, panel.iterationTop), Math.max(0, newestFirst.length - rows));
    const visible = newestFirst.slice(top, top + rows);
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

export function renderIterationDetail(panel: PanelView, width: number): string[] {
  const theme = panel.theme;
  const row = panel.detailRow();
  if (row === undefined || row.task.kind !== "prompt-loop") return renderList(panel, width);
  const task = row.task;
  const iteration = panel.currentIteration(task);
  if (iteration === undefined) return renderLoopDetail(panel, row, width);

  const groups: string[][] = [
    field(panel, "Status", theme.fg(ITERATION_COLOUR[iteration.status], iteration.status)),
    field(panel, "Started", formatClockTime(iteration.startedAt)),
    // What the turn spent on a provider that was failing, whether it is still
    // doing so or has since finished (ticket #47).
    iteration.retry === undefined
      ? []
      : field(panel, "Retry", theme.fg("warning", retryText(iteration.retry))),
    iteration.endedAt === undefined
      ? []
      : field(panel, "Took", formatDuration(iteration.endedAt - iteration.startedAt)),
    field(panel, "Calls", callsText(iteration)),
  ];

  // The calls are why this page exists: they keep the room the pane gives them,
  // and the two header fields give theirs up first.
  const notice = panel.notice === undefined ? 0 : 1;
  const budget = detailRows(panel.renderHeight, 2 + notice);
  const callRows = budget.window;
  const body = fitFields(panel, groups, budget.fields);
  const top = callTopFor(iteration, panel.callTop, callRows);
  // A call's error takes a line of its own, so the window fills call by call and
  // says what it could not show instead of drawing past the pane.
  const drawn: string[] = [];
  let shown = 0;
  for (const [offset, call] of iteration.calls.slice(top).entries()) {
    const errorLine =
      call.error === undefined ? [] : [theme.fg(STATUS_COLOUR.failed, `     error: ${call.error}`)];
    if (drawn.length + 1 + errorLine.length > callRows) break;
    drawn.push(callLine(panel, call, top + offset, width - 4), ...errorLine);
    shown += 1;
  }
  body.push(
    "",
    theme.fg("muted", callsHeading(iteration, panel.callTop, Math.max(1, drawn.length))),
  );
  if (iteration.calls.length === 0) {
    body.push(theme.fg("dim", "  no tool call in this turn"));
  }
  body.push(...drawn);
  const leftOut = iteration.calls.length - top - shown;
  // The cap drops the oldest calls first; say so where they would have been.
  if (leftOut > 0) {
    body.push(
      theme.fg(
        STATUS_COLOUR.interrupted,
        `  … ${String(leftOut)} more call${leftOut === 1 ? "" : "s"} not shown`,
      ),
    );
  } else if (iteration.droppedCalls > 0) {
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
  panel: PanelView,
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
  let body = subject;
  if (subject.length > 0 && isCommandCall(call)) body = theme.fg("accent", subject);
  return `${prefix}${body}${theme.fg(CALL_COLOUR[call.status], status)}`;
}

export function position(panel: PanelView): string {
  if (panel.following || panel.detailLines.length === 0) return "following tail · ↑ scroll";
  const [from, to] = window(panel);
  const total = panel.detailLines.length;
  return `lines ${String(from + 1)}–${String(to)} of ${String(total)} · ↑/↓ scroll · r follows`;
}

/**
 * How a pane's rows split between a detail's fields and the window under them.
 *
 * The window is what the reader came for — the tail, the calls, the fires — so it
 * takes `DETAIL_MIN_OUTPUT_LINES` first and grows only towards `cap`. The fields
 * take the rest of `DETAIL_FIELD_RESERVE` or less, and are what a pane too short
 * for both goes without. `below` counts the lines a page draws under the window
 * (a blank, a heading, a notice); the two box borders are added here.
 */
export function detailRows(
  height: number,
  below: number,
  cap = DETAIL_OUTPUT_LINES,
  least = DETAIL_MIN_OUTPUT_LINES,
): { readonly window: number; readonly fields: number } {
  const available = Math.max(1, height - FRAME_ROWS - 2 - below);
  const window = Math.min(
    available,
    Math.min(cap, Math.max(least, available - DETAIL_FIELD_RESERVE)),
  );
  return { window, fields: Math.max(0, available - window) };
}

/** The window under a page whose body draws three lines below it. */
export function windowRowsFor(
  height: number,
  cap = DETAIL_OUTPUT_LINES,
  least = DETAIL_MIN_OUTPUT_LINES,
): number {
  return detailRows(height, 3, cap, least).window;
}

/**
 * The fields that fit, in reading order. A page passes one group per line block,
 * and a group is kept or dropped whole so a field never leaves half a block
 * behind; what did not fit is named in one line at the end, because a page that
 * silently drops its own facts reads as a page that had none.
 */
export function fitFields(
  panel: PanelView,
  groups: readonly (readonly string[])[],
  room: number,
): string[] {
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  if (total <= room) return groups.flat();
  // The marker costs a line of its own, so the fields get one less.
  const kept: string[] = [];
  let dropped = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index] ?? [];
    if (kept.length + group.length > room - 1) {
      dropped = groups.length - index;
      break;
    }
    kept.push(...group);
  }
  if (dropped === 0) return kept;
  if (kept.length + 1 > room) return kept;
  const hidden = `  … ${String(dropped)} more field${dropped === 1 ? "" : "s"} — a taller pane shows them`;
  return [...kept, panel.theme.fg("dim", hidden)];
}

export function window(panel: PanelView): [number, number] {
  const total = panel.detailLines.length;
  const to = Math.max(0, total - panel.scrollBack);
  return [Math.max(0, to - windowRowsFor(panel.renderHeight)), to];
}

export function field(panel: PanelView, label: string, value: string): string[] {
  // Wide enough for the label column: one line, the value cut against the frame.
  if (panel.renderWidth >= DETAIL_WIDE_MIN_WIDTH) {
    // Cut here, once, against the frame: the border and the label take their share first.
    const room = Math.max(8, panel.renderWidth - 2 - LABEL_WIDTH - 2);
    const text = visibleWidth(value) > room ? truncateToWidth(value, room, "…", false) : value;
    return [`${panel.theme.fg("muted", pad(`${label}:`, LABEL_WIDTH))}${text}`];
  }
  // A narrow pane gives the value a line of its own: a label column would leave a
  // status word or a path nothing but an ellipsis.
  return [panel.theme.fg("muted", `${label}:`), ...wrapValue(panel, value, 2)];
}

/** A long value — a command, a path, a prompt — wrapped under its label on a
 *  narrow pane and inline with it when the frame is wide, never truncated: the
 *  reason this page was opened is usually in the part that would be cut. */
export function block(panel: PanelView, label: string, value: string): string[] {
  const inline = panel.renderWidth >= DETAIL_WIDE_MIN_WIDTH;
  const indent = inline ? LABEL_WIDTH : 2;
  const room = Math.max(8, panel.renderWidth - 2 - indent - 2);
  const lines = wrapTextWithAnsi(value, room);
  const body = lines.length === 0 ? [""] : lines;
  if (!inline) return [panel.theme.fg("muted", `${label}:`), ...body.map((line) => `  ${line}`)];
  const tag = panel.theme.fg("muted", pad(`${label}:`, LABEL_WIDTH));
  const gap = " ".repeat(LABEL_WIDTH);
  return body.map((line, index) => (index === 0 ? `${tag}${line}` : `${gap}${line}`));
}

/** A value wrapped under an indent; the frame still cuts what is left over. */
function wrapValue(panel: PanelView, value: string, indent: number): string[] {
  const room = Math.max(8, panel.renderWidth - 4 - indent);
  const lines = wrapTextWithAnsi(value, room);
  const lead = " ".repeat(indent);
  return (lines.length === 0 ? [""] : lines).map((line) => `${lead}${line}`);
}

/**
 * The prompt's own block: the file's address, three lines of it and when it last
 * changed — plus whatever the record has to say about it. The prompt is a file,
 * and the whole of it is never drawn here: the iteration list below is what a
 * reader opens this page for (ticket #48).
 */
function promptBlock(panel: PanelView, warning: string | undefined): string[] {
  const preview = panel.promptPreview;
  if (preview === undefined) return [];
  const theme = panel.theme;
  const body = promptBody(preview, warning);
  // The labelled value above continues at LABEL_WIDTH on a wide pane, so its own
  // sublines continue there too; a narrow pane starts both at 2 (ADR-0019).
  const indent = panel.renderWidth >= DETAIL_WIDE_MIN_WIDTH ? LABEL_WIDTH : 2;
  const sub = (text: string, colour: "dim" | "warning"): string[] =>
    wrapValue(panel, text, indent).map((line) => theme.fg(colour, line));
  return [
    ...block(panel, "Prompt file", preview.path),
    // The warning sits right under the path it is about; a fired loop that had to
    // rebuild the file carries it even now that the file reads fine again.
    ...(body.problem === undefined ? [] : sub(body.problem, "warning")),
    ...body.lines.flatMap((line) => sub(line, "dim")),
    ...(body.changed === undefined ? [] : sub(body.changed, "dim")),
  ];
}

export function sessionField(panel: PanelView, row: PanelTaskView): string[] {
  if (!foreign(panel, row) || row.sessionId === undefined) return [];
  return field(panel, "Session", panel.theme.fg("dim", row.sessionId));
}

export function updatedText(panel: PanelView, updatedAt: number): string {
  const age = formatDuration(Math.max(0, panel.now() - updatedAt));
  return `${formatClockTime(updatedAt)} · ${age} ago`;
}
