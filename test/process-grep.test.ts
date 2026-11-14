/**
 * Extension seam: `bg_grep` answers a question about a task's whole output.
 *
 * The command may have written twenty megabytes, and the caller only wants the
 * lines that matched — so the tool walks the whole file, returns numbered
 * matches, and bounds both how many it returns and how many bytes it spends. The
 * files here are real, because a bounded read cannot be proven against a fake.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { unlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SEARCH_MATCHES, MAX_SEARCH_MATCHES } from "../src/tasks/base/search.js";
import { createHarness, type Harness, resultText } from "./support/extension-harness.js";
import { makeTempDir, waitFor, writeScript } from "./support/processes.js";

interface TaskDetails {
  id: string;
  status: string;
  outputPath: string;
}

interface GrepDetails {
  matches: number;
  total: number;
  omitted: number;
  scannedLines: number;
  clipped: boolean;
  ignoreCase: boolean;
  maxMatches: number;
}

/** The answer cap the spec fixes for one `bg_grep` call. */
const RESULT_BYTE_CAP = 8 * 1024;

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** Start a command and wait until it has ended, so its output file is settled. */
async function finishedTask(harness: Harness, command: string): Promise<TaskDetails> {
  const started = await harness.call("bg_run", { command });
  const task = started.details as TaskDetails;
  await waitFor("the task to finish", async () => {
    const status = await harness.call("bg_status", { id: task.id });
    return (status.details as TaskDetails).status !== "running";
  });
  return task;
}

/** Lines of a `bg_grep` answer: its first two lines are the header, then a blank. */
function bodyLines(text: string): string[] {
  const body = text.slice(text.indexOf("\n\n") + 2);
  if (body.length === 0) return [];
  return body.split("\n").filter((line) => line.length > 0);
}

async function grep(
  harness: Harness,
  params: Record<string, unknown>,
): Promise<{ text: string; details: GrepDetails }> {
  const result = await harness.call("bg_grep", params);
  return { text: resultText(result), details: result.details as GrepDetails };
}

describe("bg_grep over a whole output file", () => {
  it("returns only matching lines, each prefixed with its line number", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "numbered.js",
      [
        "for (let i = 1; i <= 200; i += 1) {",
        '  process.stdout.write("line " + i + (i === 3 ? " needle" : "") + "\\n");',
        "}",
        'process.stdout.write("line 201 needle\\n");',
        "",
      ].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-grep" });
    const task = await finishedTask(harness, command);

    const { text, details } = await grep(harness, { id: task.id, pattern: "needle" });

    expect(details.matches).toBe(2);
    expect(details.total).toBe(2);
    expect(details.scannedLines).toBe(201);
    expect(bodyLines(text)).toEqual(["3: line 3 needle", "201: line 201 needle"]);
  });

  it("finds a match at the head of a long file, not just in its tail", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "head-match.js",
      [
        "for (let i = 1; i <= 400; i += 1) {",
        '  process.stdout.write(i === 1 ? "first line has needle\\n" : "noise " + i + "\\n");',
        "}",
        "",
      ].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-grep-head" });
    const task = await finishedTask(harness, command);

    const { text, details } = await grep(harness, { id: task.id, pattern: "needle" });

    expect(details.scannedLines).toBe(400);
    expect(bodyLines(text)).toEqual(["1: first line has needle"]);
  });

  it("matches case-insensitively by default and exactly when asked", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "case.js",
      ['process.stdout.write("Needle one\\nneedle two\\nNEEDLE three\\n");', ""].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-grep-case" });
    const task = await finishedTask(harness, command);

    const loose = await grep(harness, { id: task.id, pattern: "needle" });
    expect(loose.details.ignoreCase).toBe(true);
    expect(loose.details.matches).toBe(3);

    const exact = await grep(harness, { id: task.id, pattern: "needle", ignoreCase: false });
    expect(exact.details.ignoreCase).toBe(false);
    expect(bodyLines(exact.text)).toEqual(["2: needle two"]);
  });

  it("returns no carriage return from a CRLF output file", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "crlf.js",
      ['process.stdout.write("alpha needle\\r\\nbeta\\r\\ngamma needle\\r\\n");', ""].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-grep-crlf" });
    const task = await finishedTask(harness, command);

    const { text } = await grep(harness, { id: task.id, pattern: "needle" });

    expect(text).not.toContain("\r");
    expect(bodyLines(text)).toEqual(["1: alpha needle", "3: gamma needle"]);
  });
});

describe("bg_grep's caps", () => {
  /** A file whose lines are long enough that the byte cap bites before the match cap. */
  async function bigTask(harness: Harness): Promise<{ task: TaskDetails; lineCount: number }> {
    const started = await harness.call("bg_run", {
      command: "node -e \"process.stdout.write('start')\"",
    });
    const task = started.details as TaskDetails;
    await waitFor("the task to finish", async () => {
      const status = await harness.call("bg_status", { id: task.id });
      return (status.details as TaskDetails).status !== "running";
    });

    const filler = "x".repeat(60);
    const lineCount = 200_000;
    const lines: string[] = [];
    for (let index = 0; index < lineCount; index += 1) {
      // Every 500th line matches and is long: twenty megabytes of output, four
      // hundred matches, and far more matching text than one answer may carry.
      lines.push(
        index % 500 === 0
          ? `line ${String(index)} needle ${"y".repeat(400)}`
          : `line ${String(index)} ${filler}`,
      );
    }
    await writeFile(task.outputPath, `${lines.join("\n")}\n`, "utf8");
    return { task, lineCount };
  }

  it("searches twenty megabytes and answers inside the byte cap, naming what it left out", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-grep-big" });
    const { task, lineCount } = await bigTask(harness);

    const { text, details } = await grep(harness, { id: task.id, pattern: "needle" });

    expect(details.scannedLines).toBe(lineCount);
    expect(details.total).toBe(lineCount / 500);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(RESULT_BYTE_CAP);
    expect(details.omitted).toBe(details.total - details.matches);
    expect(details.omitted).toBeGreaterThan(0);
    expect(text).toContain(`… ${String(details.omitted)} more matches`);
    // Only matching lines: the noise that makes up most of those megabytes stays out.
    expect(text).not.toContain("xxxxxxxxxx");
    for (const line of bodyLines(text).slice(0, details.matches)) {
      expect(line).toMatch(/^\d+: line \d+ needle /);
    }
  });

  it("defaults to fifty matches and never returns more than five hundred", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "many.js",
      [
        "for (let i = 1; i <= 600; i += 1) {",
        '  process.stdout.write("tick " + i + "\\n");',
        "}",
        "",
      ].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-grep-cap" });
    const task = await finishedTask(harness, command);

    const byDefault = await grep(harness, { id: task.id, pattern: "tick" });
    expect(DEFAULT_SEARCH_MATCHES).toBe(50);
    expect(byDefault.details.maxMatches).toBe(DEFAULT_SEARCH_MATCHES);
    expect(byDefault.details.matches).toBe(50);
    expect(byDefault.details.total).toBe(600);
    expect(byDefault.details.omitted).toBe(550);

    const few = await grep(harness, { id: task.id, pattern: "tick", maxMatches: 10 });
    expect(few.details.matches).toBe(10);
    expect(bodyLines(few.text).slice(0, 10)).toHaveLength(10);

    const capped = await grep(harness, { id: task.id, pattern: "tick", maxMatches: 5000 });
    expect(MAX_SEARCH_MATCHES).toBe(500);
    expect(capped.details.maxMatches).toBe(MAX_SEARCH_MATCHES);
    expect(capped.details.matches).toBe(MAX_SEARCH_MATCHES);
    expect(capped.details.omitted).toBe(100);
  });

  it("answers 'no matches' instead of an empty string", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "quiet.js",
      ['process.stdout.write("alpha\\nbeta\\n");', ""].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-grep-none" });
    const task = await finishedTask(harness, command);

    const { text, details } = await grep(harness, { id: task.id, pattern: "not-anywhere" });

    expect(details.matches).toBe(0);
    expect(details.total).toBe(0);
    expect(details.scannedLines).toBe(2);
    expect(text).toContain("No matches");
    expect(text).toContain(JSON.stringify("not-anywhere"));
  });

  it("keeps the answer inside the byte cap when the pattern itself is huge", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const pattern = "needle".repeat(1500);
    const command = await writeScript(
      dir.path,
      "huge-pattern.js",
      [
        `process.stdout.write("head ${pattern} tail\\n");`,
        "process.stdout.write('other');",
        "",
      ].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-grep-huge-pattern" });
    const task = await finishedTask(harness, command);

    const { text, details } = await grep(harness, { id: task.id, pattern });

    expect(details.matches).toBe(1);
    expect(details.total).toBe(1);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
    expect(text).toContain("1: head");
  });

  it("answers 'no matches' when the task has not written its output file yet", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "gone.js",
      ['process.stdout.write("alpha\\n");', ""].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-grep-gone" });
    const task = await finishedTask(harness, command);
    await unlink(task.outputPath);

    const { text, details } = await grep(harness, { id: task.id, pattern: "alpha" });

    expect(details.scannedLines).toBe(0);
    expect(text).toContain("No matches");
  });

  it("reports an unknown task id instead of searching nothing", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-grep-unknown" });

    const result = await harness.call("bg_grep", { id: "bg-zzzzzz", pattern: "alpha" });

    expect(resultText(result)).toContain("No background task with id bg-zzzzzz");
  });
});

describe("bg_grep on a line longer than one read", () => {
  it("finds a match beyond the first read of a line that never breaks", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "quiet.js", "process.stdout.write('start');\n");
    const harness = createHarness({ cwd: dir.path, sessionId: "session-grep-long" });
    const task = await finishedTask(harness, command);
    const line = `${"a".repeat(900_000)}needle${"b".repeat(100_000)}`;
    await writeFile(task.outputPath, `${line}\n`, "utf8");

    const { text, details } = await grep(harness, { id: task.id, pattern: "needle" });

    expect(details.matches).toBe(1);
    expect(details.clipped).toBe(true);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(RESULT_BYTE_CAP);
  });

  it("finds a pattern that straddles two reads of one line", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "quiet2.js", "process.stdout.write('start');\n");
    const harness = createHarness({ cwd: dir.path, sessionId: "session-grep-seam" });
    const task = await finishedTask(harness, command);
    const line = `${"a".repeat(8 * 1024 - 5)}NEEDLE-SPANNING-THE-SEAM${"b".repeat(200)}`;
    await writeFile(task.outputPath, `${line}\n`, "utf8");

    const { details } = await grep(harness, { id: task.id, pattern: "needle-spanning" });

    expect(details.matches).toBe(1);
  });
});
