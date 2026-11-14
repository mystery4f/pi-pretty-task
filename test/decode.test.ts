/**
 * Output decoding: raw bytes in, the text a reader sees out. What a command wrote is
 * never rewritten on disk, so the only question here is how it comes back (ADR-0008).
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { decodeOutput } from "../src/tasks/base/decode.js";
import { readOutputTail } from "../src/tasks/base/output.js";
import { makeTempDir } from "./support/processes.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** 你好 in GBK, the bytes a Chinese Windows console still writes to stdout. */
const GBK_NIHAO = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);

describe("decoding a task's output", () => {
  it("returns UTF-8 as written on either platform", () => {
    const bytes = Buffer.from("你好, ok\n");
    expect(decodeOutput(bytes, { platform: "win32" })).toBe("你好, ok\n");
    expect(decodeOutput(bytes, { platform: "linux" })).toBe("你好, ok\n");
  });

  it("decodes GBK bytes on Windows", () => {
    expect(decodeOutput(GBK_NIHAO, { platform: "win32" })).toBe("你好");
  });

  it("keeps POSIX lossy instead of guessing a legacy code page", () => {
    const text = decodeOutput(GBK_NIHAO, { platform: "linux" });
    expect(text).not.toBe("你好");
    expect(text).toContain("\uFFFD");
  });

  it("drops a character the tail cut in half", () => {
    const bytes = Buffer.from("你好");
    // A reader starts at a byte offset: one and three continuation bytes missing.
    expect(decodeOutput(bytes.subarray(1), { platform: "linux" })).toBe("好");
    expect(decodeOutput(bytes.subarray(3), { platform: "linux" })).toBe("好");
  });

  it("drops at most three leading continuation bytes", () => {
    const bytes = Buffer.from([0x9f, 0x98, 0x80, 0x0a, 0x61]);
    expect(decodeOutput(bytes, { platform: "linux" })).toBe("\na");
  });

  it("prefers the UTF-8 retry to GB18030 on Windows", () => {
    const bytes = Buffer.from([0xbd, 0xa0, 0xe5, 0xa5, 0xbd]);
    expect(decodeOutput(bytes, { platform: "win32" })).toBe("好");
  });

  it("has nothing to decode for an empty file", () => {
    expect(decodeOutput(Buffer.alloc(0), { platform: "win32" })).toBe("");
  });
});

describe("reading the tail of an output file", () => {
  it("reads GBK output as text on Windows and lossily elsewhere", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const path = join(dir.path, "gbk.log");
    await writeFile(path, Buffer.concat([GBK_NIHAO, Buffer.from("\r\n")]));

    const windows = await readOutputTail(path, { lines: 10, platform: "win32" });
    expect(windows.text).toBe("你好");

    const posix = await readOutputTail(path, { lines: 10, platform: "linux" });
    expect(posix.text).not.toBe("你好");
    expect(posix.lines).toBe(1);
  });

  it("still ends lines with LF only", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const path = join(dir.path, "crlf.log");
    await writeFile(path, "alpha\r\nbeta\r\n");

    const tail = await readOutputTail(path, { lines: 10, platform: "win32" });
    expect(tail.text).toBe("alpha\nbeta");
  });
});
