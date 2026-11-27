/**
 * The minute after a detach, as the model meets it: the refusal text arrives in the
 * tool result of the next front-of-turn call, and the task record says why it moved.
 *
 * Real processes on purpose: a detach is a race between a live process and a key
 * press, and a fake process would only prove the fake (ADR-0026).
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { sessionTaskDirectory, taskRecordPath } from "../../src/tasks/base/runtime-state.js";
import { ADOPT_FOREGROUND_ENV } from "../../src/tasks/base/settings.js";
import type { ProcessTask, Task } from "../../src/tasks/base/task.js";
import { DETACH_QUIET_MS } from "../../src/tasks/process/foreground.js";
import { createHarness, type Harness, resultText } from "../support/extension-harness.js";
import { makeTempDir, waitFor, writeScript } from "../support/processes.js";

const SESSION = "session-detach-window";

interface TempDir {
  readonly path: string;
  dispose(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

/** A clock the test moves, so the minute passes without waiting for it. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_800_000_000_000;
  return { now: () => at, advance: (ms) => (at += ms) };
}

async function records(dir: TempDir): Promise<readonly Task[]> {
  const path = taskRecordPath(sessionTaskDirectory(dir.path, SESSION));
  const document = JSON.parse(await readFile(path, "utf8")) as { tasks: Task[] };
  return document.tasks;
}

async function longCommand(dir: TempDir): Promise<string> {
  return writeScript(
    dir.path,
    "long.mjs",
    ["console.log('building the site');", "setInterval(() => {}, 1000);", ""].join("\n"),
  );
}

describe("the minute after a detach", () => {
  it("refuses the next front-of-turn call and says why", async () => {
    const dir = await makeTempDir();
    cleanups.push(dir.dispose.bind(dir));
    const time = clock();
    const harness: Harness = createHarness(
      { cwd: dir.path, sessionId: SESSION },
      {
        env: { ...process.env, [ADOPT_FOREGROUND_ENV]: "on" },
        now: time.now,
      },
    );
    await harness.startSession();

    const command = await longCommand(dir);
    const pending = harness.call("bash", { command });
    await waitFor("the command to reach the foreground", () => {
      return harness.controller.foreground.live().length === 1;
    });
    await waitFor("the command's first line to reach the output file", async () => {
      const path = harness.controller.foreground.live()[0]?.outputPath;
      if (path === undefined) return false;
      const text = await readFile(path, "utf8").catch(() => "");
      return text.includes("building the site");
    });

    const detached = harness.runShortcut("ctrl+shift+b");
    const receipt = resultText(await pending);

    // The receipt itself carries the rule, so the model reads it before a refusal.
    expect(receipt).toContain("pretty_task_bg_run from here");
    await detached;

    const record = (await records(dir)).find(
      (task): task is ProcessTask => task.kind === "process" && task.origin === "foreground",
    );
    expect(record?.detached).toEqual({ trigger: "shortcut", heldSeconds: expect.any(Number) });

    // A foreground command in that minute is refused, and the refusal is the reminder.
    const refused = await harness.call("bash", { command: "pwd" }).then(
      (result) => resultText(result),
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(refused).toContain("was just moved to the background");
    expect(refused).toContain("pretty_task_bg_run");

    // A blocking call is refused too: it would hold the turn exactly as before.
    const blocked = await harness.call("pretty_task_bg_run", { command, wait: true });
    expect(resultText(blocked)).toContain("was just moved to the background");
    expect(resultText(blocked)).toContain("`wait: true` is refused");

    // Once the minute passes, the same call is accepted again.
    time.advance(DETACH_QUIET_MS);
    const accepted = await harness.call("pretty_task_bg_run", {
      command: "node -e \"console.log('after the window')\"",
      wait: true,
    });
    expect(resultText(accepted)).toContain("after the window");

    // The detached command is still running: stop it so the suite leaves no tree.
    for (const task of (await records(dir)).filter((task) => task.status === "running")) {
      await harness.controller.processTasks.stop({ cwd: dir.path, sessionId: SESSION }, task.id);
    }
  });
});

afterAll(async () => {
  for (const dispose of cleanups) await dispose();
});
