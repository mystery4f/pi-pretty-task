/**
 * The four frames the tour opens with: a real session, the command that was typed,
 * the output it wrote, the key that let it go, and the card it left behind.
 *
 * Every string comes from the captured store (`record.mjs`) or a shipped renderer
 * (`detachedNotice`, `renderTaskDetached`) — nothing here types a sentence a
 * reader could not check.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { detachedNotice } from "../../dist/tasks/process/foreground.js";
import { renderTaskDetached, TASK_DETACHED_ENTRY_TYPE } from "../../dist/ui/notification.js";
import * as story from "./record.mjs";
import { makeTheme } from "./theme.mjs";

const WIDTH = 106;
const CARD_WIDTH = 96;
const dim = (text) => `\u001b[38;2;104;112;126m${text}\u001b[39m`;
const bright = (text) => `\u001b[38;2;230;237;243m${text}\u001b[39m`;

/** Break plain text on spaces, so a receipt fits the frame instead of being clipped. */
export function wrapText(text, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (visibleWidth(`${line} ${word}`) <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** Pad a line to the frame width, so every page is drawn the same size. */
function pad(line) {
  return line + " ".repeat(Math.max(0, WIDTH - visibleWidth(line)));
}

/** The command line pi echoes for a `!` run: the store's own bytes. */
const echo = ` ! ${story.STORY.command}`;

/** The first lines the command wrote, indented the way a tool result prints them. */
function output(slice) {
  return slice.map((line) => dim(`   ${line}`));
}

/** The card a takeover leaves, drawn by the shipped renderer with the store's id. */
function detachCard() {
  const theme = makeTheme();
  const component = renderTaskDetached(
    {
      type: "custom",
      customType: TASK_DETACHED_ENTRY_TYPE,
      // How long the command held the front, from the two timestamps this machine
      // recorded: the task's `createdAt` (2026-11-27T12:26:01.642Z) and the tool result
      // that carried the receipt (12:26:05.866Z, session line 583) — 4.2s, 4 here.
      // The store keeps no separate detach moment, so the arithmetic lives in this note.
      data: { id: story.STORY.id, trigger: "shortcut", afterSeconds: 4 },
    },
    { expanded: false, keyText: () => "", keyHint: () => "" },
    theme,
  );
  if (component === undefined) throw new Error("the detach card drew nothing");
  const lines = [];
  for (const line of component.render(CARD_WIDTH)) {
    const width = visibleWidth(line);
    if (width > CARD_WIDTH) {
      throw new Error(`card line is ${String(width)} columns, wider than ${String(CARD_WIDTH)}: ${line}`);
    }
    lines.push(line + " ".repeat(CARD_WIDTH - width));
  }
  return lines;
}

/**
 * The opening frames. Each carries the editor it was typed into, so the page draws
 * the prompt and the command under the transcript; the panel pages carry the legend.
 */
export function renderSession() {
  const first = story.logLines(story.STORY_ID).slice(0, 3);
  const receipt = wrapText(
    detachedNotice({ kind: "detached", taskId: story.STORY.id, trigger: "shortcut", afterSeconds: 0 }),
    100,
  );
  const frames = [
    {
      label: "session:prompt",
      badge: "Enter",
      editor: { text: story.STORY.command },
      title: STORY_TITLE,
      lines: [echo, ""].map(pad),
    },
    {
      label: "session:running",
      badge: "",
      editor: { text: story.STORY.command },
      title: STORY_TITLE,
      lines: [echo, "", ...output(first)].map(pad),
    },
    {
      label: "session:detach",
      badge: "ctrl+shift+b",
      editor: { text: story.STORY.command },
      title: STORY_TITLE,
      lines: [echo, "", ...output(first), "", ...receipt.map(bright)].map(pad),
    },
    {
      label: "session:card",
      badge: "",
      editor: { text: story.STORY.command },
      title: STORY_TITLE,
      lines: ["", ...receipt.map(bright), "", ...detachCard()].map(pad),
    },
  ];
  return frames;
}

/** The session's own title: the directory the store ran in. */
export const STORY_TITLE = "pi — transcript — ~/pi-pretty-task";
