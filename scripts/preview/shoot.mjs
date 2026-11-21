/**
 * Photographing the pages: one headless Chromium (an installed Edge or Chrome,
 * never a downloaded bundle) and a GIF assembled from per-frame screenshots.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import gifenc from "gifenc";
import { PNG } from "pngjs";

const BROWSERS = [
  process.env.PREVIEW_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((candidate) => candidate !== undefined);

/** Launch the first browser that starts, so the script needs no install step. */
export async function launchBrowser(chromium) {
  const problems = [];
  for (const candidate of BROWSERS) {
    if (!existsSync(candidate)) continue;
    try {
      return await chromium.launch({ executablePath: candidate });
    } catch (error) {
      problems.push(`${candidate}: ${error.message}`);
    }
  }
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel });
    } catch (error) {
      problems.push(`${channel}: ${error.message}`);
    }
  }
  throw new Error(
    `no Chromium to drive; install Chrome or Edge, or set PREVIEW_BROWSER:\n  ${problems.join("\n  ")}`,
  );
}

/** Screenshot the page's `.stage` — the framed window plus its margin. */
export async function screenshot(browser, { htmlPath, outPath, scale }) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1200 },
    deviceScaleFactor: scale,
  });
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const stage = await page.$(".stage");
    if (stage === null) throw new Error(`no .stage in ${htmlPath}`);
    await stage.screenshot({ path: outPath });
  } finally {
    await context.close();
  }
}

/** Assemble PNG screenshots into one looping GIF. */
export function writeGif({ frames, delay = 1_100, lastDelay = 2_600 }) {
  const { GIFEncoder, applyPalette, quantize } = gifenc;
  const gif = GIFEncoder();
  frames.forEach((frame, index) => {
    const png = PNG.sync.read(frame.data);
    const palette = quantize(png.data, 192);
    gif.writeFrame(applyPalette(png.data, palette), png.width, png.height, {
      palette,
      delay: index === frames.length - 1 ? lastDelay : delay,
      repeat: index === 0 ? 0 : undefined,
    });
  });
  gif.finish();
  return gif.bytes();
}
