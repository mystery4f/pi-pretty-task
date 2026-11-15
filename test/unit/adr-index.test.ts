import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The wiki synthesis page is the docs index (see AGENTS.md), so an ADR that never
 * reaches it is invisible to whoever reads the index and stops there. Three ADRs
 * (0009, 0015, 0016) shipped without their row before this check existed.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const ADR_DIR = join(ROOT, "docs", "adr");
const INDEX = join(ROOT, ".llm-wiki", "wiki", "syntheses", "pi-pretty-task-文档索引.md");

describe("the docs index", () => {
  it("names every ADR on disk", () => {
    const numbers = readdirSync(ADR_DIR)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, 4))
      .sort();
    const index = readFileSync(INDEX, "utf8");
    const missing = numbers.filter((number) => !index.includes(`adr/${number}-`));
    expect(missing).toEqual([]);
  });
});
