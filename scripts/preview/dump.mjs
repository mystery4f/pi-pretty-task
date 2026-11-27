#!/usr/bin/env node
/**
 * Print every preview as plain text, one frame at a time, with no browser.
 *
 * The fastest way to see what a preview change did to a frame: `npm run
 * preview:dump` needs only `npm run build`, and `--only chain` narrows it to the
 * frames whose label contains that word. Every image the README carries has a
 * frame here, so a page can be checked before a screenshot is spent on it.
 *
 *   npm run preview:dump
 *   node scripts/preview/dump.mjs --only chain
 */

import { renderDetachCards } from "./card.mjs";
import {
  renderChain,
  renderCommandLoop,
  renderDetach,
  renderFailed,
  renderIteration,
  renderList,
  renderSearch,
  renderTail,
  renderWalk,
} from "./render.mjs";
import { renderMessageCards, renderStatusLine } from "./transcript.mjs";

const only = process.argv.indexOf("--only");
const needle = only === -1 ? undefined : process.argv[only + 1];

/** ANSI colours are invisible in a console dump and only make the columns drift. */
const plain = (line) => line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd();

const frames = [
  { label: "list", lines: await renderList() },
  { label: "tail", lines: await renderTail() },
  { label: "iteration", lines: await renderIteration() },
  { label: "chain", lines: await renderChain() },
  { label: "cmd-loop", lines: await renderCommandLoop() },
  { label: "failed", lines: await renderFailed() },
  { label: "search", lines: await renderSearch() },
  // The three transcript surfaces: entries and messages, reached without keystrokes.
  { label: "detach-card", lines: renderDetachCards() },
  { label: "cards", lines: renderMessageCards() },
  { label: "status", lines: await renderStatusLine() },
  // The animation, in the same order the GIF uses: the takeover first, which also
  // leaves its task among the rows the walk moves through.
  ...(await renderDetach()),
  ...(await renderWalk()),
];

for (const frame of frames) {
  if (needle !== undefined && !frame.label.includes(needle)) continue;
  console.log(`\n===== ${frame.label} (${String(frame.lines.length)} rows) =====`);
  for (const line of frame.lines) console.log(plain(line));
}
