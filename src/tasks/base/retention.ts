/**
 * Retention: what a finished session leaves on disk is reclaimed on a calendar,
 * not by hand.
 *
 * One directory per session holds that session's records and its output files,
 * so "old" is a property of the directory: its modification time moves on every
 * record write, because each write creates and renames a file inside it. Only a
 * directory past the window costs more than one `stat`, so a large `.pi/tasks`
 * is scanned cheaply and only what is about to be deleted is read and walked.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { formatBytes } from "./format.js";
import {
  previousTaskRecordPath,
  RUNTIME_STATE_DIRECTORY,
  sessionTaskDirectory,
  type TaskScope,
  taskRecordPath,
} from "./runtime-state.js";
import type { Task, TaskStatus } from "./task.js";
import { parseTaskFile } from "./task-store.js";

/** Milliseconds in one day: the window is configured in days and compared in instants. */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The statuses that mean "this task will never do anything again". A whitelist,
 * not a blacklist, so a status added later is kept until someone decides it is
 * finished: keeping a directory costs disk, deleting a live one costs the user
 * their history.
 */
const FINISHED_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "killed"]);

/** What one sweep reclaimed, and what it could not. */
export interface PruneReport {
  /** Session directories removed. */
  readonly sessions: number;
  /** Bytes those directories held, records and output together. */
  readonly bytes: number;
  /** Directories left behind because they could not be read or removed. */
  readonly failures: number;
}

export interface PruneOptions {
  /** The session running now; its own directory is never a candidate. */
  readonly scope: TaskScope;
  /** How old a session must be, in whole days, before it is reclaimed. */
  readonly retentionDays: number;
  /** Clock seam for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Where a kept directory and the one summary line are sent; silent by default. */
  readonly report?: (message: string) => void;
  /** The deletion step, so a failing filesystem is testable; defaults to `rm`. */
  readonly remove?: (directory: string) => Promise<void>;
}

/**
 * Reclaim every session directory older than the window. A sweep that finds
 * nothing to do costs one `readdir` and one `stat` per session.
 */
export async function pruneSessions(options: PruneOptions): Promise<PruneReport> {
  const now = options.now ?? Date.now;
  const cutoff = now() - options.retentionDays * MILLISECONDS_PER_DAY;
  const root = join(options.scope.cwd, RUNTIME_STATE_DIRECTORY);
  const current = sessionTaskDirectory(options.scope.cwd, options.scope.sessionId);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let sessions = 0;
  let bytes = 0;
  let failures = 0;
  const discard =
    options.remove ?? ((directory: string) => rm(directory, { recursive: true, force: true }));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    if (directory === current) continue;
    const activity = await stat(directory).catch(() => undefined);
    if (activity === undefined) continue;
    if (activity.mtimeMs > cutoff) continue;

    const records = await readRecords(directory);
    if (records === undefined) {
      failures += 1;
      options.report?.(`kept ${entry.name}: its records could not be read`);
      continue;
    }
    if (records.some((task) => !FINISHED_STATUSES.has(task.status))) continue;

    const size = await sizeOf(directory);
    try {
      await discard(directory);
    } catch (error) {
      failures += 1;
      options.report?.(`kept ${entry.name}: ${describe(error)}`);
      continue;
    }
    bytes += size;
    sessions += 1;
  }

  if (sessions > 0) {
    const noun = sessions === 1 ? "session" : "sessions";
    options.report?.(`pruned ${String(sessions)} ${noun}, ${formatBytes(bytes)}`);
  }
  return { sessions, bytes, failures };
}

/** An error as one line, since a report line must not grow a stack trace. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The records in one session directory: `[]` when the session stored nothing,
 * and `undefined` when it stored something this version cannot read. The two
 * cases look alike to a reader that only wants history, but one is safe to
 * delete and the other is not, so they are kept apart.
 */
async function readRecords(directory: string): Promise<readonly Task[] | undefined> {
  let stored = false;
  for (const path of [taskRecordPath(directory), previousTaskRecordPath(directory)]) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    stored = true;
    const tasks = parseTaskFile(text);
    if (tasks !== undefined) return tasks;
  }
  return stored ? undefined : [];
}

/** Bytes on disk under one directory, wherever the tree nests. */
async function sizeOf(directory: string): Promise<number> {
  let total = 0;
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const info = await stat(join(entry.parentPath, entry.name)).catch(() => undefined);
    if (info !== undefined) total += info.size;
  }
  return total;
}
