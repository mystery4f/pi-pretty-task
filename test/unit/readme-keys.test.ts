/**
 * The README's key lists against the panel's own footers, page by page.
 *
 * A key that moves or disappears in `input.ts` must not linger on the front page, and
 * a key the README advertises must be one the panel accepts **on the page it is
 * documented under**: `←` goes back from a detail, it does nothing in the list, so a
 * single whitelist covering both pages would let exactly that mistake through. The
 * door (`/tasks` or `Shift↓`) is compared verbatim against the one string the status
 * line prints, because a hint and a shortcut drift apart when each has its own copy.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIST_KEYS, PROCESS_KEYS } from "../../src/ui/panel/keys.js";
import { statusLineText, TASKS_HINT } from "../../src/ui/tasks-command.js";

const README = join(import.meta.dirname, "..", "..", "README.md");

/**
 * Keys a page answers to that no footer row prints: they are real, they just never
 * fit the one line (`x` closes from the list, `c` names the output path, `1/2/3` pick
 * a tab before the mode dispatch). Kept apart from the footers so a footer edit does
 * not need this file, and so the README cannot use them to smuggle in another page's.
 */
const PAGE_ONLY: Record<"list" | "detail", readonly string[]> = {
  list: ["x", "c", "1", "2", "3"],
  detail: ["c", "1", "2", "3"],
};

/**
 * One thing you can press: a single character (`k`, `R`, `/`), a glyph cluster
 * (`↑/↓` splits into two), a named key, or a chord. A word is never a key, which is
 * what separates `c` from `all` — values live in backticks too, and a filter name must
 * not be mistaken for a keystroke.
 */
function pressable(part: string): boolean {
  return /^(?:[A-Za-z0-9]|[^\w\s]{1,3}|Enter|Tab|Esc|space|PageUp|PageDown|alt\+.|shift\+.)$/u.test(
    part,
  );
}

/** Every character the README asks a reader to press, slash-joined tokens expanded. */
function keysIn(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1] ?? "")
    .flatMap((token) => token.split("/"))
    .filter(pressable);
}

/** The characters a reader sees, with markdown's backticks taken out. */
function prose(text: string): string {
  return text.replaceAll("`", "");
}

/** The README line that documents one page's keys. */
async function pageLine(name: "List" | "Detail"): Promise<string> {
  const readme = await readFile(README, "utf8");
  const line = readme.split("\n").find((row) => row.startsWith(`${name} keys:`));
  expect(line, `the README documents no ${name.toLowerCase()} keys`).toBeDefined();
  return line ?? "";
}

/** What one footer row offers, whole: the first token of every ` · ` segment. */
function footerTokens(row: string): string[] {
  return row.split(" · ").map((segment) => segment.split(" ")[0] ?? "");
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

  it("documents each page's keys on that page's line", async () => {
    const pages = [
      { name: "List" as const, footer: LIST_KEYS[0] ?? "", only: PAGE_ONLY.list },
      { name: "Detail" as const, footer: PROCESS_KEYS[0] ?? "", only: PAGE_ONLY.detail },
    ];
    for (const page of pages) {
      const allowed = new Set([...footerTokens(page.footer), ...page.only]);
      // `1/2/3` is one token in the footer and three keys in a sentence.
      for (const token of [...allowed]) for (const part of token.split("/")) allowed.add(part);
      const documented = keysIn(await pageLine(page.name));

      expect(documented.length, `the ${page.name} list documents almost nothing`).toBeGreaterThan(
        page.name === "List" ? 10 : 6,
      );
      expect(
        documented.filter((key) => !allowed.has(key)),
        `the ${page.name} line claims a key that page ignores`,
      ).toEqual([]);
    }
  });

  it("keeps the back key off the list's line", async () => {
    // The panel's list dispatch never reads `←`: it opens a page on Enter or `→`, and
    // goes back only from a detail. Printing it under "List keys" sends a reader
    // pressing a key that does nothing.
    expect(keysIn(await pageLine("List"))).not.toContain("←");
    expect(keysIn(await pageLine("Detail"))).toContain("←");
  });

  it("names the same door the status line prints", async () => {
    const readme = prose(await readFile(README, "utf8"));

    expect(statusLineText([])).toContain(TASKS_HINT);
    expect(readme, "the README writes the door in its own words").toContain(TASKS_HINT);
    // The keybinding syntax belongs to `registerShortcut`, not to prose: a reader
    // presses what the hint calls it, and `shift+down` is not what any surface prints.
    expect(readme).not.toContain("shift+down");
  });
});
