/**
 * Drives the real `TasksPanel` with scripted keystrokes and captures what it
 * renders, one frame per panel state.
 *
 * The panel is the shipped component, imported from `dist/` (run `npm run
 * build` first — `npm run preview` does), so a change in `src/ui/panel/`
 * shows up in the images instead of drifting away from them.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings } from "../../dist/tasks/base/settings.js";
import {
  LOOP_SIGNAL_CUSTOM_TYPE,
  TASK_FINISHED_CUSTOM_TYPE,
} from "../../dist/ui/notification.js";
import { LOOP_WAKE_CUSTOM_TYPE } from "../../dist/ui/loop-wake.js";
import {
  DEFAULT_PANEL_FILTER,
  PANEL_FILTERS,
  rememberPanelTab,
  TasksPanel,
} from "../../dist/ui/panel/tasks-panel.js";
import { renderBlockedResult } from "./blocked.mjs";
import { renderDetachCards } from "./card.mjs";
import { detachFront, growWeb, HOME, holdInFront, now, source } from "./fixtures.mjs";
import * as story from "./record.mjs";
import { renderSession } from "./session.mjs";
import { renderNotice, renderNoticeOf, renderStatusLine } from "./transcript.mjs";
import { assertWidths, makeTheme } from "./theme.mjs";

const WIDTH = 106;
/** The panel's text width, for a page that must not depend on its longest line. */
export const PANEL_COLUMNS = WIDTH;
const TERM_ROWS = 44;
const THEME = makeTheme();
assertWidths(THEME);

const DOWN = "\u001b[B";
/** Back one page; the footer spells it `← list`. */
const LEFT = "\u001b[D";
const ENTER = "\r";
/** Leaving search keeps the query, which keeps filtering the list. */
const ALT_Q = "\u001bq";
/**
 * The keys a step can press, in the words the panel's own footer uses (`keys.ts`):
 * a badge has to name a key the panel answers to, or the image teaches a wrong one.
 */
const KEY_TOKENS = new Map([
  [ENTER, "Enter"],
  [DOWN, "↓"],
  ["\u001b[A", "↑"],
  ["\u001b[D", "←"],
  ["\u001b[C", "→"],
  [ALT_Q, "alt+q"],
]);

/**
 * The settings page's data: a real `readSettings` over two files a user could have
 * written, with one value pinned by the environment so the page shows every badge
 * (`env`, `project`, `agent`, `default`) and one `shadowed by` line for real. Written
 * to a scratch directory at module load and removed on exit, so nothing under the
 * repository depends on the machine's own `pretty-task.json`.
 */
const settingsSnapshot = buildSettingsSnapshot();
/** @returns {import("../../dist/tasks/base/settings.js").Settings} */
function buildSettingsSnapshot() {
  const dir = mkdtempSync(join(tmpdir(), "pi-pretty-task-preview-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const projectDir = join(dir, "project");
  const agentDir = join(dir, "agent");
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "pretty-task.json"),
    JSON.stringify({
      settings: { maxRunningTasks: 10, notify: "off" },
      templates: { test: { command: "npm test" } },
    }),
  );
  writeFileSync(
    join(agentDir, "pretty-task.json"),
    JSON.stringify({ settings: { retentionDays: 14, foregroundTimeoutSeconds: 120 } }),
  );
  const snapshot = readSettings({
    env: { PI_PRETTY_TASK_MAX_RUNNING_TASKS: "6" },
    projectDir,
    agentDir,
    platform: process.platform,
    probe: () => true,
  });
  // The page prints both file paths: a temp directory there would be noise a reader
  // cannot reproduce, so what it shows are the paths the other previews already use.
  return {
    ...snapshot,
    templatePaths: {
      // Not `path.join`: on Windows it would turn the POSIX home into backslashes.
      projectFile: `${HOME}/.pi/pretty-task.json`,
      agentFile: "/home/mystery/.pi/agent/pretty-task.json",
    },
  };
}

/**
 * What the badge says for one step: the panel key it pressed, or — for a shortcut
 * driven from outside the panel — the shortcut's own name.
 */
function stepBadge(step) {
  if (step.badge !== undefined) return step.badge;
  if (step.key !== undefined) return KEY_TOKENS.get(step.key) ?? String(step.key);
  return step.effect === undefined ? "" : step.name;
}
/**
 * The `f` presses that take the panel from where it opens to `choice`, each frame
 * named after the filter it lands on. Derived from the panel's own list, so moving
 * a filter never leaves a stale keystroke count in the image scripts.
 */
function filterSteps(choice) {
  const from = PANEL_FILTERS.indexOf(DEFAULT_PANEL_FILTER);
  const count = (PANEL_FILTERS.indexOf(choice) - from + PANEL_FILTERS.length) % PANEL_FILTERS.length;
  return Array.from({ length: count }, (_, index) => ({
    name: `filter ${String(PANEL_FILTERS[(from + index + 1) % PANEL_FILTERS.length])}`,
    key: "f",
  }));
}

function newPanel(panelSource = source) {
  return new TasksPanel({
    tui: { requestRender: () => undefined, terminal: { rows: TERM_ROWS } },
    theme: THEME,
    done: () => undefined,
    source: panelSource,
    refreshMs: 0,
    now,
  });
}

function capture(panel, label, badge) {
  const lines = panel.render(WIDTH);
  for (const line of lines) {
    const width = visibleWidth(line);
    if (width > WIDTH) {
      throw new Error(`panel line is ${String(width)} columns, wider than ${String(WIDTH)}: ${line}`);
    }
  }
  // Pad to the frame width: the browser then draws every page at one size.
  // Pad to the frame width: the browser then draws every page at one size.
  // `badge` is the key this frame answers to, drawn in the window: `drive` reads it
  // off the step that produced the frame, so the image cannot show a key nobody pressed.
  return {
    label,
    badge,
    lines: lines.map((line) => line + " ".repeat(WIDTH - visibleWidth(line))),
  };
}

/** Press keys in order, capturing the panel after each one settles. */
async function drive(steps, label, before, startBadge = "", panelSource = source) {
  // The panel remembers the last page across instances; every image states its own.
  rememberPanelTab("processes");
  const panel = newPanel(panelSource);
  await panel.settle();
  if (before !== undefined) await before(panel);
  // The opening frame answers to whatever got the reader here: `/tasks`, or nothing.
  const frames = [capture(panel, `${label}:start`, startBadge)];
  for (const step of steps) {
    // `key` is the panel's own input; `effect` is what happens outside it, such as
    // a pi-level shortcut whose result the panel only sees in its next refresh.
    if (step.key !== undefined) panel.handleInput(step.key);
    if (step.effect !== undefined) await step.effect(panel);
    await panel.settle();
    frames.push(capture(panel, `${label}:${step.name}`, stepBadge(step)));
  }
  panel.dispose();
  return frames;
}

/**
 * The frame a still image wants: every renderer hands back the whole capture, and
 * the last one is the state its doc comment describes. The animation picks from the
 * same array, so no page is captured twice.
 */
export const lastLines = (frames) => frames.at(-1).lines;

/**
 * The frames the animation plays, in one place: every renderer below drives its own
 * walk and hands back all of it, and the tour names which frames survive. The list of
 * renderers here is a set of sources — it carries no order, and adding one cannot move
 * a frame: that is `scripts/preview/storyboard.mjs`'s job.
 */
export async function captureTour(tour) {
  const captured = new Map();
  for (const renderer of [
    renderSession,
    renderStory,
    renderList,
    renderTail,
    renderIteration,
    renderChain,
    renderCommandLoop,
    renderFailed,
    renderSearch,
    renderDetach,
    renderWalk,
    renderCardSurfaces,
    renderStatusSurface,
    renderBlockedSurface,
  ]) {
    for (const frame of await renderer()) captured.set(frame.label, frame);
  }
  const missing = tour.filter((step) => !captured.has(step.label)).map((step) => step.label);
  if (missing.length > 0) {
    throw new Error(`the tour names frames no renderer captures: ${missing.join(", ")}`);
  }
  return tour.map((step) => ({ ...captured.get(step.label), ms: step.ms }));
}

/** Every status in one list, with the dev server's row mid-growth. */
export async function renderList() {
  const steps = filterSteps("all");
  const frames = await drive(
    steps,
    "list",
    async (panel) => {
      await panel.refresh();
      growWeb();
      await panel.refresh();
    },
    // The opening frame is what `/tasks` opens, so that is the key its badge names.
    "/tasks",
  );
  return frames;
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
  return frames;
}

/**
 * The takeover, as a reader meets it: a command is still in front, `ctrl+shift+b`
 * lets it go, and the same command arrives in the list as an ordinary task
 * (ADR-0020). The frame before the key is the only place the hint is drawn.
 */
export async function renderDetach() {
  holdInFront(1);
  return drive(
    [
      {
        name: "ctrl+shift+b",
        // The shortcut belongs to pi, not to the panel: what the panel sees is a
        // refresh in which the front line is empty and the task exists.
        effect: async (panel) => {
          detachFront();
          await panel.refresh();
        },
      },
    ],
    "detach",
  );
}

/**
 * The surfaces that are not panel pages: the four transcript renderers, the status
 * line, and a blocking call's answer. They are handed to the page as lines, the same
 * way `preview.mjs` writes their still images — no page is captured twice.
 */
function padToFrame(lines) {
  return lines.map((line) => line + " ".repeat(Math.max(0, WIDTH - visibleWidth(line))));
}

/** The title bar these surfaces wear: they are transcript content, not the panel. */
const TRANSCRIPT_TITLE = "pi — transcript — ~/work/storefront";
/** The editor's own title, for the line that stands in for the panel. */
const EDITOR_TITLE = "pi — above the editor";

/**
 * The finished notice for the record the tour follows: the store's own id, name,
 * status, duration, exit code and tail, so the image cannot show a number the
 * captured session does not hold.
 */
function finishedDetails() {
  const task = story.STORY;
  const lines = story.logLines(task.id);
  return {
    id: task.id,
    name: task.name,
    kind: "process",
    status: task.status,
    durationMs: task.endedAt - task.createdAt,
    exitCode: task.exitCode,
    outputTail: lines.slice(-3).join("\n"),
    outputTruncated: lines.length > 3,
  };
}
/** The detach card and the three notice cards, one frame each. */
export function renderCardSurfaces() {
  return [
    { label: "cards:detach", badge: "", title: TRANSCRIPT_TITLE, lines: padToFrame(renderDetachCards()) },
    {
      label: "cards:finished",
      badge: "",
      title: TRANSCRIPT_TITLE,
      lines: padToFrame(renderNoticeOf(TASK_FINISHED_CUSTOM_TYPE, finishedDetails())),
    },
    { label: "cards:wake", badge: "", title: TRANSCRIPT_TITLE, lines: padToFrame(renderNotice(LOOP_WAKE_CUSTOM_TYPE)) },
    { label: "cards:signal", badge: "", title: TRANSCRIPT_TITLE, lines: padToFrame(renderNotice(LOOP_SIGNAL_CUSTOM_TYPE)) },
  ];
}

/** The one line that stands in for the panel while it is closed. */
export async function renderStatusSurface() {
  return [
    { label: "status:line", badge: "", title: EDITOR_TITLE, lines: padToFrame(await renderStatusLine()) },
  ];
}

/** A `wait: true` call's answer, both endings. */
export async function renderBlockedSurface() {
  return [
    { label: "result:blocked", badge: "", title: TRANSCRIPT_TITLE, lines: padToFrame(await renderBlockedResult()) },
  ];
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

/**
 * The tour's second half: the same session, now read through the panel. The story
 * task has no record until the takeover gives it one (ADR-0020), so the list only
 * grows that row when the shortcut has fired.
 *
 * Every row is the captured store's and every sentence is the shipped panel's own —
 * this renderer does nothing but press keys.
 */
export async function renderStory() {
  story.holdInFront(1);
  return drive(
    [
      // The takeover is a pi-level shortcut: the panel sees it on its next refresh.
      {
        name: "detach",
        // Nothing was pressed: the shortcut ran outside the panel.
        badge: "",
        effect: async (panel) => {
          story.detachFront();
          await panel.refresh();
        },
      },
      { name: "open the log", key: ENTER },
      { name: "follow", key: "r" },
      { name: "back to the list", key: LEFT },
      {
        name: "finished",
        // The task ended on its own; no key produced this frame.
        badge: "",
        effect: async (panel) => {
          story.finishStory();
          await panel.refresh();
        },
      },
      { name: "filter running", key: "f" },
      { name: "filter failed", key: "f" },
      { name: "search", key: "/" },
      // Typing is not a panel key: the badge keeps naming the key that opened search.
      { name: "f", badge: "/" },
      { name: "r", badge: "/" },
      { name: "o", badge: "/" },
      { name: "n", badge: "/" },
      { name: "t", badge: "/" },
      { name: "keep the query", key: ALT_Q },
    ],
    "story",
    undefined,
// The door as a key press, spelled the way the status line prints it.
    "Shift↓",
    story.SOURCE,
  );
}

/** One process, open, with its output tail growing underneath. */
export async function renderTail() {
  const frames = await drive(
    [
      { name: "open the log", key: ENTER },
      { name: "follow", key: "r" },
    ],
    "tail",
    async (panel) => {
      await panel.refresh();
      growWeb();
      await panel.refresh();
    },
  );
  return frames;
}

/** One chain, open: its steps in order, how far the cursor has got, and the step waiting.
 * Opening a chain is the only way to read the queue ADR-0013 puts in a task record. */
export async function renderChain() {
  const frames = await drive(
    [
      { name: "chains", key: "3" },
      { name: "open the chain", key: ENTER },
    ],
    "chain",
  );
  return frames;
}

/** A command loop's own page: every fire with its outcome, its exit code and its size.
 * The fire strip on the row (ADR-0015) is the summary; this is the record. */
export async function renderCommandLoop() {
  const frames = await drive(
    [
      { name: "loops", key: "2" },
      { name: "open the loop", key: ENTER },
    ],
    "cmd-loop",
  );
  return frames;
}

/** The list with the filter on `failed`: what a failure looks like as a row, and that
 * the filter keeps the reason (status, exit code) and drops the rest. */
export async function renderFailed() {
  // The panel opens on every status, so `failed` is two presses up the walk.
  const frames = await drive(filterSteps("failed"), "failed");
  return frames;
}

/** The search box with a query that hits: the list narrowed to the matching records,
 * matched on the name and on the command both. */
export async function renderSearch() {
  // Every status is what the panel opens on, so the query is typed on the picture
  // the panel already shows; a default that ever narrows again is walked back here.
  const steps = filterSteps("all");
  const frames = await drive(
    [
      ...steps,
      { name: "search", key: "/" },
      // Typing is not a key the footer lists; the badge names the mode, not the letter.
      { name: "r", key: "r", badge: "/" },
      { name: "u", key: "u", badge: "/" },
      { name: "n", key: "n", badge: "/" },
    ],
    "search",
  );
  return frames;
}

/**
 * The settings view: `s` from the list opens it on the first row, and the page shows
 * what a reader needs to decide — which layer owns each value, and whether a change
 * is live. The snapshot is built by `readSettings` from the same kind of files a user
 * has, so the badges are the real resolution and not a caption typed by hand.
 */
export async function renderSettings() {
  const panelSource = { ...source, settings: () => settingsSnapshot };
  // One `↓` lands on `maxRunningTasks`, the row that shows the whole model at once:
  // an env value, a project value, the `⚠ env` tag and a filled `Layers:` line.
  const frames = await drive(
    [
      { name: "settings", key: "s" },
      { name: "max-running-tasks", key: DOWN },
    ],
    "settings",
    undefined,
    "",
    panelSource,
  );
  return frames;
}
