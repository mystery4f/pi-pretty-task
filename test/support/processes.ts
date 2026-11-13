/**
 * Helpers for tests that start real processes: temporary directories, small
 * scripts the shell can run, polling, and cleaning up what a test spawned.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A temporary directory removed once the test finishes. */
export async function makeTempDir(): Promise<{ path: string; dispose(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "pi-pretty-task-"));
  return {
    path,
    async dispose() {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/** Write a JavaScript file into `dir` and return a shell command that runs it. */
export async function writeScript(dir: string, name: string, source: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, source, "utf8");
  return `node "${path}"`;
}

/** Resolve once `predicate` is true, or reject after `timeoutMs`. */
export async function waitFor(
  what: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}`);
}

/** Kill a process and everything it started. Best effort: the test owns it. */
export async function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  await new Promise<void>((resolve) => {
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
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
