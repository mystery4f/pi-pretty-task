/**
 * Unit seam: the pieces the tools compose — where runtime state lives, how a
 * tail is read, and how a duration or a size is said out loud.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { commandPreview, formatBytes, formatDuration } from "../src/tasks/base/format.js";
import { readOutputTail } from "../src/tasks/base/output.js";
import {
  processOutputPath,
  RUNTIME_STATE_DIRECTORY,
  sessionTaskDirectory,
} from "../src/tasks/base/runtime-state.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function tempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-pretty-task-unit-"));
  cleanup.push(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const path = join(dir, "out.output");
  await writeFile(path, content, "utf8");
  return path;
}

describe("runtime state", () => {
  it("lives under .pi in the session directory, one directory per session", () => {
    expect(sessionTaskDirectory("/work/project", "session-1")).toBe(
      join("/work/project", RUNTIME_STATE_DIRECTORY, "session-1"),
    );
  });

  it("keeps a session id from escaping its directory", () => {
    const directory = sessionTaskDirectory("/work/project", "../../etc/passwd");
    expect(directory.startsWith(join("/work/project", RUNTIME_STATE_DIRECTORY))).toBe(true);
    expect(directory).not.toContain("..");
  });

  it("names the output file after the task", () => {
    expect(processOutputPath("/state/session-1", "ab12cd")).toBe(
      join("/state/session-1", "ab12cd.output"),
    );
  });
});

describe("readOutputTail", () => {
  it("has no output before the file exists", async () => {
    const tail = await readOutputTail(join(tmpdir(), "does-not-exist-anywhere.output"), {
      lines: 10,
    });
    expect(tail).toEqual({ text: "", lines: 0, truncated: false });
  });

  it("returns the last lines and says that it cut the rest", async () => {
    const path = await tempFile(["one", "two", "three", "four", ""].join("\n"));
    const tail = await readOutputTail(path, { lines: 2 });
    expect(tail.text).toBe("three\nfour");
    expect(tail.lines).toBe(2);
    expect(tail.truncated).toBe(true);
  });

  it("does not start a tail in the middle of a line", async () => {
    const path = await tempFile("first line\nsecond line\nthird line\n");
    const tail = await readOutputTail(path, { lines: 10, maxBytes: 18 });
    expect(tail.truncated).toBe(true);
    expect(tail.text.startsWith("third")).toBe(true);
  });

  it("reads one line ending, whichever platform wrote the file", async () => {
    const path = await tempFile("alpha\r\nbeta\r\n");
    expect((await readOutputTail(path, { lines: 10 })).text).toBe("alpha\nbeta");
  });
});

describe("format", () => {
  it("says durations in a unit a person reads", () => {
    expect(formatDuration(400)).toBe("0.4s");
    expect(formatDuration(12_340)).toBe("12.3s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
  });

  it("says sizes in binary units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20.0 MiB");
  });

  it("previews a command without hiding that more follows", () => {
    expect(commandPreview("npm test")).toBe("npm test");
    expect(commandPreview(`echo ${"x".repeat(200)}`)).toHaveLength(80);
    expect(commandPreview(`echo ${"x".repeat(200)}`).endsWith("…")).toBe(true);
    expect(commandPreview("line one\nline two")).toContain("…");
  });
});
