/**
 * Reading the tail of a task's output file.
 *
 * A tail read is bounded twice — by bytes read from the end of the file and by
 * lines returned — because the same code serves `bg_logs` and the panel, and a
 * runaway command must never be able to flood either.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { open } from "node:fs/promises";

/** Tail of one output file. */
export interface OutputTail {
  text: string;
  /** Number of lines in `text`. */
  lines: number;
  /** True when older output was left out, by bytes or by lines. */
  truncated: boolean;
}

export interface OutputTailOptions {
  /** Maximum lines to return. */
  lines: number;
  /** Maximum bytes to read from the end of the file. Defaults to 128 KiB. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 128 * 1024;

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}

/** Read the last `lines` lines of an output file. A missing file has no output yet. */
export async function readOutputTail(
  path: string,
  options: OutputTailOptions,
): Promise<OutputTail> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const wanted = Math.max(1, Math.floor(options.lines));

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isFileNotFound(error)) return { text: "", lines: 0, truncated: false };
    throw error;
  }

  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, start);

    // The file keeps the raw bytes; a reader gets one line ending, because a
    // Windows shell writes CRLF while everything else here writes LF.
    const all = buffer.toString("utf8").replace(/\r\n/g, "\n").split("\n");
    let truncated = start > 0;
    // A tail that begins in the middle of a line would render as garbage.
    if (truncated) all.shift();
    // A trailing newline leaves an empty last element that was never a line.
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    if (all.length > wanted) {
      all.splice(0, all.length - wanted);
      truncated = true;
    }

    return { text: all.join("\n"), lines: all.length, truncated };
  } finally {
    await handle.close();
  }
}
