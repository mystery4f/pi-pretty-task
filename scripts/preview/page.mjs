/**
 * Turns captured panel frames into a standalone HTML page: one rounded terminal
 * window, the panel's ANSI lines inside it, nothing else.
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
 * One terminal window holding `lines`.
 *
 * `rows` pads the body to a fixed height, so every frame of an animation has
 * the same size and the window does not jump between frames.
 */
export function terminalPage({ lines, rows, title }) {
  const body = [...lines];
  // The panel ends with blank rows meant for a live terminal; a screenshot does not want them.
  while (body.length > 0 && body.at(-1).trim() === "") body.pop();
  // Every frame of an animation keeps the terminal's height, so the window does
  // not jump between frames; the empty rows are the space a real terminal keeps.
  while (rows !== undefined && body.length < rows) body.push("");
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
    border: 1px solid #303a52;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 30px 70px -30px rgba(0, 0, 0, 0.9), 0 0 0 1px rgba(139, 123, 240, 0.08),
      0 18px 60px -35px rgba(139, 123, 240, 0.55);
  }
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
    font-family: "Cascadia Mono", "Cascadia Code", Consolas, monospace;
    font-size: 12px;
    color: #7f8a9c;
    letter-spacing: 0.02em;
  }
  pre {
    margin: 0;
    padding: 14px 16px 16px;
    background: #0d1119;
    color: ${PALETTE.text};
    font-family: "Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, monospace;
    font-size: 13.5px;
    line-height: 19px;
    font-variant-ligatures: none;
    font-feature-settings: "calt" 0, "liga" 0;
    white-space: pre;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }
</style>
<div class="stage">
  <div class="window">
    <div class="bar">
      <span class="dot" style="background:#ff5f57"></span>
      <span class="dot" style="background:#febc2e"></span>
      <span class="dot" style="background:#28c840"></span>
      <span class="title">${escapeHtml(title)}</span>
    </div>
    <pre>${body.map(lineHtml).join("\n")}</pre>
  </div>
</div>
</html>
`;
}
