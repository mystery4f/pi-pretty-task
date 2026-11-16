/**
 * Helpers for tests that start real processes: temporary directories, small
 * scripts the shell can run, polling, and cleaning up what a test spawned.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A temporary directory removed once the test finishes. */
export async function makeTempDir(): Promise<{ path: string; dispose(): Promise<void> }> {
  // Windows CI hands out an 8.3 short path (`C:\Users\RUNNER~1\…`) that the
  // process layer resolves to its long form. One temporary directory that is
  // two strings is two directories to every comparison in these tests, so take
  // the long form once, here.
  const path = await realpath(await mkdtemp(join(tmpdir(), "pi-pretty-task-")));
  return {
    path,
    async dispose() {
      // A process that just exited may still hold its output file for a moment;
      // Node retries those transient Windows errors instead of failing the test.
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** Write a JavaScript file into `dir` and return a shell command that runs it. */
export async function writeScript(dir: string, name: string, source: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, source, "utf8");
  return `node "${path}"`;
}

/**
 * A command that survives the polite signal: on POSIX it installs a SIGTERM
 * handler, and on Windows a console process cannot be asked to close at all.
 * It announces that the handler is in place, because a stop that arrives before
 * the script has started kills a process that never refused anything — that
 * race is what made the Linux runner report a 52ms stop where 500ms was due.
 */
export async function writeStubbornScript(
  dir: string,
  name: string,
): Promise<{ command: string; ready: string }> {
  const ready = join(dir, "ready");
  const lines = [
    "const fs = require('node:fs');",
    ...(process.platform === "win32" ? [] : ["process.on('SIGTERM', () => {});"]),
    `fs.writeFileSync(${JSON.stringify(ready)}, '');`,
    "setInterval(() => {}, 1000);",
    "",
  ];
  return { command: await writeScript(dir, name, lines.join("\n")), ready };
}

/** Wait until `writeStubbornScript`'s command has installed its handler. */
export async function waitUntilReady(ready: string): Promise<void> {
  await waitFor("the stubborn command to install its handler", () => existsSync(ready));
}

/**
 * How long a stop lets the polite signal work before forcing, in the tests. The
 * sequence a stop proves — ask politely, wait, force, confirm the tree is gone —
 * is the same at twenty milliseconds as at the production three seconds; only the
 * waiting differs. `test/process-stop` keeps one test on the real default so the
 * number in the supervisor is still proven, not just quoted.
 */
export const TEST_KILL_GRACE_MS = 20;
/**
 * How often a follow read looks at the output file, in the tests. The answer is
 * the bytes appended since the last read either way; this only shortens the tick.
 */
export const TEST_FOLLOW_POLL_MS = 5;
/**
 * Interval between two looks at the thing a test waits for. Small on purpose: the
 * predicate is cheap and what is waited for is a real process ending or a record
 * changing, so a coarse tick buys nothing and costs its own length per step.
 */
const WAIT_POLL_MS = 5;

/** Resolve once `predicate` is true, or reject after `timeoutMs`. */
export async function waitFor(
  what: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}`);
}

/**
 * Kill a process and everything it started. Best effort, and best effort means
 * bounded: cleanup runs in `afterEach`, where a `taskkill` that hung (the target
 * already gone, a busy machine) would spend the hook's timeout on a process the
 * test has already finished asserting about.
 */
export async function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  await new Promise<void>((resolve) => {
    if (process.platform === "win32") {
      const timer = setTimeout(resolve, CLEANUP_KILL_TIMEOUT_MS);
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {
        clearTimeout(timer);
        resolve();
      });
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    resolve();
  });
}

/** How long cleanup waits on a kill before leaving the process to the runner. */
const CLEANUP_KILL_TIMEOUT_MS = 4000;

/** True while a process with this pid exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
