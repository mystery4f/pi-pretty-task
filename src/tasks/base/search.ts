/**
 * Searching a task's output file for a plain substring.
 *
 * The tail reader answers "what did it say last"; this one answers "where does it
 * say X", so it walks the whole file instead of its end — a twenty megabyte
 * output is read in chunks and never lands in memory at once. The answer is
 * bounded the same way every other reader of these files is: by matching lines
 * returned and by the bytes the rendered `line: text` list may spend. The match
 * count keeps running after both caps stop collecting, because the caller has to
 * be able to say how many matches it left out.
 *
 * There is no pattern language here on purpose: a substring is what a model
 * asking "where does it say this" means, and a regex is one more thing a caller
 * can get subtly wrong. Case folding is the only option.
 *
 * Bytes become text through `decodeOutput`, the decoder `bg_logs`, the panel and
 * the completion notice already share (ADR-0008). It is applied per line, so one
 * file can hold strict UTF-8 and a legacy console's code page side by side. A
 * line longer than one read is walked in segments with a raw-byte carry, so a
 * pattern split across two of them is still found, and only the first segment is
 * kept for display.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { open } from "node:fs/promises";

import { decodeOutput } from "./decode.js";

/** Matching lines one answer returns when the caller names no cap. */
export const DEFAULT_SEARCH_MATCHES = 50;

/** Hard ceiling on matching lines one answer may return, whatever the caller asks. */
export const MAX_SEARCH_MATCHES = 500;

/** Bytes one rendered `line: text` list may spend when the caller names no cap. */
export const DEFAULT_SEARCH_BYTES = 8 * 1024;

/** Bytes read from the file at a time; the file is never loaded whole. */
const READ_CHUNK_BYTES = 64 * 1024;

/** Bytes of one line held before it is tested as a segment of its own. */
const LINE_SEGMENT_BYTES = 8 * 1024;

export interface OutputSearchOptions {
  /** Literal text to look for; `.` and `*` are ordinary characters. */
  pattern: string;
  /** Match regardless of case. Defaults to true. */
  ignoreCase?: boolean;
  /** Matching lines to return at most; defaults to 50, capped at 500. */
  maxMatches?: number;
  /** Bytes the rendered list may spend; defaults to 8 KiB. */
  maxBytes?: number;
  /** Platform whose console encoding the reader falls back to; defaults to this host. */
  platform?: NodeJS.Platform;
}

/** One matching line. */
export interface OutputMatch {
  /** 1-based line number in the output file. */
  line: number;
  /** The line's text without its line ending, shortened when a cap demanded it. */
  text: string;
}

/** What a search found, whether or not the caps let it return everything. */
export interface OutputSearch {
  readonly matches: readonly OutputMatch[];
  /** Matching lines in the whole file, returned or not. */
  readonly total: number;
  /** Matching lines found after the match cap or the byte cap stopped collecting. */
  readonly omitted: number;
  /** Lines the reader walked: the whole file, never a tail of it. */
  readonly scannedLines: number;
  /** True when a returned line's text is shorter than the line it came from. */
  readonly clipped: boolean;
}

/**
 * A match cap is a whole number of lines between 1 and the ceiling. A value the
 * caller cannot have means the default, never a silent zero: an answer of "no
 * matches" caused by a bad cap would read as an answer about the output.
 */
export function clampSearchMatches(value?: number): number {
  const wanted = Math.floor(value ?? DEFAULT_SEARCH_MATCHES);
  if (!Number.isFinite(wanted)) return DEFAULT_SEARCH_MATCHES;
  return Math.min(MAX_SEARCH_MATCHES, Math.max(1, wanted));
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}

/**
 * Drop a trailing incomplete UTF-8 sequence from bytes that stopped mid-character.
 *
 * A segment boundary falls where it falls, and a strict UTF-8 decode of half a
 * character fails — which would hand the whole segment to the platform fallback
 * and turn good text into mojibake. The bytes themselves are never lost: the
 * carry for the next segment is taken from the untrimmed bytes.
 */
function withoutPartialTail(bytes: Buffer): Buffer {
  let continuations = 0;
  while (continuations < 3 && continuations < bytes.length) {
    const byte = bytes[bytes.length - 1 - continuations];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    continuations += 1;
  }
  const lead = bytes.length - 1 - continuations;
  const leadByte = bytes[lead];
  if (leadByte === undefined) return bytes;
  const needed = leadByte >= 0xf0 ? 3 : leadByte >= 0xe0 ? 2 : leadByte >= 0xc0 ? 1 : 0;
  if (needed === 0 || bytes.length - lead - 1 >= needed) return bytes;
  return bytes.subarray(0, lead);
}

/** Search one output file. A file that does not exist yet has no matches. */
export async function searchOutputFile(
  path: string,
  options: OutputSearchOptions,
): Promise<OutputSearch> {
  const platform = options.platform ?? process.platform;
  const ignoreCase = options.ignoreCase !== false;
  const needle = ignoreCase ? options.pattern.toLowerCase() : options.pattern;
  const patternBytes = Math.max(
    Buffer.byteLength(options.pattern, "utf8"),
    Buffer.byteLength(needle, "utf8"),
  );
  const maxMatches = clampSearchMatches(options.maxMatches);
  const maxBytes = Math.max(0, Math.floor(options.maxBytes ?? DEFAULT_SEARCH_BYTES));

  const matches: OutputMatch[] = [];
  let total = 0;
  let scannedLines = 0;
  let clipped = false;
  let spent = 0;

  /** Keep one matching line while both caps have room; its text may be cut to fit. */
  const collect = (line: number, text: string, shortened: boolean): void => {
    const prefix = `${String(line)}: `;
    // Entries are joined by one newline, which counts against the same budget.
    const separator = matches.length === 0 ? 0 : 1;
    const room = maxBytes - spent - separator - Buffer.byteLength(prefix);
    if (room <= 0) {
      clipped = clipped || shortened;
      return;
    }
    let shown = text;
    let shortenedMore = false;
    if (Buffer.byteLength(shown) > room) {
      shown = withoutPartialTail(Buffer.from(shown, "utf8").subarray(0, room)).toString("utf8");
      shortenedMore = true;
    }
    spent += separator + Buffer.byteLength(prefix) + Buffer.byteLength(shown);
    matches.push({ line, text: shown });
    clipped = clipped || shortened || shortenedMore;
  };

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isFileNotFound(error)) {
      return { matches: [], total: 0, omitted: 0, scannedLines: 0, clipped: false };
    }
    throw error;
  }

  try {
    // A segment has to be longer than the pattern, or a match could span two of
    // them with nothing long enough to hold it.
    const segmentBytes = Math.max(LINE_SEGMENT_BYTES, patternBytes * 2);
    const carryBytes = Math.min(segmentBytes - 1, patternBytes + 8);

    let segmentParts: Buffer[] = [];
    let headParts: Buffer[] = [];
    let segmentLength = 0;
    let segments = 0;
    let carry: Buffer = Buffer.alloc(0);
    let matched = false;

    const asText = (bytes: Buffer): string => decodeOutput(withoutPartialTail(bytes), { platform });

    /** Test one segment; the display keeps the first segment of the line only. */
    const flushSegment = (bytes: Buffer): void => {
      if (segments === 0) headParts.push(Buffer.from(bytes));
      if (!matched) {
        const window = segments === 0 ? bytes : Buffer.concat([carry, bytes]);
        const text = asText(window);
        matched = (ignoreCase ? text.toLowerCase() : text).includes(needle);
      }
      carry = Buffer.from(bytes.subarray(Math.max(0, bytes.length - carryBytes)));
      segments += 1;
      segmentParts = [];
      segmentLength = 0;
    };

    const endLine = (): void => {
      if (segmentLength > 0 || segments === 0) flushSegment(Buffer.concat(segmentParts));
      scannedLines += 1;
      if (matched) {
        total += 1;
        if (matches.length < maxMatches) {
          // `\r` is the file's line ending, not part of what the line says.
          const text = asText(Buffer.concat(headParts)).replace(/\r$/, "");
          collect(scannedLines, segments > 1 ? `${text}…` : text, segments > 1);
        }
      }
      headParts = [];
      segments = 0;
      carry = Buffer.alloc(0);
      matched = false;
    };

    const pushSegment = (bytes: Buffer): void => {
      let rest = bytes;
      while (rest.length > 0) {
        const part = rest.subarray(0, segmentBytes - segmentLength);
        // The read buffer is reused by the next chunk, so every kept byte is a copy.
        segmentParts.push(Buffer.from(part));
        segmentLength += part.length;
        rest = rest.subarray(part.length);
        if (segmentLength === segmentBytes) flushSegment(Buffer.concat(segmentParts));
      }
    };

    const consume = (bytes: Buffer): void => {
      let start = 0;
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== 0x0a) continue;
        pushSegment(bytes.subarray(start, index));
        endLine();
        start = index + 1;
      }
      if (start < bytes.length) pushSegment(bytes.subarray(start));
    };

    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      consume(chunk.subarray(0, bytesRead));
    }
    // A file without a final newline still ends its last line; one with it does
    // not gain an empty line it never wrote.
    if (segmentLength > 0 || segments > 0) endLine();

    return { matches, total, omitted: total - matches.length, scannedLines, clipped };
  } finally {
    await handle.close();
  }
}
