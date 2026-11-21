#!/usr/bin/env node
/**
 * Regenerate the README images from the real panel.
 *
 *   npm run preview          # build, then write docs/preview*.{png,gif}
 *   PREVIEW_BROWSER=/path/to/chrome npm run preview
 *
 * The panel comes from `dist/`, so a change in `src/ui/panel/` lands in the
 * images the next time this runs. Scratch HTML and frames go to `.tmp/preview/`.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { terminalPage } from "./page.mjs";
import { renderIteration, renderList, renderTail, renderWalk } from "./render.mjs";
import { launchBrowser, screenshot, writeGif } from "./shoot.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DOCS = `${ROOT}docs/`;
const SCRATCH = `${ROOT}.tmp/preview/`;
const TITLE = "pi — /tasks — ~/work/storefront";

const kb = (path) => Math.round(statSync(path).size / 102.4) / 10;

function writePage(name, { lines, rows }) {
  const path = `${SCRATCH}${name}.html`;
  writeFileSync(path, terminalPage({ lines, rows, title: TITLE }));
  return path;
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  mkdirSync(DOCS, { recursive: true });

  const list = await renderList();
  const iteration = await renderIteration();
  const tail = await renderTail();
  const walk = await renderWalk();
  // Every animation frame is padded to the tallest one, so the window keeps its size.
  const rows = Math.max(...walk.map((frame) => frame.lines.length));

  const browser = await launchBrowser(chromium);
  try {
    await screenshot(browser, {
      htmlPath: writePage("list", { lines: list }),
      outPath: `${DOCS}preview.png`,
      scale: 2,
    });
    await screenshot(browser, {
      htmlPath: writePage("iteration", { lines: iteration }),
      outPath: `${DOCS}preview-iteration.png`,
      scale: 2,
    });
    await screenshot(browser, {
      htmlPath: writePage("tail", { lines: tail }),
      outPath: `${DOCS}preview-tail.png`,
      scale: 2,
    });

    const frames = [];
    for (const [index, frame] of walk.entries()) {
      const name = `walk-${String(index).padStart(2, "0")}`;
      const png = `${SCRATCH}${name}.png`;
      await screenshot(browser, { htmlPath: writePage(name, { lines: frame.lines, rows }), outPath: png, scale: 1 });
      frames.push({ label: frame.label, data: readFileSync(png) });
      rmSync(png);
    }
    const gif = `${SCRATCH}preview.gif`;
    writeFileSync(gif, writeGif({ frames }));
    // Windows keeps a file open in a viewer, a lock a plain overwrite cannot beat.
    try {
      writeFileSync(`${DOCS}preview.gif`, readFileSync(gif));
      rmSync(gif);
    } catch (error) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
      console.log(`docs/preview.gif is open in another program — close it and re-run, or copy ${gif} into docs/`);
    }

    for (const name of ["preview.png", "preview-iteration.png", "preview-tail.png", "preview.gif"]) {
      console.log(`${name}  ${String(kb(`${DOCS}${name}`))} KB`);
    }
    for (const frame of walk) console.log(`  frame ${frame.label}`);
  } finally {
    await browser.close();
  }
}

await main();
