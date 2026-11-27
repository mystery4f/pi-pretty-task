/**
 * The detach card: what the user keeps in the scrollback after a command was
 * handed to the background. It is a session entry, so it survives a reload and
 * never enters the model's context — the tool result already told the model.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { describe, expect, it } from "vitest";
import { detachReason } from "../../src/tasks/process/foreground.js";
import {
  type DetachedTaskDetails,
  renderTaskDetached,
  TASK_DETACHED_ENTRY_TYPE,
} from "../../src/ui/notification.js";
import { createHarness, plainTheme } from "../support/extension-harness.js";

const TURN = { cwd: process.cwd(), sessionId: "session-detached-card" };

/** Draw one card exactly as pi draws an entry, with a theme that draws text as given. */
function drawLines(data: DetachedTaskDetails | undefined, width = 80): string[] {
  const component = renderTaskDetached(
    { type: "custom", customType: TASK_DETACHED_ENTRY_TYPE, data } as never,
    { expanded: false, keyText: () => "", keyHint: () => "" } as never,
    plainTheme(),
  );
  // A Text component pads every line to the render width; the padding is not content.
  return component === undefined ? [] : component.render(width).map((line) => line.trimEnd());
}

function draw(data: DetachedTaskDetails | undefined, width = 80): string {
  return drawLines(data, width).join("\n");
}

/** One drawn line, or the empty string when the card is shorter than the index expects. */
function lineAt(lines: readonly string[], index: number): string {
  return lines[index] ?? "";
}

describe("the detach card", () => {
  it("is registered as a session entry, so a reload still draws it", () => {
    const harness = createHarness(TURN, { now: () => 0 });
    expect(harness.entryRendererTypes).toContain(TASK_DETACHED_ENTRY_TYPE);
    // Not a message renderer: a message would be one more thing in the model's context.
    expect(harness.rendererTypes).not.toContain(TASK_DETACHED_ENTRY_TYPE);
  });

  it("frames the card: padding, a title line, a blank, then the body", () => {
    const lines = drawLines({ id: "bg-nkrja", trigger: "shortcut", afterSeconds: 40 });
    // The host adds one Spacer above the component and nothing else, so the panel and
    // its padding are the renderer's own: one blank row each side, one column each side.
    expect(lines[0]).toBe("");
    expect(lines.at(-1)).toBe("");
    expect(lineAt(lines, 1).startsWith(" ")).toBe(true);
    expect(lines[2]).toBe("");
    // Title, blank, two body lines: the shape the framed notices in the transcript have.
    expect(lines.filter((line) => line !== "")).toHaveLength(4);
  });

  it("draws the record, the trigger and how long it held, from the entry's data", () => {
    const lines = drawLines({ id: "bg-nkrja", trigger: "shortcut", afterSeconds: 40 });
    const title = lineAt(lines, 1).trim();
    expect(title).toContain("↪ moved to the background");
    expect(title).toContain("bg-nkrja");
    expect(title).toContain("held 40.0s");
    // The clause is the one the tool result carried: one trigger, one wording.
    expect(lineAt(lines, 3).trim()).toBe(detachReason({ trigger: "shortcut", afterSeconds: 40 }));
    expect(lineAt(lines, 3)).toContain("ctrl+shift+b");
    expect(lineAt(lines, 4)).toContain("pretty_task_bg_logs id=bg-nkrja");
    expect(lineAt(lines, 5)).toContain("pretty_task_bg_kill id=bg-nkrja");
  });

  it("names the deadline rather than the key when the timeout moved it", () => {
    const card = draw({ id: "bg-12", trigger: "timeout", afterSeconds: 91 });
    expect(card).toContain("held the front for 91s");
    expect(card).toContain("foreground timeout");
    expect(card).toContain("held 1m 31s");
    expect(card).not.toContain("ctrl+shift+b");
  });

  it("says the session was shutting down when that was the trigger", () => {
    const card = draw({ id: "bg-13", trigger: "shutdown", afterSeconds: 3 });
    expect(card).toContain("the session is shutting down");
    expect(card).not.toContain("ctrl+shift+b");
  });

  it("draws nothing when the entry carries no data", () => {
    expect(draw(undefined)).toBe("");
    const harness = createHarness(TURN, { now: () => 0 });
    expect(harness.renderEntry(TASK_DETACHED_ENTRY_TYPE, undefined)).toBe("");
  });

  it("keeps every line plain text and inside the panel at 40, 80 and 120 columns", () => {
    // plainTheme draws exactly what it is given: a colour leaking into the string
    // would show here as an escape, and a panel narrower than its text would push a
    // line past the width instead of wrapping it.
    const card = { id: "bg-nkrja", trigger: "shortcut", afterSeconds: 40 } as const;
    const collapsed = (lines: readonly string[]): string =>
      lines.join(" ").replaceAll(/\s+/g, " ").trim();
    const wide = drawLines(card, 120);
    for (const width of [40, 80, 120]) {
      const lines = drawLines(card, width);
      for (const line of lines) {
        expect(line.includes(String.fromCharCode(27))).toBe(false);
        expect(line).not.toContain("<");
        expect(line.length).toBeLessThanOrEqual(width);
      }
      // A narrow panel wraps the body onto more lines; it never drops a word, so the
      // three widths draw one text and differ only in whitespace.
      expect(lines.length).toBeGreaterThanOrEqual(wide.length);
      expect(collapsed(lines)).toBe(collapsed(wide));
    }
  });
});
