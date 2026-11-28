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
  PANEL_COLUMNS,
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
import { launchBrowser, screenshot, writeGif } from "./shoot.mjs";
import { LEGEND, TOUR } from "./storyboard.mjs";
import { renderMessageCards, renderStatusLine } from "./transcript.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DOCS = `${ROOT}docs/`;
const SCRATCH = `${ROOT}.tmp/preview/`;
const TITLE = "pi — /tasks — ~/work/storefront";
const TRANSCRIPT_TITLE = "pi — transcript — ~/work/storefront";
const EDITOR_TITLE = "pi — above the editor";
/**
 * The tour happens where the capture happened, so its titles name that directory: a
 * still may keep the sample path it always had (its bytes must not move), an animation
 * frame must not claim a directory the record never ran in.
 */
const TOUR_HOME = "~/pi-pretty-task";
const TOUR_TITLE = `pi — /tasks — ${TOUR_HOME}`;
const tourTitle = (frame) => (frame.title ?? TOUR_TITLE).replace("~/work/storefront", TOUR_HOME);

const kb = (path) => Math.round(statSync(path).size / 102.4) / 10;

/**
 * One page, written to the scratch directory. Everything the page can draw is passed
 * straight through: a still passes nothing extra, an animation frame passes the strip
 * it wants (editor or legend) and the keys pressed so far.
 */
function writePage(name, page) {
  const path = `${SCRATCH}${name}.html`;
  // `title: undefined` must not override the default: a still passes `title: shot.title`,
  // which is `undefined` for every panel shot, and `escapeHtml(undefined)` throws.
  writeFileSync(path, terminalPage({ title: TITLE, ...page, title: page.title ?? TITLE }));
  return path;
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  mkdirSync(DOCS, { recursive: true });

  const list = lastLines(await renderList());
  const iteration = lastLines(await renderIteration());
  const tail = lastLines(await renderTail());
  // One image per class of page: the list is not the only thing the panel can show,
  // and a reader deciding whether to install it needs to see a chain and a loop too.
  const chain = lastLines(await renderChain());
  const commandLoop = lastLines(await renderCommandLoop());
  const failed = lastLines(await renderFailed());
  const search = lastLines(await renderSearch());
  const settings = lastLines(await renderSettings());
  // The animation plays `TOUR`, in that order and with that timing: the two frames of
  // the takeover come first, so the detached task is already one of the rows the rest
  // of the walk moves through. Every frame is one a renderer already captured.
  const walk = await captureTour(TOUR);
  // Every animation frame is padded to the same height so the window keeps its size.
  // One spare row: a `<pre>` whose text ends with a newline renders one line box fewer
  // than it has blank rows, and the one frame that fills the height exactly would then
  // be 19 px taller than the rest — the encoder sizes the canvas from the first frame,
  // so that frame would be clipped.
  const rows = Math.max(...walk.map((frame) => frame.lines.length)) + 1;
  // The card is a transcript entry, so it gets its own image: the panel shots can
  // never show it, and it is the only surface a detached command leaves behind.
  const cards = renderDetachCards();
  // The other two transcript surfaces: the three notice cards, and the line the
  // widget draws above the editor while the panel is closed.
  const messages = renderMessageCards();
  const status = await renderStatusLine();

  // `--only <label>` writes one image and leaves every other file alone: a re-run
  // otherwise rewrites all twelve, and the rasteriser moves a few hundred bytes on
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
    { label: "settings", lines: settings, out: "preview-settings.png" },
    { label: "detach", lines: cards, out: "preview-detach.png", title: TRANSCRIPT_TITLE },
    { label: "cards", lines: messages, out: "preview-cards.png", title: TRANSCRIPT_TITLE },
    { label: "status", lines: status, out: "preview-status.png", title: EDITOR_TITLE },
  ];
  const chosen = shots.filter((shot) => only === undefined || only === shot.label || only === shot.out);
  // `--only preview.gif` names the animation and therefore no image at all, which is
  // the documented way to re-render just the clip: only a name that matches nothing
  // anywhere is an error.
  if (chosen.length === 0 && !writeGifWanted) {
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
      // The keys pressed so far, in order: every frame carries the whole sequence, so a
      // reader can see where they are without rewinding. A frame with no key adds nothing.
      const pressed = [];
      for (const [index, frame] of walk.entries()) {
        const step = TOUR[index];
        // The badge is the key `TOUR` says reaches this frame; if the renderer pressed
        // a different one, the image would teach a key nobody pressed.
        if (step === undefined || frame.badge !== step.key) {
          throw new Error(`frame ${frame.label} answers to ${JSON.stringify(frame.badge)}, TOUR says ${JSON.stringify(step?.key)}`);
        }
        if (frame.badge !== "") pressed.push(frame.badge);
        const name = `walk-${String(index).padStart(2, "0")}`;
        const png = `${SCRATCH}${name}.png`;
        await screenshot(browser, {
          htmlPath: writePage(name, {
            lines: frame.lines,
            rows,
            title: tourTitle(frame),
            // A session frame carries the editor it happened in; a panel frame carries the
            // legend. Both are three rows, so the canvas stays one size either way.
            ...(frame.editor === undefined ? { legend: LEGEND } : { editor: frame.editor }),
            columns: PANEL_COLUMNS,
            badge: frame.badge,
            hud: pressed,
          }),
          outPath: png,
          scale: 1,
        });
        frames.push({ label: frame.label, data: readFileSync(png) });
        // `PREVIEW_FRAMES=1` keeps them: one frame is far easier to look at as a PNG
        // than inside a looping GIF.
        if (process.env.PREVIEW_FRAMES !== "1") rmSync(png);
      }
      const gif = `${SCRATCH}preview.gif`;
      // Each frame holds for the time `TOUR` gives it: a keypress stays on screen
      // longer than a tab change, and the last frame holds longest so a reader entering
      // mid-loop catches the end state.
      const delays = walk.map((frame) => frame.ms);
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
