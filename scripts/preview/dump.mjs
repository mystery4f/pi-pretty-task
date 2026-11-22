#!/usr/bin/env node
/**
 * Print the animation as plain text, one frame at a time, with no browser.
 *
 * The fastest way to see what a preview change did to a frame: `npm run
 * preview:dump` needs only `npm run build`, and `--only detach` narrows it to the
 * frames whose label contains that word.
 *
 *   npm run preview:dump
 *   node scripts/preview/dump.mjs --only detach
 */

import { renderDetach, renderWalk } from "./render.mjs";

const only = process.argv.indexOf("--only");
const needle = only === -1 ? undefined : process.argv[only + 1];

/** ANSI colours are invisible in a console dump and only make the columns drift. */
const plain = (line) => line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd();

// The same order the GIF uses, so a frame here is the frame there: the takeover
// first, which also leaves its task among the rows the walk moves through.
const frames = [...(await renderDetach()), ...(await renderWalk())];

for (const frame of frames) {
  if (needle !== undefined && !frame.label.includes(needle)) continue;
  console.log(`\n===== ${frame.label} (${String(frame.lines.length)} rows) =====`);
  for (const line of frame.lines) console.log(plain(line));
}
