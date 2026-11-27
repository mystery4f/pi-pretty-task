#!/usr/bin/env node
/**
 * Regenerate the README images from the real panel.
 *
 *   npm run preview          # build, then write docs/preview*.{png,gif}
 *   PREVIEW_BROWSER=/path/to/chrome npm run preview
 *   PREVIEW_FRAMES=1 npm run preview   # keep one PNG per animation frame
 *
 * The panel comes from `dist/`, so a change in `src/ui/panel/` lands in the
 * images the next time this runs. Scratch HTML and frames go to `.tmp/preview/`.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { terminalPage } from "./page.mjs";
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
import { launchBrowser, screenshot, writeGif } from "./shoot.mjs";
import { renderMessageCards, renderStatusLine } from "./transcript.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DOCS = `${ROOT}docs/`;
const SCRATCH = `${ROOT}.tmp/preview/`;
const TITLE = "pi — /tasks — ~/work/storefront";

const kb = (path) => Math.round(statSync(path).size / 102.4) / 10;

function writePage(name, { lines, rows, title = TITLE }) {
  const path = `${SCRATCH}${name}.html`;
  writeFileSync(path, terminalPage({ lines, rows, title }));
  return path;
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  mkdirSync(DOCS, { recursive: true });

  const list = await renderList();
  const iteration = await renderIteration();
  const tail = await renderTail();
  // One image per class of page: the list is not the only thing the panel can show,
  // and a reader deciding whether to install it needs to see a chain and a loop too.
  const chain = await renderChain();
  const commandLoop = await renderCommandLoop();
  const failed = await renderFailed();
  const search = await renderSearch();
  // The takeover goes first in the animation so the detached task is already one of
  // the rows the rest of the walk moves through.
  const detach = await renderDetach();
  const walk = [...detach, ...(await renderWalk())];
  // Every animation frame is padded to the tallest one, so the window keeps its size.
  const rows = Math.max(...walk.map((frame) => frame.lines.length));
  // The card is a transcript entry, so it gets its own image: the panel shots can
  // never show it, and it is the only surface a detached command leaves behind.
  const cards = renderDetachCards();
  // The other two transcript surfaces: the three notice cards, and the line the
  // widget draws above the editor while the panel is closed.
  const messages = renderMessageCards();
  const status = await renderStatusLine();

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
    await screenshot(browser, {
      htmlPath: writePage("chain", { lines: chain }),
      outPath: `${DOCS}preview-chain.png`,
      scale: 2,
    });
    await screenshot(browser, {
      htmlPath: writePage("cmd-loop", { lines: commandLoop }),
      outPath: `${DOCS}preview-cmdloop.png`,
      scale: 2,
    });
    await screenshot(browser, {
      htmlPath: writePage("failed", { lines: failed }),
      outPath: `${DOCS}preview-failed.png`,
      scale: 2,
    });
    await screenshot(browser, {
      htmlPath: writePage("search", { lines: search }),
      outPath: `${DOCS}preview-search.png`,
      scale: 2,
    });
    await screenshot(browser, {
      htmlPath: writePage("cards", { lines: cards, title: "pi — transcript — ~/work/storefront" }),
      outPath: `${DOCS}preview-detach.png`,
      scale: 2,
    });
    // The transcript, not the panel: a notice card and the line above the editor.
    await screenshot(browser, {
      htmlPath: writePage("messages", { lines: messages, title: "pi — transcript — ~/work/storefront" }),
      outPath: `${DOCS}preview-cards.png`,
      scale: 2,
    });
    await screenshot(browser, {
      htmlPath: writePage("status", { lines: status, title: "pi — above the editor" }),
      outPath: `${DOCS}preview-status.png`,
      scale: 2,
    });

    const frames = [];
    for (const [index, frame] of walk.entries()) {
      const name = `walk-${String(index).padStart(2, "0")}`;
      const png = `${SCRATCH}${name}.png`;
      await screenshot(browser, { htmlPath: writePage(name, { lines: frame.lines, rows }), outPath: png, scale: 1 });
      frames.push({ label: frame.label, data: readFileSync(png) });
      // `PREVIEW_FRAMES=1` keeps them: one frame is far easier to look at as a PNG
      // than inside a looping GIF.
      if (process.env.PREVIEW_FRAMES !== "1") rmSync(png);
    }
    const gif = `${SCRATCH}preview.gif`;
    // The takeover is the newest thing in the clip and the easiest to miss: two
    // frames, then eleven more of walking. Each of its frames holds twice as long
    // as a walk frame, so a reader entering mid-loop still catches the keypress.
    const delays = walk.map((frame) => (frame.label.startsWith("detach:") ? 2_400 : undefined));
    writeFileSync(gif, writeGif({ frames, delays }));
    // Windows keeps a file open in a viewer, a lock a plain overwrite cannot beat.
    try {
      writeFileSync(`${DOCS}preview.gif`, readFileSync(gif));
      rmSync(gif);
    } catch (error) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
      console.log(`docs/preview.gif is open in another program — close it and re-run, or copy ${gif} into docs/`);
    }

    const images = [
      "preview.png",
      "preview-iteration.png",
      "preview-tail.png",
      "preview-chain.png",
      "preview-cmdloop.png",
      "preview-failed.png",
      "preview-search.png",
      "preview-detach.png",
      "preview-cards.png",
      "preview-status.png",
      "preview.gif",
    ];
    for (const name of images) {
      console.log(`${name}  ${String(kb(`${DOCS}${name}`))} KB`);
    }
    for (const frame of walk) console.log(`  frame ${frame.label}`);
  } finally {
    await browser.close();
  }
}

await main();
