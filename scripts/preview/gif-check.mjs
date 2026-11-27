#!/usr/bin/env node
/**
 * Hold `docs/preview.gif` to the storyboard, without a browser.
 *
 * The animation is described in three places — `TOUR` (what plays), `README.md`'s alt
 * text (what a reader is told it shows) and `docs/previews.md` (what a maintainer reads
 * before regenerating it). A unit test keeps those three in step in words; this script
 * is the part only the bytes can answer: does the shipped file really play `TOUR`, with
 * `TOUR`'s timing, at the height the pages need?
 *
 *   node scripts/preview/gif-check.mjs        # exit 0, or exit 1 with what is off
 *
 * It reads the gif and re-drives the renderers in memory (`captureTour`), so it needs
 * `npm run build` and nothing else: no Chromium, no screenshots, no writes.
 */
import { readFileSync } from "node:fs";

import { CANVAS_CHROME, LINE_HEIGHT } from "./page.mjs";
import { captureTour } from "./render.mjs";
import { LEGEND, LIMITS, TOUR } from "./storyboard.mjs";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
// A path argument lets the same checks price a candidate encoder's output.
const GIF = process.argv[2] ?? `${ROOT}docs/preview.gif`;

/** Frame count, canvas and the delay of each frame, straight out of the bytes. */
function readGif(path) {
  const buf = readFileSync(path);
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  let at = 13;
  if (packed & 0x80) at += 3 * 2 ** ((packed & 7) + 1);
  const frames = [];
  let pendingDelay = 0;
  while (at < buf.length) {
    const marker = buf[at];
    if (marker === 0x21) {
      const label = buf[at + 1];
      const size = buf[at + 2];
      const start = at + 3;
      if (label === 0xf9) pendingDelay = buf.readUInt16LE(start + 1) * 10;
      let cursor = start + size;
      while (buf[cursor] !== 0) cursor += buf[cursor] + 1;
      at = cursor + 1;
      continue;
    }
    if (marker === 0x2c) {
      const image = buf[at + 9];
      let cursor = at + 10;
      if (image & 0x80) cursor += 3 * 2 ** ((image & 7) + 1);
      let bytes = 0;
      let walk = cursor + 1;
      while (buf[walk] !== 0) {
        bytes += buf[walk];
        walk += buf[walk] + 1;
      }
      frames.push({ delay: pendingDelay, bytes });
      at = walk + 1;
      pendingDelay = 0;
      continue;
    }
    if (marker === 0x3b) break;
    at += 1;
  }
  return { width, height, bytes: buf.length, frames };
}

const problems = [];
const note = (message) => problems.push(message);

const gif = readGif(GIF);
const tour = await captureTour(TOUR);

if (gif.frames.length !== TOUR.length) {
  note(`the gif plays ${String(gif.frames.length)} frames, TOUR names ${String(TOUR.length)}`);
}

// Every frame is padded to the tallest page, and the legend sits below the window:
// that is the whole height, so a frame that needs more rows than this cannot fit.
// Two details a maintainer will otherwise spend an hour on:
//   - `terminalPage` pops trailing blank rows, then pads back to `rows`, and a `<pre>`
//     ending in a newline renders one line box fewer than it has blank rows — so the
//     tallest frame renders `rows - 1` text lines.
//   - a legend row renders one pixel shorter than a text row: its 19 px line box takes
//     the place of the `pre`'s bottom padding (measured at rows 1 and 30).
const rows = Math.max(...tour.map((frame) => frame.lines.length));
const renderedRows = (() => {
  const body = tour.find((frame) => frame.lines.length === rows)?.lines ?? [];
  return (body.at(-1) ?? "x").trim() === "" ? rows - 1 : rows;
})();
// A legend line is one `LINE_HEIGHT` row of DOM text, not a terminal row: it stands
// in for the pre's bottom padding, so three of them add 3 × 19 px and 16 px once.
const expectedHeight = CANVAS_CHROME + LINE_HEIGHT * renderedRows + LINE_HEIGHT * LEGEND.length;
if (gif.height !== expectedHeight) {
  note(
    `the gif is ${String(gif.height)} px tall; ${String(renderedRows)} text rows + ${String(LEGEND.length)} legend lines + ${String(CANVAS_CHROME)} of chrome is ${String(expectedHeight)}`,
  );
}
for (const [index, step] of TOUR.entries()) {
  const frame = gif.frames[index];
  if (frame === undefined) break;
  if (frame.delay !== step.ms) {
    note(`frame ${String(index)} (${step.label}) holds ${String(frame.delay)} ms, TOUR says ${String(step.ms)}`);
  }
}

const loopMs = gif.frames.reduce((sum, frame) => sum + frame.delay, 0);
if (loopMs > LIMITS.maxLoopMs) {
  note(`one loop is ${String(loopMs)} ms, over the ${String(LIMITS.maxLoopMs)} ms limit`);
}
if (gif.bytes > LIMITS.maxBytes) {
  note(`the gif is ${String(gif.bytes)} bytes, over the ${String(LIMITS.maxBytes)} byte limit`);
}

if (problems.length > 0) {
  console.error(`docs/preview.gif does not match TOUR (${String(problems.length)} problem(s)):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nRe-run `npm run preview -- --only preview.gif` after changing TOUR or a page.");
  process.exit(1);
}

const kb = (gif.bytes / 1024).toFixed(1);
console.log(`docs/preview.gif matches TOUR: ${String(TOUR.length)} frames, ${String(gif.width)}x${String(gif.height)}, ${kb} KB, one loop ${(loopMs / 1000).toFixed(1)} s`);
console.log(`  ${String(renderedRows)} text rows (the tallest page) + ${String(LEGEND.length)} legend lines`);
for (const [index, step] of TOUR.entries()) {
  const frame = gif.frames[index];
  console.log(`  ${String(index + 1).padStart(2, "0")} ${step.label.padEnd(26)} ${String(step.ms).padStart(5)} ms  ${(frame.bytes / 1024).toFixed(1)} KB`);
}
