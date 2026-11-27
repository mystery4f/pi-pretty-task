/**
 * The animation's storyboard, in words: `TOUR` decides what plays, and this test keeps
 * the two descriptions of it — the README's alt text and the row in `docs/previews.md` —
 * saying the same thing in the same order.
 *
 * The bytes are checked by `scripts/preview/gif-check.mjs`, which needs the shipped gif;
 * this file only needs the three sources, so a wrong sentence fails before anything is
 * rendered. `readme-coverage.test.ts` next door compares *sets* of images and surfaces;
 * this one compares the *order* inside one image.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LEGEND, LIMITS, SURFACES, TOUR } from "../../scripts/preview/storyboard.mjs";
import { LIST_KEYS, PROCESS_KEYS } from "../../src/ui/panel/keys.js";
import { TASKS_SHORTCUT_LABEL } from "../../src/ui/tasks-command.js";

const ROOT = join(import.meta.dirname, "..", "..");
const README = join(ROOT, "README.md");
const PREVIEWS = join(ROOT, "docs", "previews.md");

/** The one line of `text` that shows the gif, and its 1-based line number. */
function lineShowing(text: string, needle: string): { line: string; number: number } {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.includes(needle));
  expect(index, `no line mentions ${needle}`).toBeGreaterThanOrEqual(0);
  return { line: lines[index] ?? "", number: index + 1 };
}

/** Every `needle` appears, and the first occurrence of each comes after the last. */
function expectOrdered(text: string, needles: readonly string[], where: string): void {
  let previous = -1;
  for (const needle of needles) {
    const at = text.indexOf(needle);
    expect(at, `${where} never says "${needle}"`).toBeGreaterThan(-1);
    expect(at, `${where} puts "${needle}" before the step ahead of it`).toBeGreaterThan(previous);
    previous = at;
  }
}

describe("the preview storyboard", () => {
  it("names each frame once, with a positive hold and a topic", () => {
    const labels = TOUR.map((step) => step.label);
    expect(new Set(labels).size, "two steps play the same frame").toBe(labels.length);
    for (const step of TOUR) {
      expect(step.ms, `${step.label} holds for no time`).toBeGreaterThan(0);
      expect(Number.isInteger(step.ms), `${step.label}'s hold is not whole milliseconds`).toBe(
        true,
      );
      expect(step.topic.trim().length, `${step.label} has no topic`).toBeGreaterThan(0);
      expect(
        step.mark.trim().length,
        `${step.label} has no README phrase to prove`,
      ).toBeGreaterThan(0);
      expect(step.label).toMatch(/^[a-z-]+:.+/u);
    }
    expect(TOUR.length, "a tour of one page is not a tour").toBeGreaterThanOrEqual(3);
  });

  it("fits inside the loop's own limits", () => {
    const loop = TOUR.reduce((sum, step) => sum + step.ms, 0);
    expect(loop, "one loop runs past the limit TOUR declares").toBeLessThanOrEqual(
      LIMITS.maxLoopMs,
    );
    expect(LIMITS.maxBytes).toBeGreaterThan(0);
  });

  it("keeps the README's alt text proving each step, in order", async () => {
    const readme = await readFile(README, "utf8");
    const { line, number } = lineShowing(readme, "docs/preview.gif");
    expect(number, "the gif left the top of the README").toBe(12);
    expectOrdered(
      line,
      TOUR.map((step) => step.mark),
      "the README alt text",
    );
  });

  it("lists the frames in TOUR's order in docs/previews.md", async () => {
    const previews = await readFile(PREVIEWS, "utf8");
    const { line } = lineShowing(previews, "docs/preview.gif");
    for (const step of TOUR)
      expect(line, "the previews row skips a frame").toContain(`\`${step.label}\``);
    expectOrdered(
      line,
      TOUR.map((step) => `\`${step.label}\``),
      "the previews row",
    );
    // Computed, not copied: a hold that moves in `TOUR` must move in the doc too.
    const loopSeconds = (TOUR.reduce((sum, step) => sum + step.ms, 0) / 1000).toFixed(1);
    expect(line, "the previews row does not say how long one loop runs").toContain(
      `一轮 ${loopSeconds} s`,
    );
  });

  it("explains only what a frame cannot show, under the window", () => {
    expect(LEGEND.length, "the legend grew into a second copy of the key list").toBe(3);
    const text = LEGEND.join("\n");
    expect(text).toContain("ctrl+shift+b");
    expect(text).toContain("Esc");
    expect(text).toContain("/tasks");
    for (const drawn of ["r follow", "c path", "← back"]) {
      expect(
        text,
        `the legend repeats ${drawn}, which the panel footer already draws`,
      ).not.toContain(drawn);
    }
  });

  it("shows every user-visible surface it declares", () => {
    const declared = new Set(SURFACES.map((entry) => entry.surface));
    const covered = new Set(TOUR.map((step) => step.surface));
    for (const entry of SURFACES) {
      expect(covered, `${entry.what} has no frame in the tour`).toContain(entry.surface);
    }
    for (const step of TOUR) {
      expect(declared, `frame ${step.label} names a surface no one declared`).toContain(
        step.surface,
      );
    }
  });

  it("keeps the surfaces this tour is obliged to carry", async () => {
    // `SURFACES` is the declaration, so deleting an entry would delete the requirement
    // with it. This list is the obligation: the pages that have real material behind
    // them and that a reader of the README is promised. Losing one of these is a bug.
    const required = [
      "session:transcript",
      "card:detach",
      "panel:list",
      "panel:task-detail",
      "panel:follow",
      "panel:filter",
      "panel:search",
      "notice:finished",
      "status:line",
      "result:blocked",
    ];
    const declared = new Set(SURFACES.map((entry) => entry.surface));
    const covered = new Set(TOUR.map((step) => step.surface));
    for (const surface of required) {
      expect(declared, `the tour stopped declaring ${surface}`).toContain(surface);
      expect(covered, `the tour stopped showing ${surface}`).toContain(surface);
    }
    // Everything it leaves out has to be written down, not merely forgotten.
    const previews = await readFile(PREVIEWS, "utf8");
    for (const omitted of ["panel:loops", "panel:chain-detail", "notice:signal", "notice:wake"]) {
      expect(previews, `nothing says why ${omitted} is missing`).toContain(omitted);
    }
  });

  it("badges only keys the panel or the host answers to", () => {
    // A badge names something you PRESS. The command form `/tasks` is text you type,
    // so it is not in the set: a frame that badged it would tell a reader to press a
    // key that does not exist. The door's key form is, spelled the way the hint is.
    const allowed = new Set<string>(["ctrl+shift+b", TASKS_SHORTCUT_LABEL]);
    for (const table of [LIST_KEYS, PROCESS_KEYS]) {
      for (const row of table) {
        for (const segment of row.split(" · ")) {
          const token = segment.split(" ")[0] ?? "";
          allowed.add(token);
          for (const part of token.split("/")) allowed.add(part);
        }
      }
    }
    for (const step of TOUR) {
      if (step.key === "") continue;
      expect(
        /^\/[a-z]/u.test(step.key),
        `frame ${step.label} badges "${step.key}", which is a command to type, not a key`,
      ).toBe(false);
      expect(
        allowed.has(step.key),
        `frame ${step.label} shows the key "${step.key}", which no key table lists`,
      ).toBe(true);
    }
    // One frame has to show the door being pressed, or the picture never teaches it.
    expect(TOUR.map((step) => step.key)).toContain(TASKS_SHORTCUT_LABEL);
  });

  it("tells a maintainer what to do when a surface appears", async () => {
    const previews = await readFile(PREVIEWS, "utf8");
    expect(previews).toContain("新功能上线之后");
    expect(previews, "the rule names both exits: a frame here, or a written reason").toContain(
      "不补的理由",
    );
  });

  it("tells one session, in the order a person would live it", () => {
    // The tour starts in the terminal, not in the panel: a reader who opens the gif must
    // see where the command came from before the panel takes over.
    expect(TOUR[0]?.surface, "the tour opens somewhere other than a session").toBe(
      "session:transcript",
    );
    const detach = TOUR.findIndex((step) => step.key === "ctrl+shift+b");
    expect(detach, "nothing in the tour presses the takeover key").toBeGreaterThan(0);
    const firstPanel = TOUR.findIndex((step) => step.surface.startsWith("panel:"));
    expect(firstPanel, "the panel never opens").toBeGreaterThan(detach);
  });

  it("quotes a captured store, never the fixtures", async () => {
    // The frames may not print an id this machine never held. `render.mjs` still uses the
    // fixtures for the still images — those are untouched — but the tour's own material
    // comes from `record/session.json`, and these three files are where it is read.
    for (const file of ["session.mjs", "record.mjs", "blocked.mjs"]) {
      const text = await readFile(join(ROOT, "scripts", "preview", file), "utf8");
      expect(text, `${file} builds the tour from the invented fixtures`).not.toContain(
        'from "./fixtures.mjs"',
      );
    }
    const captured: { tasks: readonly { id: string }[] } = JSON.parse(
      await readFile(join(ROOT, "scripts", "preview", "record", "session.json"), "utf8"),
    );
    const ids = captured.tasks.map((task) => task.id);
    for (const id of ["bg-v5y1b", "bg-4wu33"]) {
      expect(ids, `the capture does not hold ${id}, which the tour quotes`).toContain(id);
    }
  });

  it("writes down why the loop and chain pages are missing", async () => {
    // No local store holds a loop or chain record, so those pages have no real material
    // and the reason has to be in the doc rather than in someone's memory.
    const previews = await readFile(PREVIEWS, "utf8");
    expect(previews, "the tour dropped two pages without saying why").toContain(
      "没有 loop 和 chain 的帧",
    );
    const covered = new Set(TOUR.map((step) => step.surface));
    expect(covered.has("panel:loops"), "a loop frame reappeared without real material").toBe(false);
  });
});
