/**
 * Tidying up a test's temporary directory must never be what fails the test. On
 * Windows a child process keeps its working directory open, and the OS refuses to
 * remove that directory however long the retries run — which once turned two
 * passing integration cases red on a CI runner with an `EBUSY` and no assertion
 * behind it.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../support/processes.js";

describe("a test's temporary directory", () => {
  it("gives way instead of failing when a child still holds it", async () => {
    const work = await makeTempDir();
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 30000)"], {
      cwd: work.path,
      stdio: "ignore",
    });

    try {
      await expect(work.dispose()).resolves.toBeUndefined();
    } finally {
      holder.kill();
    }
  });
});
