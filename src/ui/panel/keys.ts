/**
 * The footer and the page keys: what the panel offers to press, and the tab
 * keys that switch the list under it.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PANEL_TABS, type PanelTab, TAB_KEY } from "./model.js";

/**
 * The list's keys, widest first (ADR-0012): one model, three lists. A narrow
 * terminal takes a shorter variant whole rather than a cut-off one, so a reader
 * near the right edge never meets half a key (ticket #34).
 */
export const LIST_KEYS: readonly string[] = [
  "↑/↓ · Enter logs · k stop · f filter · o others · 1/2/3 tabs · / search · R rerun · a stop all · alt+q close",
  "↑/↓ · Enter logs · k stop · f filter · o others · 1/2/3 · / search · R rerun · alt+q close",
  "↑/↓ · Enter logs · k stop · f filter · / search · alt+q close",
  "↑/↓ · Enter · k stop · alt+q close",
];

/** The keys under a process detail, widest first, for the same reason as `LIST_KEYS`. */
export const PROCESS_KEYS: readonly string[] = [
  "↑/↓ scroll · r follow · ← list · k stop · R rerun · c path · alt+q close",
  "↑/↓ scroll · r follow · ← list · k stop · R rerun · c · alt+q",
  "↑/↓ · r follow · ← list · k stop · alt+q",
];

/**
 * The footer that fits the room, taken whole: the first candidate that fits wins,
 * and only when none does is the shortest cut. Cutting the long one instead would
 * leave a reader with `alt+q clo` and the border a column off.
 */
export function fittedFooter(candidates: readonly string[], room: number): string {
  const fit = candidates.find((candidate) => visibleWidth(candidate) <= room);
  if (fit !== undefined) return fit;
  const shortest = candidates.at(-1) ?? "";
  return truncateToWidth(shortest, Math.max(1, room), "…", false);
}

export function pad(text: string, width: number): string {
  // Width is pixels, not code units: a CJK or emoji name must not shift the columns.
  const used = visibleWidth(text);
  return used >= width ? truncateToWidth(text, width, "", false) : text + " ".repeat(width - used);
}

/**
 * The page a keypress asks for: `1`, `2`, `3` name one directly and `tab` walks from
 * the open page to the next, wrapping after the last (ADR-0012). Everything else
 * returns `undefined` and stays a row key.
 */
export function pageKey(data: string, current: PanelTab): PanelTab | undefined {
  const named = TAB_KEY.get(data);
  if (named !== undefined) return named;
  if (matchesKey(data, "tab")) {
    const index = PANEL_TABS.indexOf(current);
    return PANEL_TABS[(index + 1) % PANEL_TABS.length] ?? "processes";
  }
  return undefined;
}
