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

/** One record file per session holds both kinds; `.prev` is its previous generation. */
export const TASK_RECORD_FILE = "tasks.json";
export const PREVIOUS_TASK_RECORD_FILE = `${TASK_RECORD_FILE}.prev`;

/** Which session's tasks are meant. Both fields come from the turn. */
export interface TaskScope {
  /** Directory the session runs in; its `.pi/` holds runtime state. */
  cwd: string;
  sessionId: string;
}

/** The record file of one session's tasks, next to their output files. */
export function taskRecordPath(directory: string): string {
  return join(directory, TASK_RECORD_FILE);
}

/** The previous generation of the record file, read when the current one is corrupt. */
export function previousTaskRecordPath(directory: string): string {
  return join(directory, PREVIOUS_TASK_RECORD_FILE);
}

/** Output file of one process task: both streams, one file, appended in order. */
export function processOutputPath(directory: string, taskId: string): string {
  return join(directory, `${taskId}.output`);
}

/**
 * Prompt file of one prompt loop, named after the loop alone (ADR-0024).
 *
 * The address is derived, never supplied: no tool takes a path, so neither the
 * user nor the model can point a loop at a file somewhere else. `safeSegment`
 * keeps an id from climbing out of the session directory, and the loop's name
 * plays no part, so renaming a loop never moves its prompt.
 */
export function loopPromptPath(directory: string, loopId: string): string {
  return join(directory, `${safeSegment(loopId)}.prompt.md`);
}
