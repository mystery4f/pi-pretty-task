/**
 * A record write ends in a rename, and on Windows that rename fails with `EPERM`
 * or `EBUSY` for as long as any handle holds the target — a reader polling the
 * file, a virus scanner, another pi session. The store swallows a failed write by
 * design (a full disk must not fail a running task), so the retry is what keeps a
 * generation from silently never landing.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { describe, expect, it } from "vitest";
import { renameWithRetry } from "../../src/tasks/base/task-store.js";

function failure(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`simulated ${code}`);
  error.code = code;
  return error;
}

describe("renaming a generation into place", () => {
  it("waits out a share the OS has not released yet", async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    let attempt = 0;

    await renameWithRetry("tasks.json.tmp", "tasks.json", {
      attempts: 5,
      delayMs: 7,
      renameImpl: async (from, to) => {
        calls.push(`${from}->${to}`);
        attempt += 1;
        if (attempt < 3) throw failure(attempt === 1 ? "EPERM" : "EBUSY");
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([7, 7]);
  });

  it("gives up on a failure that waiting cannot fix", async () => {
    const sleeps: number[] = [];
    let attempts = 0;

    const renaming = renameWithRetry("tasks.json.tmp", "tasks.json", {
      attempts: 5,
      delayMs: 7,
      renameImpl: async () => {
        attempts += 1;
        throw failure("ENOENT");
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(renaming).rejects.toThrow(/ENOENT/);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("reports the last attempt once the retries run out", async () => {
    let attempts = 0;

    const renaming = renameWithRetry("tasks.json.tmp", "tasks.json", {
      attempts: 3,
      delayMs: 1,
      renameImpl: async () => {
        attempts += 1;
        throw failure("EPERM");
      },
      sleep: async () => undefined,
    });

    await expect(renaming).rejects.toThrow(/simulated EPERM/);
    expect(attempts).toBe(3);
  });
});
