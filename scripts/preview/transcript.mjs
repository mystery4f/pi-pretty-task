/**
 * The two surfaces that are not a panel page: the card a notice leaves in the
 * transcript, and the one line that stands in for the panel while it is closed.
 *
 * Both come from `dist/`, like the panel shots: the message renderers and
 * `statusLineText` are the shipped functions, so a change in `src/ui/` lands in
 * the image instead of drifting away from it. A message cards sits inside the
 * host's own panel — `components/custom-message.js` wraps whatever a renderer
 * returns in `new Box(1, 1, (t) => theme.bg("customMessageBg", t))` — so this
 * file draws that frame too; skipping it would show a card with no background,
 * which is not what a reader sees.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { LOOP_WAKE_CUSTOM_TYPE, renderLoopWake } from "../../dist/ui/loop-wake.js";
import {
  LOOP_SIGNAL_CUSTOM_TYPE,
  renderLoopSignal,
  renderTaskFinished,
  TASK_FINISHED_CUSTOM_TYPE,
} from "../../dist/ui/notification.js";
import { statusLineText } from "../../dist/ui/tasks-command.js";
import { CLOCK, source } from "./fixtures.mjs";
import { makeTheme } from "./theme.mjs";

const WIDTH = 96;
const THEME = makeTheme();
const OPTIONS = { expanded: false, outputPad: 0, keyText: () => "", keyHint: () => "" };

const testLog = [
  " RUN  v5.1.0 /home/mystery/work/storefront",
  "",
  " ❯ test/integration/checkout.spec.ts (3 tests | 1 failed) 2.41s",
  "   × posts an order when the cart holds one line item",
  "     → expected 201, received 502",
  "",
  " Test Files  1 failed | 2 passed (3)",
  "      Tests  1 failed | 27 passed (28)",
].join("\n");

const signalLog = [
  "ci-status: main is 3 commits ahead of the deployed build",
  "  deploy  a91c4e2  (2h ago)",
  "  head    4f0b7d1  (11m ago)",
  "exit: 1 — the branch moved since the last deploy",
].join("\n");

/** Three cards, one per registered message renderer. */
const CARDS = [
  {
    type: TASK_FINISHED_CUSTOM_TYPE,
    render: renderTaskFinished,
    content: "name: test\nid: bg-9vw3b…",
    details: {
      id: "bg-9vw3b",
      name: "test",
      kind: "process",
      status: "failed",
      durationMs: 64_000,
      exitCode: 1,
      outputTail: testLog,
      outputTruncated: false,
    },
  },
  {
    type: LOOP_SIGNAL_CUSTOM_TYPE,
    render: renderLoopSignal,
    content: "name: ci-poll\nid: lc-7k2m9…",
    details: {
      id: "lc-7k2m9",
      name: "ci-poll",
      command: "bash scripts/ci-status.sh --branch main",
      fire: 8,
      exitCode: 1,
      durationMs: 2_100,
      endedAt: CLOCK - 300_000,
      outputHead: signalLog,
      outputLines: 4,
      outputPath: "/home/mystery/work/storefront/.pi/tasks/session/lc-7k2m9-8.log",
    },
  },
  {
    type: LOOP_WAKE_CUSTOM_TYPE,
    render: renderLoopWake,
    content: "Review the commits from the last hour, run the unit suite and report anything broken.",
    details: { id: "lp-9f3kd", name: "hourly-review", schedule: "0 * * * *", fire: 6 },
  },
];

/** Paint one message the way the host paints it: a panel, one column of padding. */
function span(text, width) {
  const used = visibleWidth(text);
  if (used > width) throw new Error(`card line is ${String(used)} columns, wider than ${String(width)}: ${text}`);
  return THEME.bg("customMessageBg", text + " ".repeat(width - used));
}

export function renderMessageCards() {
  const lines = [];
  for (const card of CARDS) {
    const component = card.render(
      {
        role: "custom",
        customType: card.type,
        content: card.content,
        display: true,
        details: card.details,
        timestamp: CLOCK,
      },
      OPTIONS,
      THEME,
    );
    if (component === undefined) throw new Error(`the ${card.type} card drew nothing`);
    const body = component.render(WIDTH - 2).map((line) => ` ${line}`);
    // Box(1, 1): one padded row above and below, one column on each side.
    lines.push(span("", WIDTH));
    for (const line of body) lines.push(span(line, WIDTH));
    lines.push(span("", WIDTH));
    lines.push("");
  }
  lines.pop();
  return lines;
}

/**
 * The summary line with the fixture session behind it: live processes, one loop
 * whose condition is raised, the records that have ended, and the way back in.
 * The widget slot takes plain strings, so the line is dim — the widget's style,
 * not a choice made here.
 */
export async function renderStatusLine() {
  const views = await source.list();
  const line = statusLineText(views.map((view) => view.task));
  if (!line.includes("running")) throw new Error(`the status line counted nothing running: ${line}`);
  return ["", THEME.fg("dim", line), ""];
}
