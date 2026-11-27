/**
 * The `wait: true` return, as the transcript shows it: the answer a blocking call
 * gives when the command ends, and the same call let go with `ctrl+shift+b`.
 *
 * The task quoted is the one this machine really blocked on — `bg-4wu33`, the demo
 * call the shortcut released and which then exited 7. Its id, name, command, cwd,
 * output path and tail are the captured store's; `describeTask` is the shipped
 * renderer, so the label lines are the ones a reader would see in a real answer.
 *
 * Only the two verdict sentences are mirrored from `src/tasks/process/tools.ts`
 * (the function that builds them is not exported); the unit test greps that file for
 * both, so the wording cannot drift without the image following.
 */

import { detachedNotice } from "../../dist/tasks/process/foreground.js";
import { describeTask } from "../../dist/tasks/process/tools.js";
import * as story from "./record.mjs";
import { makeTheme } from "./theme.mjs";

const THEME = makeTheme();
/** The frame's text width, a column or two short of the page's 106 so nothing touches the edge. */
const WIDTH = 102;

/** The blocking call this machine really waited on, then let go. */
const BLOCKED_ID = "bg-4wu33";
const BLOCKED = story.TASKS.find((task) => task.id === BLOCKED_ID);
if (BLOCKED === undefined) throw new Error(`the captured store has no ${BLOCKED_ID}`);

/**
 * Split one long line into rows a 106-column frame can hold.
 *
 * A path has no spaces in it, so a word wider than the frame is cut at the frame edge
 * the way a terminal would — wrapping it whole would push the row past the window.
 */
function wrap(text, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (word.length > width) {
      if (line !== "") {
        lines.push(line);
        line = "";
      }
      for (let at = 0; at < word.length; at += width) lines.push(word.slice(at, at + width));
      continue;
    }
    const candidate = line === "" ? word : `${line} ${word}`;
    if (candidate.length > width && line !== "") {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** The record as the store holds it, with the elapsed time its own timestamps give. */
function view() {
  return {
    task: BLOCKED,
    elapsedMs: BLOCKED.endedAt - BLOCKED.createdAt,
    outputBytes: BLOCKED.outputBytes,
  };
}

/**
 * `describeTask` prints `label: value` rows, and this machine's absolute paths are
 * wider than the frame. When a row does not fit, the label keeps its own row and the
 * value wraps under it with two spaces of hang, which is how a terminal shows a long
 * field — splitting `output` from `file:` instead would read as two different rows.
 */
function labelRows(text, width) {
  const rows = [];
  for (const line of text.split("\n")) {
    const at = line.indexOf(": ");
    const label = at === -1 ? undefined : line.slice(0, at + 1);
    const value = at === -1 ? line : line.slice(at + 2);
    if (label !== undefined && label.length + 1 + value.length > width) {
      rows.push(label);
      for (const chunk of wrap(value, width - 2)) rows.push(`  ${chunk}`);
    } else {
      rows.push(...(line === "" ? [""] : wrap(line, width)));
    }
  }
  return rows;
}

export async function renderBlockedResult() {
  const record = view();
  const { id, name, exitCode } = BLOCKED;
  const tail = story.logLines(id).slice(-5);
  const lines = [
    `${id} (${name}) exited with code ${String(exitCode)}.`,
    "",
    // `describeTask` wraps nothing: the output path alone is wider than a frame row.
    ...labelRows(describeTask(record), WIDTH),
    "",
    THEME.fg("dim", `(showing the last ${String(tail.length)} lines; the output file holds the rest)`),
    ...tail,
    "",
    THEME.fg("dim", `Read the whole file with pretty_task_bg_logs id=${id}.`),
    "",
    // The same call, one keystroke earlier: released, still running, no exit code.
    `${id} (${name}) is still running; the shortcut moved this call to the background.`,
    "",
    // The shortcut wording never prints the seconds, so the field travels unused.
    ...wrap(detachedNotice({ kind: "detached", taskId: id, trigger: "shortcut", afterSeconds: 0 }), WIDTH).map(
      (line) => THEME.fg("accent", line),
    ),
    "",
    THEME.fg("dim", story.logLines(id)[0] ?? ""),
  ];
  return lines;
}
