/**
 * The README's key list against the panel's own footer.
 *
 * A key that moves or disappears in `tasks-panel.ts` must not linger on the
 * front page, and a key the README advertises must be one the panel accepts.
 * Both sides are text, so a comparison in the suite is cheaper than a reader
 * noticing a stale key on the next release.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIST_KEYS } from "../../src/ui/tasks-panel.js";

const README = join(import.meta.dirname, "..", "..", "README.md");

/**
 * Keys the README documents that live outside the list footer: `←` goes back,
 * `c` shows the output path, `x` closes from the list. They are real, so the
 * subset check allows them.
 */
const DETAIL_KEYS = ["←", "c", "x", "1", "2", "3"];

/** A key token: one or two glyphs, a named key, or a chord. Values are not keys. */
function isKey(token: string): boolean {
  return /^(?:[^\w\s]{1,3}|Enter|Tab|Esc|space|alt\+[a-z]|shift\+[a-z])$/.test(token);
}

function keysIn(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "").filter(isKey);
}

describe("the README's key list", () => {
  it("prints the widest footer the panel can draw", async () => {
    const readme = await readFile(README, "utf8");
    const footer = readme
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("↑/↓"));

    expect(footer).toBe(LIST_KEYS[0]);
  });

  it("names only keys the panel accepts", async () => {
    const readme = await readFile(README, "utf8");
    const sentence = readme.split("\n").find((line) => line.startsWith("List keys:"));

    expect(sentence).toBeDefined();
    const widest = (LIST_KEYS[0] ?? "").split(" · ").map((segment) => segment.split(" ")[0] ?? "");
    const allowed = new Set([...widest, ...DETAIL_KEYS]);
    const documented = keysIn(sentence ?? "");

    expect(documented.length).toBeGreaterThan(4);
    expect(documented.filter((key) => !allowed.has(key))).toEqual([]);
  });
});
