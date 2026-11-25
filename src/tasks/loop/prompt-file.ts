/**
 * A prompt loop's prompt on disk: the file is the source of truth, the record's
 * `prompt` is the seed and the rebuild source (ADR-0024).
 *
 * The address is derived from the loop id alone, so nothing here takes a path
 * from a caller. The plugin writes twice: once when the loop is created, and to
 * rebuild a file that has gone missing or unreadable. Every fire reads.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { writeAtomic } from "../base/atomic.js";
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
  await removeQuietly(`${path}.tmp`);
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
  if (read.text !== undefined && read.text.trim().length > 0) return { text: read.text };

  const problem = read.text !== undefined ? "is empty" : (read.problem ?? "could not be read");
  try {
    await writePromptText(directory, task.id, task.prompt);
  } catch (error) {
    // The rebuild failed too. Send the diagnostic rather than nothing: the model
    // reads it as the turn's prompt and the schedule keeps its slot.
    const reason = error instanceof Error ? error.message : String(error);
    return {
      text: `The prompt file ${path} ${problem}, and rebuilding it from the loop's creation prompt failed (${reason}). Fix the file with your editor; this loop keeps firing on its schedule.`,
      warning: `prompt file ${problem}, and rebuilding it failed (${reason})`,
    };
  }
  return {
    text: task.prompt,
    warning: `prompt file ${problem}; this fire used the creation prompt and rewrote the file`,
  };
}

interface TextRead {
  readonly text?: string;
  readonly problem?: string;
}

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
