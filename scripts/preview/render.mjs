/**
 * Drives the real `TasksPanel` with scripted keystrokes and captures what it
 * renders, one frame per panel state.
 *
 * The panel is the shipped component, imported from `dist/` (run `npm run
 * build` first — `npm run preview` does), so a change in `src/ui/panel/`
 * shows up in the images instead of drifting away from them.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { rememberPanelTab, TasksPanel } from "../../dist/ui/panel/tasks-panel.js";
import { growWeb, now, source } from "./fixtures.mjs";
import { assertWidths, makeTheme } from "./theme.mjs";

const WIDTH = 106;
const TERM_ROWS = 44;
const THEME = makeTheme();
assertWidths(THEME);

const DOWN = "\u001b[B";
const ENTER = "\r";
/** Leaving search keeps the query, which keeps filtering the list. */
const ALT_Q = "\u001bq";
const FILTERS_TO_ALL = 4;

function newPanel() {
  return new TasksPanel({
    tui: { requestRender: () => undefined, terminal: { rows: TERM_ROWS } },
    theme: THEME,
    done: () => undefined,
    source,
    refreshMs: 0,
    now,
  });
}

function capture(panel, label) {
  const lines = panel.render(WIDTH);
  for (const line of lines) {
    const width = visibleWidth(line);
    if (width > WIDTH) {
      throw new Error(`panel line is ${String(width)} columns, wider than ${String(WIDTH)}: ${line}`);
    }
  }
  // Pad to the frame width: the browser then draws every page at one size.
  return {
    label,
    lines: lines.map((line) => line + " ".repeat(WIDTH - visibleWidth(line))),
  };
}

/** Press keys in order, capturing the panel after each one settles. */
async function drive(steps, label, before) {
  // The panel remembers the last page across instances; every image states its own.
  rememberPanelTab("processes");
  const panel = newPanel();
  await panel.settle();
  if (before !== undefined) await before(panel);
  const frames = [capture(panel, `${label}:start`)];
  for (const step of steps) {
    panel.handleInput(step.key);
    await panel.settle();
    frames.push(capture(panel, `${label}:${step.name}`));
  }
  panel.dispose();
  return frames;
}

/** Every status in one list, with the dev server's row mid-growth. */
export async function renderList() {
  const steps = Array.from({ length: FILTERS_TO_ALL }, (_, index) => ({
    name: `filter ${String(index)}`,
    key: "f",
  }));
  const frames = await drive(steps, "list", async (panel) => {
    await panel.refresh();
    growWeb();
    await panel.refresh();
  });
  return frames.at(-1).lines;
}

/** One fire of a prompt loop: the tool calls that single turn made. */
export async function renderIteration() {
  const frames = await drive(
    [
      { name: "loops", key: "2" },
      { name: "older loop", key: DOWN },
      { name: "older loop", key: DOWN },
      { name: "open loop", key: ENTER },
      { name: "open fire", key: ENTER },
    ],
    "iteration",
  );
  return frames.at(-1).lines;
}

/** The animation: the list pages, the filter tab row and a search, nothing taller. */
export async function renderWalk() {
  return drive(
    [
      { name: "loops", key: "2" },
      { name: "chains", key: "3" },
      { name: "processes", key: "1" },
      { name: "search", key: "/" },
      { name: "w", key: "w" },
      { name: "e", key: "e" },
      { name: "b", key: "b" },
      { name: "keep the query", key: ALT_Q },
    ],
    "walk",
  );
}

/** One process, open, with its output tail growing underneath. */
export async function renderTail() {
  const frames = await drive([{ name: "open the log", key: ENTER }], "tail", async (panel) => {
    await panel.refresh();
    growWeb();
    await panel.refresh();
  });
  return frames.at(-1).lines;
}
