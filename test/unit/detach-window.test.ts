/**
 * The minute a detach closes the front for: how long it lasts, what it refuses, and
 * what it says. The wording is the feature — a refusal the model cannot act on is
 * only a wall (ADR-0026).
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { describe, expect, it } from "vitest";
import { DETACH_QUIET_MS, DetachWindow } from "../../src/tasks/process/foreground.js";

/** A window on a clock the test owns. */
function setup(): { window: DetachWindow; advance: (ms: number) => void } {
  let now = 1_000_000;
  const window = new DetachWindow(() => now);
  return { window, advance: (ms) => (now += ms) };
}

describe("the window a detach opens", () => {
  it("is closed until a detach happens", () => {
    const { window } = setup();
    expect(window.open()).toBeUndefined();
    expect(window.refusal()).toBeUndefined();
  });

  it("stays open for the quiet minute and names the task", () => {
    const { window, advance } = setup();
    window.note({ taskId: "bg-3", trigger: "shortcut", afterSeconds: 7 });

    const mark = window.open();
    expect(mark?.taskId).toBe("bg-3");
    expect(mark?.trigger).toBe("shortcut");

    advance(DETACH_QUIET_MS - 1);
    expect(window.open()).toBeDefined();

    advance(1);
    expect(window.open()).toBeUndefined();
    expect(window.refusal()).toBeUndefined();
  });

  it("says what happened, what to use instead and how long is left", () => {
    const { window, advance } = setup();
    window.note({ taskId: "bg-3", trigger: "timeout", afterSeconds: 120 });
    advance(15_000);

    const refusal = window.refusal() ?? "";
    expect(refusal).toContain("bg-3 was just moved to the background");
    // The timeout branch reports the hold it measured, not a zero it invented.
    expect(refusal).toContain("held the front for 120s");
    expect(refusal).toContain("pretty_task_bg_run");
    expect(refusal).toContain("refused for 45s more");
  });

  it("measures the remaining seconds from the newest detach", () => {
    const { window, advance } = setup();
    window.note({ taskId: "bg-1", trigger: "shortcut", afterSeconds: 1 });
    advance(30_000);
    window.note({ taskId: "bg-2", trigger: "shortcut", afterSeconds: 2 });

    expect(window.open()?.taskId).toBe("bg-2");
    expect(window.refusal()).toContain("bg-2");
    expect(window.refusal()).toContain("refused for 60s more");
  });
});
