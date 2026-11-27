/**
 * The palette the previews paint with, and the ANSI theme the panel colours
 * itself through.
 *
 * `TasksPanel` only ever asks for the tokens below, so a fake theme is enough
 * to render it outside pi — no terminal, no pi runtime.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

export const PALETTE = {
  text: "#e6edf3",
  muted: "#96a0ad",
  dim: "#68707e",
  accent: "#b49cfc",
  borderMuted: "#2b3242",
  borderAccent: "#8b7bf0",
  success: "#4cc38a",
  error: "#f2777a",
  warning: "#e3b341",
  selectedBg: "#202636",
  // The panel a detach card paints itself on: the host's `toolPendingBg` slot.
  toolPendingBg: "#1a202d",
  // The panel the host paints behind a message card (custom-message.js); a copy
  // of pi's own `violet` slot, so a card shot here matches the transcript.
  customMessageBg: "#2a2040",
};

const rgb = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** A 24-bit ANSI theme object shaped like the one pi hands to a panel. */
export function makeTheme() {
  return {
    fg: (colour, text) => {
      const value = PALETTE[colour];
      if (value === undefined || text === "") return text;
      const [r, g, b] = rgb(value);
      return `\u001b[38;2;${r};${g};${b}m${text}\u001b[39m`;
    },
    bg: (colour, text) => {
      const value = PALETTE[colour];
      if (value === undefined || text === "") return text;
      const [r, g, b] = rgb(value);
      return `\u001b[48;2;${r};${g};${b}m${text}\u001b[49m`;
    },
    bold: (text) => `\u001b[1m${text}\u001b[22m`,
    italic: (text) => `\u001b[3m${text}\u001b[23m`,
    underline: (text) => `\u001b[4m${text}\u001b[24m`,
    inverse: (text) => `\u001b[7m${text}\u001b[27m`,
    strikethrough: (text) => `\u001b[9m${text}\u001b[29m`,
  };
}

/** Fail loudly when a coloured glyph is counted as wider than one column. */
export function assertWidths(theme) {
  const probe = theme.fg("accent", "●");
  if (visibleWidth(probe) !== 1) {
    throw new Error(`coloured glyph counted as ${String(visibleWidth(probe))} columns`);
  }
}
