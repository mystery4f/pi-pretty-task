/**
 * One file written so a reader never sees half of it: a temp file beside the
 * target, then a rename that waits out a Windows share still holding the target.
 *
 * The record store and a prompt loop's prompt file both write this way, so the
 * primitive lives here rather than in either caller (ADR-0024). Atomicity is the
 * promise, not durability: a power cut may lose the newest write, which is a
 * state the record loader already answers by rebuilding.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { open, rename } from "node:fs/promises";

/**
 * Where the temp file of an atomic write sits: the target's own name plus `.tmp`,
 * beside it, so the rename that lands the write never crosses a volume. One
 * owner, because a cleanup after a failed write and a test that forces one both
 * have to name the same file this writer uses (ADR-0024).
 */
export function tempPathFor(path: string): string {
  return `${path}.tmp`;
}

/** Write one file in a way a reader never sees half of it. */
export async function writeAtomic(path: string, data: string): Promise<void> {
  const tempPath = tempPathFor(path);
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(data, "utf8");
  } finally {
    await handle.close();
  }
  // Atomicity, not durability: rename is what stops a reader seeing half a file,
  // and that is the only promise this record needs. A power cut may lose the
  // newest generation, which the loader already treats as "no record" and
  // rebuilds — while an explicit flush costs a real FlushFileBuffers per write,
  // slow enough on a scanned Windows volume to make the newest generation look
  // lost while it is still queued behind the last one.
  await renameWithRetry(tempPath, path);
}

/** How often a busy directory entry is retried before the write gives up. */
const RENAME_ATTEMPTS = 10;
/** Long enough for a scan or a polling reader to let go, short enough to be invisible. */
const RENAME_DELAY_MS = 10;

export interface RenameRetryOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  /** Seams for the retry's own test; production uses the real rename and timer. */
  readonly renameImpl?: typeof rename;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Rename a file into place, waiting out a Windows share that is still open.
 *
 * POSIX renames over a file another process is reading without complaint; Windows
 * refuses with `EPERM` or `EBUSY` until every handle on that file closes — a
 * reader polling the record, a virus scanner, another pi session. Without a retry
 * the writer sees a generation that never lands, which is how `task-persistence`
 * timed out on the Windows runner. The delay is short because the holder is
 * usually a read that started microseconds ago.
 *
 * Exported for the retry's own test; no caller outside this module needs it.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  options: RenameRetryOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? RENAME_ATTEMPTS;
  const delayMs = options.delayMs ?? RENAME_DELAY_MS;
  const renameImpl = options.renameImpl ?? rename;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const busy = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!busy || attempt >= attempts) throw error;
      await sleep(delayMs);
    }
  }
}
