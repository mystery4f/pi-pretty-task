import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The wiki synthesis page is the docs index (see AGENTS.md), so an ADR that never
 * reaches it is invisible to whoever reads the index and stops there. Three ADRs
 * (0009, 0015, 0016) shipped without their row before this check existed.
 *
 * Half the set also carried no date at all, which is what made "when was this
 * decided" and every staleness question unanswereable: `## 状态` with an
 * `已接受（YYYY-MM-DD）` line is a shape the file has to hold, not a habit.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const ADR_DIR = join(ROOT, "docs", "adr");
const INDEX = join(ROOT, ".llm-wiki", "wiki", "syntheses", "pi-pretty-task-文档索引.md");
const STATUS = /已接受（(\d{4}-\d{2}-\d{2})）/u;
const LINK = /adr\/(\d{4}-[\w-]+\.md)/gu;

const adrs = readdirSync(ADR_DIR)
  .filter((name) => name.endsWith(".md"))
  .sort();
const onDisk = new Set(adrs);

/** Every markdown file whose links a reader might follow. */
function sources(): string[] {
  const docs = readdirSync(join(ROOT, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(ROOT, "docs", name));
  return [
    ...docs,
    join(ROOT, "README.md"),
    join(ROOT, "AGENTS.md"),
    join(ROOT, "GLOSSARY.md"),
    INDEX,
  ];
}

describe("the docs index", () => {
  it("names every ADR on disk", () => {
    const numbers = adrs.map((name) => name.slice(0, 4));
    const index = readFileSync(INDEX, "utf8");
    const missing = numbers.filter((number) => !index.includes(`adr/${number}-`));
    expect(missing).toEqual([]);
  });

  it("gives every ADR a status line with the date it was accepted", () => {
    const undated = adrs.filter((name) => {
      const text = readFileSync(join(ADR_DIR, name), "utf8");
      return !text.includes("## 状态") || !STATUS.test(text);
    });
    expect(undated).toEqual([]);
  });

  it("follows only links to an ADR that exists", () => {
    const dead = sources().flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return [...text.matchAll(LINK)]
        .map((match) => match[1] ?? "")
        .filter((name) => !onDisk.has(name))
        .map((name) => `${path.slice(ROOT.length)} → ${name}`);
    });
    expect([...new Set(dead)]).toEqual([]);
  });

  it("keeps the index's own date at or after the newest decision", () => {
    const newest = adrs
      .map((name) => STATUS.exec(readFileSync(join(ADR_DIR, name), "utf8"))?.[1] ?? "")
      .filter((date) => date !== "")
      .sort()
      .at(-1);
    const updated = /^updated:\s*(\d{4}-\d{2}-\d{2})/mu.exec(readFileSync(INDEX, "utf8"))?.[1];
    expect(newest).toBeDefined();
    expect(updated).toBeDefined();
    // String compare works for an ISO date; an index older than its newest row means
    // whoever added the ADR stopped before the page that points at it.
    expect((updated ?? "") >= (newest ?? "")).toBe(true);
  });
});
