/**
 * Where runtime state lives: under `.pi/` in the project the session runs in,
 * never in the repository source tree.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { join } from "node:path";

/** Runtime state root, relative to the session's working directory. */
export const RUNTIME_STATE_DIRECTORY = join(".pi", "tasks");

function safeSegment(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/g, "_")
    // A segment that is or contains `..` would climb out of its directory.
    .replace(/\.{2,}/g, "_")
    .replace(/^\./, "_");
  return cleaned.length > 0 ? cleaned : "session";
}

/**
 * One directory per session holds that session's task records and output
 * files. The session id alone names it: adding the pi process id would split a
 * session's history across restarts.
 */
export function sessionTaskDirectory(cwd: string, sessionId: string): string {
  return join(cwd, RUNTIME_STATE_DIRECTORY, safeSegment(sessionId));
}

/** Output file of one process task: both streams, one file, appended in order. */
export function processOutputPath(directory: string, taskId: string): string {
  return join(directory, `${taskId}.output`);
}
