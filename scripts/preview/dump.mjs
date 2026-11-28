#!/usr/bin/env node
/**
 * Print every preview as plain text, one frame at a time, with no browser.
 *
 * The fastest way to see what a preview change did to a frame: `npm run
 * preview:dump` needs only `npm run build`, and `--only chain` narrows it to the
 * frames whose label contains that word. Every image the README carries has a
 * frame here, so a page can be checked before a screenshot is spent on it.
 *
 * The animation's frames are `TOUR`'s, in `TOUR`'s order: this file filters that list
 * (`--only <label>`), it never keeps an order of its own. A page the gif shows and this
 * dump does not is a bug, and `scripts/preview/gif-check.mjs` is what says so.
 *
 *   npm run preview:dump
 *   node scripts/preview/dump.mjs --only chain
 */

import { renderDetachCards } from "./card.mjs";
import {
  captureTour,
  lastLines,
  renderChain,
  renderCommandLoop,
  renderFailed,
  renderIteration,
  renderList,
  renderSearch,
  renderSettings,
  renderTail,
} from "./render.mjs";
import { TOUR } from "./storyboard.mjs";
import { renderMessageCards, renderStatusLine } from "./transcript.mjs";

const only = process.argv.indexOf("--only");
const needle = only === -1 ? undefined : process.argv[only + 1];

/** ANSI colours are invisible in a console dump and only make the columns drift. */
const plain = (line) => line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd();

const frames = [
  { label: "list", lines: lastLines(await renderList()) },
  { label: "tail", lines: lastLines(await renderTail()) },
  { label: "iteration", lines: lastLines(await renderIteration()) },
  { label: "chain", lines: lastLines(await renderChain()) },
  { label: "cmd-loop", lines: lastLines(await renderCommandLoop()) },
  { label: "failed", lines: lastLines(await renderFailed()) },
  { label: "search", lines: lastLines(await renderSearch()) },
  { label: "settings", lines: lastLines(await renderSettings()) },
  // The three transcript surfaces: entries and messages, reached without keystrokes.
  { label: "detach-card", lines: renderDetachCards() },
  { label: "cards", lines: renderMessageCards() },
  { label: "status", lines: await renderStatusLine() },
  // The animation's frames, in `TOUR`'s order: this file filters that list, it never
  // keeps one of its own, so a page the gif shows is always a page the dump prints.
  ...(await captureTour(TOUR)),
];

for (const frame of frames) {
  if (needle !== undefined && !frame.label.includes(needle)) continue;
  console.log(`\n===== ${frame.label} (${String(frame.lines.length)} rows) =====`);
  for (const line of frame.lines) console.log(plain(line));
}
