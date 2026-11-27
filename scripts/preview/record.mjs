/**
 * The store the animation follows, read from `scripts/preview/record/session.json` —
 * a real session captured by `capture-record.mjs`.
 *
 * Nothing here is invented: the rows are the store's rows, the tails are the
 * command's own bytes, and the one task the tour follows (`bg-v5y1b`) keeps the
 * name the store derived for it, the command that was typed and the exit code it
 * ended with. A frame that prints `bg-…` can be checked against that file.
 *
 * Two things are staged, because a screenshot has to pick a moment:
 * - the clock is the store's last write, so elapsed times stay byte-stable;
 * - the story task joins the list only when the takeover produces it, which is
 *   when ADR-0020 gives it a record — before that it is the command in front.
 *
 * The still images keep their own fiction (`fixtures.mjs`); this module exists so
 * the animation quotes a real run instead of a plausible one.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The captured store, verbatim: `{ source, version, tasks, outputs }`. */
export const RECORD = JSON.parse(readFileSync(join(HERE, "record", "session.json"), "utf8"));
export const TASKS = RECORD.tasks;
/** The command the tour follows from the prompt line into the panel. */
export const STORY_ID = "bg-v5y1b";
export const STORY = TASKS.find((task) => task.id === STORY_ID);
if (STORY === undefined) throw new Error(`the captured store has no ${STORY_ID}`);
/** The directory the session ran in, as the store records it. */
export const HOME = STORY.cwd;
/** The store's own last write: a rebuild must not change an elapsed time. */
export const CLOCK = Math.max(...TASKS.map((task) => task.updatedAt));
export const now = () => CLOCK;

/** The lines a task wrote, exactly as its output file holds them. */
export function logLines(id) {
  return RECORD.outputs[id] ?? [];
}

/**
 * Every task except the story: before the takeover it has no record at all.
 *
 * Only records whose name and command are ASCII reach a frame. The snapshot is kept
 * verbatim — ids, times, paths and output are the real session's — but this list ships
 * to English readers as a picture, and a captured name like `重复两次全量测试找那条
 * flaky` would be the one Chinese string in it. The filter is on what the picture may
 * show, never on what the file records.
 */
const printable = (text) => /^[\u0020-\u007e]*$/u.test(text);
const OTHERS = TASKS.filter(
  (task) => task.id !== STORY_ID && printable(task.name) && printable(task.command),
);

/** The command pi is still waiting on. One at the start, zero after the takeover. */
let inFront = 1;
/** Whether the takeover has happened: the same command is a task from then on. */
let detached = false;
/** How far the story has got: running, then ended with the code the store recorded. */
let ended = false;

export function holdInFront(count = 1) {
  inFront = count;
  detached = false;
  ended = false;
}

/** `ctrl+shift+b`: the front empties and the same command appears as a task. */
export function detachFront() {
  inFront = 0;
  detached = true;
}

/** The story ends, with the code and the status the store recorded. */
export function finishStory() {
  ended = true;
}

const viewOf = (task) => ({
  task,
  elapsedMs: (task.endedAt ?? CLOCK) - task.createdAt,
  outputBytes: task.outputBytes,
});

/** The story at this moment: running until `finishStory()`. */
function storyView() {
  if (ended) return viewOf(STORY);
  const text = logLines(STORY_ID).slice(0, 12).join("\n");
  return viewOf({
    ...STORY,
    status: "running",
    endedAt: undefined,
    exitCode: undefined,
    outputBytes: Buffer.byteLength(text),
  });
}

/** A `PanelSource` over the captured store: no files, no processes, nothing to stop. */
export const SOURCE = {
  sessionId: RECORD.source.sessionId.slice(0, 8),
  list: async () => (detached ? [...OTHERS, storyView().task] : OTHERS).map(viewOf),
  tail: async (id) => {
    const lines = logLines(id);
    const text = (id === STORY_ID && !ended ? lines.slice(0, 12) : lines).join("\n");
    if (text === "") return undefined;
    return { text, lines: text.split("\n").length, truncated: id === STORY_ID && !ended };
  },
  stop: async () => undefined,
  /** What pi is still waiting on: not a row, only the hint above the keys. */
  foreground: () => inFront,
};
