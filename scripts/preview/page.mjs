/**
 * Turns captured panel frames into a standalone HTML page: one rounded terminal
 * window, the panel's ANSI lines inside it, and — real DOM, never fake terminal
 * rows — a strip under the text, a key badge in the bar, and the key trail on the
 * right.
 *
 * A frame is a list of rows that already carry colour; the page keeps them as
 * text so the browser renders them with a real monospace font.
 */

import { PALETTE } from "./theme.mjs";

const ESCAPE = /\u001b\[([0-9;]*)m/g;

const escapeHtml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const hex = (r, g, b) =>
  `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;

/** Apply one SGR parameter list to the running style. */
function apply(params, style) {
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index];
    if (code === 1) style.bold = true;
    else if (code === 22) style.bold = false;
    else if (code === 3) style.italic = true;
    else if (code === 23) style.italic = false;
    else if (code === 4) style.underline = true;
    else if (code === 24) style.underline = false;
    else if (code === 7) style.inverse = true;
    else if (code === 27) style.inverse = false;
    else if (code === 9) style.strike = true;
    else if (code === 29) style.strike = false;
    else if (code === 38 && params[index + 1] === 2) {
      style.fg = hex(params[index + 2], params[index + 3], params[index + 4]);
      index += 4;
    } else if (code === 48 && params[index + 1] === 2) {
      style.bg = hex(params[index + 2], params[index + 3], params[index + 4]);
      index += 4;
    } else if (code === 39) style.fg = null;
    else if (code === 49) style.bg = null;
  }
}

/** Split one coloured line into `{ text, style }` runs. */
export function ansiRuns(line) {
  const style = {
    fg: null,
    bg: null,
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    strike: false,
  };
  const runs = [];
  let index = 0;
  const push = (text) => {
    if (text !== "") runs.push({ text, style: { ...style } });
  };
  for (const match of line.matchAll(ESCAPE)) {
    push(line.slice(index, match.index));
    apply(match[1].split(";").map(Number), style);
    index = match.index + match[0].length;
  }
  push(line.slice(index));
  return runs;
}

function css(runStyle) {
  const { fg, bg, bold, italic, underline, inverse, strike } = runStyle;
  const rules = [];
  // Inverse swaps the two colours, the way a terminal renders SGR 7.
  const foreground = inverse ? bg : fg;
  const background = inverse ? fg : bg;
  if (foreground !== null) rules.push(`color:${foreground}`);
  if (background !== null) rules.push(`background-color:${background}`);
  if (bold) rules.push("font-weight:600");
  if (italic) rules.push("font-style:italic");
  const decorations = [underline ? "underline" : "", strike ? "line-through" : ""].join(" ").trim();
  if (decorations !== "") rules.push(`text-decoration:${decorations}`);
  return rules.join(";");
}

function lineHtml(line) {
  return ansiRuns(line)
    .map((run) => {
      const style = css(run.style);
      const text = escapeHtml(run.text);
      return style === "" ? text : `<span style="${style}">${text}</span>`;
    })
    .join("");
}

/**
 * The height below the text: bar, its border, the pre's padding and the stage's.
 * Measured from a shipped frame — 965×468 holds 17 text rows at `LINE_HEIGHT` 19,
 * so 468 − 17 × 19 = 145 — and asserted against the gif by `gif-check.mjs`, so a
 * style change here fails the check instead of quietly resizing every image.
 */
export const CANVAS_CHROME = 145;

/** One text row: the `pre`'s line-height, and the strip's too. */
export const LINE_HEIGHT = 19;

/** Rows a strip holds — the legend's three lines, or the editor's prompt and hint. */
export const STRIP_LINES = 3;

const MONO = `"Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, monospace`;

/**
 * The strip under the text: either three lines of legend, or the editor a reader
 * typed into. Both are real DOM and both are exactly `STRIP_LINES × LINE_HEIGHT`
 * plus the 16 px the `pre` hands over, so the canvas height stays predictable.
 */
function stripHtml({ legend, editor }) {
  // A still image passes neither, and gets no wrapper at all: its bytes must not move.
  if (legend === undefined && editor === undefined) return "";
  // One wrapper, always: the 16 px the `pre` hands over lives on it, so neither the
  // key trail nor the badge (both absolutely placed after it in the DOM) can change
  // the height by taking `:last-child` away from the strip.
  if (editor !== undefined) {
    return `<div class="stripwrap"><div class="editor">
      <div class="editor-line"><span class="prompt">&gt;</span><span class="typed">${escapeHtml(editor.text)}</span><span class="caret"></span></div>
      <div class="editor-line hint">${escapeHtml(editor.hint ?? "")}</div>
      <div class="editor-line hint">${escapeHtml(editor.below ?? "")}</div>
    </div></div>`;
  }
  const lines = legend ?? [];
  return `<div class="stripwrap">${lines.map((line) => `<div class="strip legend">${escapeHtml(line)}</div>`).join("\n    ")}</div>`;
}

/**
 * The keys pressed so far, oldest first, as chips in the title bar.
 *
 * A trail, not a rail: the panel paints every text row to full width, so a column
 * against the right edge would sit on top of the rows. The bar has room the picture
 * does not otherwise use, and the newest chip is the key that produced this frame.
 * Only the tail is drawn — a reader needs to see where they came from, not the whole
 * history, and a bar that wrapped would change the window's height.
 */
const TRAIL_CHIPS = 6;

function hudHtml(hud) {
  if (hud === undefined || hud.length === 0) return "";
  const shown = hud.slice(-TRAIL_CHIPS);
  const chips = shown
    .map((key, index) => `<span class="chip${index === shown.length - 1 ? " now" : ""}">${escapeHtml(key)}</span>`)
    .join("");
  return `<span class="hud">${chips}</span>`;
}

/**
 * One terminal window holding `lines`.
 *
 * `rows` pads the body to a fixed height, so every frame of an animation has
 * the same size and the window does not jump between frames. `legend` or `editor`
 * draws the strip under the text — one or the other, never both. `badge` is the key
 * this frame answers to, `hud` the keys it answers to plus every one before it.
 * Every overlay is placed, never laid out, so none of them costs a row and a still
 * image that passes none of them keeps its exact bytes.
 */
export function terminalPage({ lines, rows, title, legend, editor, columns, badge, hud }) {
  const body = [...lines];
  // The panel ends with blank rows meant for a live terminal; a screenshot does not want them.
  while (body.length > 0 && body.at(-1).trim() === "") body.pop();
  // Every frame of an animation keeps the terminal's height, so the window does
  // not jump between frames; the empty rows are the space a real terminal keeps.
  while (rows !== undefined && body.length < rows) body.push("");
  const strip = stripHtml({ legend, editor });
  const hasStrip = strip !== "";
  // The key this frame answers to, as a real keycap in the window: absolutely placed,
  // so it never takes a row and the canvas height stays predictable. When the key trail
  // is drawn its newest chip is already that key, so the keycap would print it twice.
  const keycap =
    badge === undefined || badge === "" || hud !== undefined ? "" : `<span class="keycap">${escapeHtml(badge)}</span>`;
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; background: #0b0d12; }
  body { display: inline-block; }
  .stage {
    display: inline-block;
    padding: 40px 44px;
    background:
      radial-gradient(120% 140% at 10% -10%, #232b4d 0%, rgba(16,19,28,0) 55%),
      radial-gradient(100% 120% at 100% 110%, #2a1f45 0%, rgba(16,19,28,0) 50%),
      #0b0d12;
  }
  .window {
    position: relative;
    border: 1px solid #303a52;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 30px 70px -30px rgba(0, 0, 0, 0.9), 0 0 0 1px rgba(139, 123, 240, 0.08),
      0 18px 60px -35px rgba(139, 123, 240, 0.55);
  }
  /* The key a frame answers to. Placed, not laid out: it costs no row, so the height a
     maintainer predicts stays the height the browser draws. */
  .keycap {
    position: absolute;
    top: 5px;
    right: 12px;
    padding: 1px 9px;
    border: 1px solid #4a5470;
    border-radius: 6px;
    background: #1c2333;
    color: #e6ebf5;
    font-family: ${MONO};
    font-size: 13px;
    line-height: 18px;
    box-shadow: 0 1px 0 #0d1119;
  }
  /* Every key pressed so far, newest last: one row of chips in the bar, kept clear of
     the keycap on the right. The bar is a fixed 32 px and the chips do not wrap, so the
     trail cannot change the canvas height. */
  .hud {
    display: flex;
    justify-content: flex-end;
    gap: 4px;
    margin-left: auto;
    margin-right: 104px;
    min-width: 0;
    overflow: hidden;
    flex: 0 1 auto;
  }
  .chip {
    padding: 1px 8px;
    border: 1px solid #3a4459;
    border-radius: 6px;
    background: rgba(20, 25, 37, 0.94);
    color: #8d97a9;
    font-family: ${MONO};
    font-size: 11.5px;
    line-height: 17px;
    white-space: nowrap;
  }
  .chip.now { border-color: #8b7bf0; color: #e6ebf5; }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 14px;
    background: #161b26;
    border-bottom: 1px solid #262f42;
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; }
  .title {
    margin-left: 8px;
    font-family: ${MONO};
    font-size: 12px;
    color: #7f8a9c;
    letter-spacing: 0.02em;
  }
  pre {
    margin: 0;
    padding: 14px 16px 16px;
    background: #0d1119;
    color: ${PALETTE.text};
    font-family: ${MONO};
    font-size: 13.5px;
    line-height: 19px;
    font-variant-ligatures: none;
    font-feature-settings: "calt" 0, "liga" 0;
    white-space: pre;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }
  /* The strip is DOM text, not a terminal row: mono, dimmer, exactly LINE_HEIGHT tall
     per line, and it takes over the pre's 16 px bottom padding. Three lines therefore
     add 3 × 19 px and nothing else — that is what lets gif-check.mjs predict the height. */
  .strip {
    margin: 0;
    padding: 0 16px;
    background: #0d1119;
    color: #66707f;
    font-family: ${MONO};
    font-size: 13px;
    height: 19px;
    line-height: 19px;
    white-space: pre;
    -webkit-font-smoothing: antialiased;
  }
  /* The wrapper owns the 16 px the pre gives up, so the strip is exactly
     STRIP_LINES × LINE_HEIGHT + 16 whatever else the window carries. */
  .stripwrap { padding-bottom: 16px; }
  .has-strip pre { padding-bottom: 0; }
  .editor { padding: 0 16px; background: #0d1119; font-family: ${MONO}; font-size: 13px; }
  /* The editor pi puts below the transcript: a prompt, the typed command, a cursor. */
  .editor-line { height: 19px; line-height: 19px; display: flex; align-items: center; gap: 8px; }
  .editor-line.hint { color: #4f5868; font-size: 12px; }
  .prompt { color: #8b7bf0; }
  .typed { color: #e6ebf5; }
  .caret {
    display: inline-block;
    width: 8px;
    height: 15px;
    background: #8b7bf0;
    animation: none;
  }
</style>
<div class="stage">
  <div class="window${hasStrip ? " has-strip" : ""}">
    <div class="bar">
      <span class="dot" style="background:#ff5f57"></span>
      <span class="dot" style="background:#febc2e"></span>
      <span class="dot" style="background:#28c840"></span>
      <span class="title">${escapeHtml(title)}</span>
      ${hudHtml(hud)}
      ${keycap}
    </div>
    <pre${columns === undefined ? "" : ` style="width:${String(columns)}ch"`}>${body.map(lineHtml).join("\n")}</pre>
    ${strip}
  </div>
</div>
</html>
`;
}
