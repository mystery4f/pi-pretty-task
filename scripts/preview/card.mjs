/**
 * The detach card as the transcript draws it: the shipped renderer from `dist/`,
 * the preview palette, one card per trigger.
 *
 * A card is a session entry, not a panel page, so `render.mjs` cannot reach it
 * with keystrokes — this file hands the entry straight to the renderer, which is
 * also why the image is worth having: nobody sees the card in a `/tasks` shot.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { renderTaskDetached, TASK_DETACHED_ENTRY_TYPE } from "../../dist/ui/notification.js";
import { makeTheme } from "./theme.mjs";

const WIDTH = 96;

/** Both triggers, so the two wordings can be read side by side in one image. */
export const CARDS = [
  { id: "bg-7h3q2", trigger: "shortcut", afterSeconds: 40 },
  { id: "bg-7h3q2", trigger: "timeout", afterSeconds: 91 },
];

export function renderDetachCards() {
  const theme = makeTheme();
  const lines = [];
  for (const data of CARDS) {
    const component = renderTaskDetached(
      { type: "custom", customType: TASK_DETACHED_ENTRY_TYPE, data },
      { expanded: false, keyText: () => "", keyHint: () => "" },
      theme,
    );
    if (component === undefined) throw new Error("the detach card drew nothing");
    for (const line of component.render(WIDTH)) {
      const width = visibleWidth(line);
      if (width > WIDTH) throw new Error(`card line is ${String(width)} columns, wider than ${String(WIDTH)}: ${line}`);
      lines.push(line + " ".repeat(WIDTH - width));
    }
    lines.push("");
  }
  // The transcript owns the gap between two entries; one trailing row is enough here.
  lines.pop();
  return lines;
}
