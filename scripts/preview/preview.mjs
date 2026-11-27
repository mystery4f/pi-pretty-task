#!/usr/bin/env node
/**
 * Regenerate the README images from the real panel.
 *
 *   npm run preview          # build, then write docs/preview*.{png,gif}
 *   npm run preview -- --only cmd-loop   # rewrite one image, leave the rest alone
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
const TRANSCRIPT_TITLE = "pi — transcript — ~/work/storefront";
const EDITOR_TITLE = "pi — above the editor";

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

  // `--only <label>` writes one image and leaves every other file alone: a re-run
  // otherwise rewrites all eleven, and the rasteriser moves a few hundred bytes on
  // images nothing changed — noise in the diff, and clearing it with `git checkout --`
  // can throw away a real change sitting beside it.
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex === -1 ? undefined : process.argv[onlyIndex + 1];
  const writeGifWanted = only === undefined || only === "preview.gif";
  const shots = [
    { label: "list", lines: list, out: "preview.png" },
    { label: "iteration", lines: iteration, out: "preview-iteration.png" },
    { label: "tail", lines: tail, out: "preview-tail.png" },
    { label: "chain", lines: chain, out: "preview-chain.png" },
    { label: "cmd-loop", lines: commandLoop, out: "preview-cmdloop.png" },
    { label: "failed", lines: failed, out: "preview-failed.png" },
    { label: "search", lines: search, out: "preview-search.png" },
    { label: "detach", lines: cards, out: "preview-detach.png", title: TRANSCRIPT_TITLE },
    { label: "cards", lines: messages, out: "preview-cards.png", title: TRANSCRIPT_TITLE },
    { label: "status", lines: status, out: "preview-status.png", title: EDITOR_TITLE },
  ];
  const chosen = shots.filter((shot) => only === undefined || only === shot.label || only === shot.out);
  if (chosen.length === 0) {
    throw new Error(`no image named ${only}: one of ${shots.map((shot) => shot.label).join(", ")}, preview.gif`);
  }
  const wrote = [];
  const browser = await launchBrowser(chromium);
  try {
    for (const shot of chosen) {
      await screenshot(browser, {
        htmlPath: writePage(shot.label, { lines: shot.lines, title: shot.title }),
        outPath: `${DOCS}${shot.out}`,
        scale: 2,
      });
      wrote.push(shot.out);
    }

    if (writeGifWanted) {
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
        wrote.push("preview.gif");
      } catch (error) {
        if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
        console.log(`docs/preview.gif is open in another program — close it and re-run, or copy ${gif} into docs/`);
      }
    }

    for (const name of wrote) console.log(`${name}  ${String(kb(`${DOCS}${name}`))} KB`);
    if (writeGifWanted) for (const frame of walk) console.log(`  frame ${frame.label}`);
  } finally {
    await browser.close();
  }
}

await main();
