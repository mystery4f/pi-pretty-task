/**
 * Turning a task's raw output bytes back into text.
 *
 * The file on disk keeps exactly what the process wrote, so this is the one place
 * that decides what a reader — `bg_logs`, the panel, a completion notice — sees.
 * UTF-8 is tried strictly first: output that decodes cleanly is UTF-8 by every
 * platform's default, and a strict attempt cannot invent replacement characters.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

/** How a byte range becomes text. Only the last resort differs by platform. */
export interface DecodeOptions {
  /** Which platform's console encoding to fall back to; defaults to this host. */
  platform?: NodeJS.Platform;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const lossyUtf8 = new TextDecoder("utf-8");

/** GB18030 needs the decoder tables, which a small-ICU Node build does not carry. */
let legacyDecoder: TextDecoder | null | undefined;

function gb18030(): TextDecoder | null {
  if (legacyDecoder === undefined) {
    try {
      legacyDecoder = new TextDecoder("gb18030");
    } catch {
      legacyDecoder = null;
    }
  }
  return legacyDecoder;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** A reader starts at a byte offset, which can land inside a multi-byte character. */
function leadingContinuationBytes(bytes: Uint8Array): number {
  let leading = 0;
  while (leading < 3 && leading < bytes.length) {
    const byte = bytes[leading];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    leading += 1;
  }
  return leading;
}

/**
 * Decode output bytes the way ADR-0008 describes: strict UTF-8, then UTF-8 after
 * dropping a character the tail cut in half, then — on Windows only — GB18030.
 *
 * Windows consoles and legacy tools still write the ANSI code page, which is GBK on
 * a Chinese system and reads as mojibake under UTF-8. POSIX gets no such fallback:
 * invalid UTF-8 there is far more likely to be binary than a legacy encoding.
 */
export function decodeOutput(bytes: Uint8Array, options: DecodeOptions = {}): string {
  if (bytes.length === 0) return "";

  const whole = decodeUtf8(bytes);
  if (whole !== undefined) return whole;

  const skipped = leadingContinuationBytes(bytes);
  if (skipped > 0) {
    const trimmed = decodeUtf8(bytes.subarray(skipped));
    if (trimmed !== undefined) return trimmed;
  }

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const legacy = gb18030();
    if (legacy !== null) return legacy.decode(bytes);
  }
  return lossyUtf8.decode(bytes);
}
