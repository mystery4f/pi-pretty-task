/**
 * A prompt loop's prompt on disk: the file is the source of truth, the record's
 * `prompt` is the seed and the rebuild source (ADR-0024).
 *
 * The address is derived from the loop id alone, so nothing here takes a path
 * from a caller. The plugin writes at three moments: creating the loop, an
 * explicit rewrite through pretty_task_loop_update, and a rebuild of a file that
 * is missing, unreadable or holds only whitespace. Every fire reads.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { tempPathFor, writeAtomic } from "../base/atomic.js";
import { loopPromptPath } from "../base/runtime-state.js";
import type { PromptLoopTask } from "../base/task.js";

/** What one fire sends, and what the record should say about how it was obtained. */
export interface PromptRead {
  /** Text the wake carries; never empty, because an unreadable file still fires. */
  readonly text: string;
  /**
   * One line for the record when the creation prompt had to stand in. Absent on
   * a clean read, so the warning disappears once the file is healthy again.
   */
  readonly warning?: string;
}

/**
 * Lines a panel previews of a prompt file. Three keep the file's gist visible
 * while the iteration list — what a morning check is actually read for — stays
 * in the pane; the whole text lives in the file, not on the page (ticket #48).
 */
const PROMPT_PREVIEW_LINES = 3;

/**
 * A prompt file as the panel shows it: where it is, the first few lines, when it
 * last changed, and what went wrong with the read if anything did, so a reader
 * can tell whether the version they edited is the one that fired. Never the
 * whole text.
 */
export interface PromptPreview {
  /** The file's address, derived from the loop id; present even when it cannot be read. */
  readonly path: string;
  /** The first `PROMPT_PREVIEW_LINES` non-empty lines, trimmed; empty when there are none. */
  readonly lines: readonly string[];
  /** The file's modification time, epoch ms; absent when it could not be stat'ed. */
  readonly changedAt?: number;
  /**
   * Why there is no text — "is missing", "is empty", "could not be read (…)" — the
   * same words the fire's warning uses. Absent when the file read cleanly, so a
   * failed stat of a readable file still shows the lines it did read.
   */
  readonly problem?: string;
}

/** Write the loop's prompt file, replacing whatever is there. */
export async function writePromptText(
  directory: string,
  loopId: string,
  text: string,
): Promise<void> {
  const path = loopPromptPath(directory, loopId);
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, text);
}

/**
 * Delete the loop's prompt file with the loop. Best effort: a loop the user
 * asked to delete is gone even when a file handle or a scanner keeps the entry
 * alive for a moment (ADR-0024 lifecycle).
 */
export async function removePromptText(directory: string, loopId: string): Promise<void> {
  const path = loopPromptPath(directory, loopId);
  // The temp file too: a write that failed before its rename leaves one behind.
  await removeQuietly(path);
  await removeQuietly(tempPathFor(path));
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // No file yet, or a locked entry on Windows: nothing to do either way.
  }
}

/**
 * The text one fire sends. A readable, non-empty file wins outright — that is
 * what makes editing the file refine the prompt without recreating the loop.
 * Anything else rebuilds the file from the record and still fires: a loop that
 * silently stopped is the failure this whole design is against (ADR-0024).
 */
export async function readPromptText(directory: string, task: PromptLoopTask): Promise<PromptRead> {
  const path = loopPromptPath(directory, task.id);
  const read = await readText(path);
  // A file of nothing but whitespace counts as unreadable: it would deliver an
  // empty follow-up the user never sees, which is worse than a loud rebuild.
  if ("text" in read && read.text.trim().length > 0) return { text: read.text };

  const problem = "text" in read ? "is empty" : read.problem;
  try {
    await writePromptText(directory, task.id, task.prompt);
  } catch (error) {
    // The rebuild failed too. Send the diagnostic rather than nothing: the model
    // reads it as the turn's prompt and the schedule keeps its slot.
    const reason = error instanceof Error ? error.message : String(error);
    return {
      text: `The prompt file ${path} ${problem}, and rebuilding it from the loop's creation prompt failed (${reason}). Fix the file with your editor; this loop keeps firing on its schedule.`,
      warning: `The prompt file ${problem}, and rebuilding it failed (${reason}).`,
    };
  }
  return {
    text: task.prompt,
    warning: `The prompt file ${problem}; this fire used the creation prompt and rewrote the file.`,
  };
}

/**
 * A loop's prompt file as its panel page shows it. Reads through this layer, so
 * the panel never joins a path or opens a file itself, and never throws: a file
 * that is gone yields the address and no preview, which the page pairs with the
 * record's own warning (ADR-0024, ticket #48).
 */
export async function readPromptPreview(directory: string, loopId: string): Promise<PromptPreview> {
  const path = loopPromptPath(directory, loopId);
  const [read, stamp] = await Promise.all([readText(path), modifiedAt(path)]);
  // Text and time are two facts, not one: a file that was read keeps its lines
  // even when the stat that follows it failed, and a read that failed says why.
  if ("problem" in read) return { path, lines: [], problem: read.problem };
  const lines = previewLines(read.text);
  return {
    path,
    lines,
    ...(stamp === undefined ? {} : { changedAt: stamp }),
    ...(lines.length === 0 ? { problem: "is empty" } : {}),
  };
}

/** The first few non-empty lines, trimmed: a preview, never the whole prompt. */
function previewLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, PROMPT_PREVIEW_LINES);
}

/** When the file last changed; undefined when it cannot be stat'ed. */
async function modifiedAt(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** A read either yields the text or the one word why it did not — never both. */
type TextRead = { readonly text: string } | { readonly problem: string };

async function readText(path: string): Promise<TextRead> {
  try {
    return { text: await readFile(path, "utf8") };
  } catch (error) {
    return { problem: describeProblem(error) };
  }
}

/** How a failed read is said in a warning or a diagnostic; both stay one line. */
function describeProblem(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "is missing";
  const message = error instanceof Error ? error.message : String(error);
  return `could not be read (${message})`;
}
