/**
 * A `wait: true` run as the model and the user see it: the tool call stays open
 * while the task it started runs, and the shortcut lets the call go without
 * touching the process (ADR-0025).
 *
 * Real children, on purpose: the claim under test is that the task keeps its PID
 * and its output file across the hand-off, and a fake process would only prove the
 * fake. The wait itself is a listener on the record, so the same assertions also
 * show that a blocked call is a task from the first millisecond, not a foreground
 * run that becomes one later.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { sessionTaskDirectory, taskRecordPath } from "../../src/tasks/base/runtime-state.js";
import type { ProcessTask, Task } from "../../src/tasks/base/task.js";
import { createHarness, type Harness, resultText } from "../support/extension-harness.js";
import { makeTempDir, waitFor, writeScript } from "../support/processes.js";

const SESSION = "session-blocking";

interface TempDir {
  readonly path: string;
  dispose(): Promise<void>;
}

/** What a blocking call adds to the usual task details. */
interface BlockedDetails {
  readonly id: string;
  readonly status: string;
  readonly exitCode?: number | null;
  readonly waited: boolean;
  readonly stop: string;
}

/**
 * The process task records on disk, which is what a later turn would read. A loop
 * or chain record shares the file but has no pid, so only these are the shape this
 * suite asserts about.
 */
async function processes(dir: TempDir): Promise<readonly ProcessTask[]> {
  const path = taskRecordPath(sessionTaskDirectory(dir.path, SESSION));
  // A refusal that never started a task leaves no record file at all, and "no file"
  // is the same claim as "no records" wherever this is called.
  const raw = await readFile(path, "utf8").catch(() => '{"tasks":[]}');
  const document = JSON.parse(raw) as { tasks: Task[] };
  return document.tasks.filter((task): task is ProcessTask => task.kind === "process");
}

const cleanups: Array<() => Promise<void>> = [];

async function setup(): Promise<{ harness: Harness; dir: TempDir }> {
  const dir = await makeTempDir();
  cleanups.push(dir.dispose.bind(dir));

  const harness = createHarness({ cwd: dir.path, sessionId: SESSION });
  await harness.startSession();
  return { harness, dir };
}

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

describe("pretty_task_bg_run with wait", () => {
  it("answers with the ending of a command that ends on its own", async () => {
    const { harness, dir } = await setup();
    const command = await writeScript(
      dir.path,
      "ends.mjs",
      ["console.log('compiling');", "setTimeout(() => process.exit(3), 400);", ""].join("\n"),
    );

    const result = await harness.call("pretty_task_bg_run", { command, wait: true });
    const text = resultText(result);
    const details = result.details as BlockedDetails;

    // The answer is the ending, not the id: without `wait` the same call would say
    // "Started background task …" and return while the command still ran.
    expect(text).not.toContain("Started background task");
    expect(text).toContain("exited with code 3");
    expect(text).toContain("compiling");
    expect(details.waited).toBe(true);
    expect(details.stop).toBe("ended");
    expect(details.exitCode).toBe(3);

    // The store writes behind the in-memory status, so the ending reaches the file
    // a tick or two after the call returned — the same wait task-persistence.test.ts
    // does. Exit 3 is a failure with its code recorded, not a completion.
    await waitFor("the finished record to reach disk", async () => {
      const task = (await processes(dir)).find((record) => record.id === details.id);
      return task?.status === "failed" && task.exitCode === 3;
    });
  });

  it("keeps the task running when the shortcut lets the call go", async () => {
    const { harness, dir } = await setup();
    const command = await writeScript(
      dir.path,
      "slow.mjs",
      [
        "console.log('started work');",
        "setTimeout(() => { console.log('work done'); process.exit(5); }, 1500);",
        "",
      ].join("\n"),
    );

    const pending = harness.call("pretty_task_bg_run", { command, wait: true });
    await waitFor(
      "the call to block on its own task",
      () => harness.controller.processTasks.blockedCount() === 1,
    );

    // Before the key: a record that is already running, with a pid and an output
    // file of its own. A foreground run would have neither.
    const [before] = await processes(dir);
    expect(before?.status).toBe("running");
    expect(before?.pid).toBeDefined();
    const outputPath = before?.outputPath;
    expect(outputPath).toBeDefined();
    await waitFor("the command's first line to reach the output file", async () => {
      if (outputPath === undefined) return false;
      return (await readFile(outputPath, "utf8").catch(() => "")).includes("started work");
    });

    await harness.runShortcut("ctrl+shift+b");
    const settledCall = await pending;
    const text = resultText(settledCall);
    const details = settledCall.details as BlockedDetails;

    // (a) The call answers with a task id and no exit code, the way ADR-0020's
    // detach does: the same receipt, because the caller is in the same position.
    expect(details.waited).toBe(false);
    expect(details.stop).toBe("released");
    expect(details.id).toBe(before?.id);
    expect(details.exitCode ?? null).toBeNull();
    expect(text).toContain(`↪ moved to ${details.id}`);
    expect(text).toContain("started work");
    expect(text).not.toContain("exit code");
    expect(harness.controller.processTasks.blockedCount()).toBe(0);
    // The press leaves the same card a foreground detach leaves. Without it the only
    // trace would be inside the tool result, which is the model's channel, not the user's.
    const card = harness.entries.find((entry) => entry.customType === "task-detached");
    expect(card?.data).toEqual({
      id: details.id,
      trigger: "shortcut",
      afterSeconds: expect.any(Number),
    });

    // (b) The record is still running, and it is still the same process: no
    // restart, no fresh file, no second task.
    const [after] = await processes(dir);
    expect(after?.id).toBe(before?.id);
    expect(after?.status).toBe("running");
    expect(after?.pid).toBe(before?.pid);
    expect(after?.outputPath).toBe(outputPath);

    // (c) It ends on its own later, with its real exit code, in the same file.
    await waitFor("the task to end with its real exit code", async () => {
      // A non-zero exit is a failure that keeps its code, so the pair is the check.
      const task = (await processes(dir)).find((record) => record.id === details.id);
      return task?.status === "failed" && task.exitCode === 5;
    });
    expect(await readFile(outputPath as string, "utf8")).toContain("work done");
  });

  it("stops waiting when waitSeconds passes without touching the process", async () => {
    const { harness, dir } = await setup();
    const command = await writeScript(
      dir.path,
      "outlives.mjs",
      [
        "console.log('long work');",
        "setTimeout(() => { console.log('too late'); process.exit(7); }, 8000);",
        "",
      ].join("\n"),
    );

    const startedAt = Date.now();
    const result = await harness.call("pretty_task_bg_run", {
      command,
      wait: true,
      waitSeconds: 1,
    });
    const took = Date.now() - startedAt;
    const text = resultText(result);
    const details = result.details as BlockedDetails;

    // The deadline is the call's, not the task's: an eight-second child, a
    // one-second wait, and the answer arrives long before the child ends (ADR-0027).
    expect(took).toBeLessThan(6000);
    expect(details.waited).toBe(false);
    expect(details.stop).toBe("deadline");
    expect(details.exitCode ?? null).toBeNull();
    expect(text).toContain("waitSeconds deadline passed");
    expect(text).toContain("the task was not touched");
    // The tail may still be empty at one second, so the answer must not claim an
    // ending — it says the task is still running and offers the two commands.
    expect(text).toContain("is still running");

    // Three exits, three sentences: the deadline borrows neither Esc's nor the
    // shortcut's, and it moves nothing, so it draws no card.
    expect(text).not.toContain("this call stopped waiting");
    expect(text).not.toContain("the shortcut let this call go");
    expect(text).not.toContain("↪ moved to");
    expect(harness.entries.some((entry) => entry.customType === "task-detached")).toBe(false);

    // The union the key reads is honest again: nothing is waiting on this call.
    expect(harness.controller.processTasks.blockedCount()).toBe(0);

    // The record is still the same live process: no restart, no ending, no kill.
    await waitFor("the record to still show a running process", async () => {
      const [record] = await processes(dir);
      return record?.status === "running" && record.pid !== undefined;
    });
    const [running] = await processes(dir);
    expect(running?.id).toBe(details.id);

    await harness.call("pretty_task_bg_kill", { id: details.id });
  });

  it("refuses to wait for a queued step", async () => {
    const { harness, dir } = await setup();
    const first = await writeScript(dir.path, "first.mjs", "setTimeout(() => {}, 1500);");
    const started = await harness.call("pretty_task_bg_run", { command: first });
    const firstId = (started.details as BlockedDetails).id;

    const refused = await harness.call("pretty_task_bg_run", {
      command: await writeScript(dir.path, "queued.mjs", "process.exit(0);"),
      after: firstId,
      wait: true,
    });

    // Nothing started: a queued step has no beginning this call could wait for, so
    // the refusal names both parameters and leaves no record behind (ADR-0025).
    expect(resultText(refused)).toContain("`wait` cannot be used with `after`");
    expect(resultText(refused)).toContain("The task was not started.");
    expect(await processes(dir)).toHaveLength(1);

    await harness.call("pretty_task_bg_kill", { id: firstId });
  });

  it("refuses a waitSeconds bound that nothing would hold open", async () => {
    const { harness, dir } = await setup();

    // A bound with no `wait` would be silently ignored, and an ignored parameter reads
    // as applied; the refusal names the parameter that caps the task instead (ADR-0027).
    const refused = await harness.call("pretty_task_bg_run", {
      command: await writeScript(dir.path, "bounded-nowhere.mjs", "process.exit(0);"),
      waitSeconds: 5,
    });

    expect(resultText(refused)).toContain("`waitSeconds` bounds how long a blocking call waits");
    expect(resultText(refused)).toContain("`timeoutSeconds`");
    expect(resultText(refused)).toContain("The task was not started.");
    expect(await processes(dir)).toHaveLength(0);
  });

  // Two real children, two three-second tree kills and a wait on each record: under a
  // loaded machine (the full suite runs both projects at once) 30 s is not enough, and
  // 60 s lost the race too (2026-11-28, three workers) while the test finishes in a few
  // seconds alone. Its own waits fail by name well before this ceiling, so a longer
  // bound hides nothing.
  it("lets no call go while two are blocked", { timeout: 120_000 }, async () => {
    const { harness, dir } = await setup();
    const first = harness.call("pretty_task_bg_run", {
      command: await writeScript(dir.path, "one.mjs", "setInterval(() => {}, 1000);"),
      wait: true,
    });
    const second = harness.call("pretty_task_bg_run", {
      command: await writeScript(dir.path, "two.mjs", "setInterval(() => {}, 1000);"),
      wait: true,
    });
    await waitFor(
      "both calls to block",
      () => harness.controller.processTasks.blockedCount() === 2,
    );

    let settled = 0;
    void first.then(() => {
      settled += 1;
    });
    void second.then(() => {
      settled += 1;
    });

    // ADR-0020's rule, now counting both waiting kinds: a key press cannot know
    // which one the user meant, so it picks none and says so in the notification.
    await harness.runShortcut("ctrl+shift+b");
    expect(harness.controller.processTasks.blockedCount()).toBe(2);
    expect(settled).toBe(0);

    // Ending the tasks is what ends their waits — the key left them alone.
    for (const record of await processes(dir)) {
      await harness.call("pretty_task_bg_kill", { id: record.id });
    }
    expect((await first).details as BlockedDetails).toMatchObject({ stop: "ended" });
    expect((await second).details as BlockedDetails).toMatchObject({ stop: "ended" });
  });
});
