/**
 * Reading a task's output file: its tail, or what was appended past a cursor.
 *
 * A tail read is bounded twice — by bytes read from the end of the file and by
 * lines returned — because the same code serves `bg_logs` and the panel, and a
 * runaway command must never be able to flood either. A follow read is bounded
 * by the file itself: it returns exactly the bytes the previous follow left.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { open } from "node:fs/promises";

import { decodeOutput } from "./decode.js";

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
  /** Platform whose console encoding the reader falls back to; defaults to this host. */
  platform?: NodeJS.Platform;
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
    const all = decodeOutput(buffer, { platform: options.platform ?? process.platform })
      .replace(/\r\n/g, "\n")
      .split("\n");
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

/** Bytes appended to one output file since an offset. */
export interface OutputDelta {
  text: string;
  /** Offset the read started at, clamped to the file's current size. */
  from: number;
  /** Offset just past the bytes read; the next follow read starts here. */
  to: number;
  /** Size of the file when it was read. */
  size: number;
}

export interface OutputDeltaOptions {
  /** Platform whose console encoding the reader falls back to; defaults to this host. */
  platform?: NodeJS.Platform;
}

/**
 * Read what an output file holds past `offset`. A missing file has nothing past
 * it, and an offset beyond the end is clamped, so a file that was replaced or
 * truncated answers an empty delta instead of failing the follow. The bytes are
 * decoded the same way a tail read decodes them, so a follower and a tail
 * reader never disagree about a character.
 */
export async function readOutputFrom(
  path: string,
  offset: number,
  options: OutputDeltaOptions = {},
): Promise<OutputDelta> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isFileNotFound(error)) {
      const start = Math.max(0, offset);
      return { text: "", from: start, to: start, size: 0 };
    }
    throw error;
  }

  try {
    const { size } = await handle.stat();
    const from = Math.max(0, Math.min(offset, size));
    const length = size - from;
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, from);

    const text = decodeOutput(buffer, { platform: options.platform ?? process.platform }).replace(
      /\r\n/g,
      "\n",
    );
    return { text, from, to: size, size };
  } finally {
    await handle.close();
  }
}
