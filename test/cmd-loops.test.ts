/**
 * Command loops: one schedule that starts a background process per fire. The
 * child is an ordinary process task and the loop keeps the fire history, so the
 * tests drive real processes and read the loop back through its tools.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness, resultText, type Turn } from "./support/extension-harness.js";
import { killTree, makeTempDir, isAlive, waitFor, writeScript } from "./support/processes.js";

interface FireDetails {
  fire: number;
  at: number;
  outcome: string;
  exitCode?: number | null;
  durationMs?: number;
  outputBytes?: number;
  taskId?: string;
  error?: string;
}

interface CmdDetails {
  id: string;
  name: string;
  kind: string;
  status: string;
  schedule: string;
  command?: string;
  cwd?: string;
  wakeOnFailure?: boolean;
  fires: number;
  missedFires?: number;
  consecutiveFailures?: number;
  nextFireAt?: number;
  lastFireAt?: number;
  endedAt?: number;
  lastExitCode?: number | null;
  lastOutputPath?: string;
  lastOutputBytes?: number;
  fireCount?: number;
  fireHistory?: FireDetails[];
}

const cleanup: Array<() => Promise<void>> = [];
const spawned: number[] = [];

afterEach(async () => {
  while (spawned.length > 0) await killTree(spawned.pop());
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** One temp directory per test, a pinned clock, and a harness on top of both. */
async function setup(sessionId = "session-cmd-loops") {
  const directory = await makeTempDir();
  cleanup.push(directory.dispose);
  let now = Date.UTC(2026, 0, 1, 9, 0, 0);
  const turn: Turn = { cwd: directory.path, sessionId };
  const harness = createHarness(turn, { now: () => now });
  return {
    directory,
    turn,
    harness,
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

function detailsOf(result: { details: unknown }): CmdDetails {
  return result.details as CmdDetails;
}

async function createCmd(harness: Harness, params: Record<string, unknown>): Promise<CmdDetails> {
  return detailsOf(await harness.call("loop_create", { schedule: "10s", ...params }));
}

/** Advance the pinned clock to the loop's next slot and pump once. */
async function fireDue(
  task: { advance(ms: number): void; now: number; harness: Harness },
  loop: CmdDetails,
): Promise<void> {
  const next = loop.nextFireAt ?? task.now;
  task.advance(Math.max(0, next - task.now));
  await task.harness.pump(task.now);
}

async function loopDetails(harness: Harness, id: string): Promise<CmdDetails> {
  return detailsOf(await harness.call("loop_list", { id }));
}

async function fireOf(harness: Harness, id: string, fire: number): Promise<FireDetails | undefined> {
  const details = await loopDetails(harness, id);
  return details.fireHistory?.find((entry) => entry.fire === fire);
}

async function waitForFire(
  harness: Harness,
  id: string,
  fire: number,
  outcome: string,
): Promise<FireDetails> {
  let answer: FireDetails | undefined;
  await waitFor(`fire #${String(fire)} to be ${outcome}`, async () => {
    answer = await fireOf(harness, id, fire);
    return answer?.outcome === outcome;
  });
  if (answer === undefined) throw new Error(`fire #${String(fire)} disappeared`);
  return answer;
}

/** The pid of a running child, watched so the test can clean it up on failure. */
async function pidOf(harness: Harness, taskId: string): Promise<number | undefined> {
  const details = (await harness.call("bg_status", { id: taskId })).details as { pid?: number };
  if (details.pid !== undefined) spawned.push(details.pid);
  return details.pid;
}

describe("command loops", () => {
  it("fires a real process and shows it through bg_status and bg_logs", async () => {
    const task = await setup();
    const script = await writeScript(
      task.directory.path,
      "watcher.js",
      'console.log("fire start");\nsetTimeout(() => console.log("fire end"), 400);\n',
    );
    const loop = await createCmd(task.harness, { command: script, name: "watcher" });

    expect(loop).toMatchObject({ kind: "cmd-loop", status: "running", command: script, fires: 0 });
    expect(loop.id).toMatch(/^lc-[a-z0-9]{5}$/);

    await fireDue(task, loop);

    const fired = await loopDetails(task.harness, loop.id);
    expect(fired.fires).toBe(1);
    const running = fired.fireHistory?.[0];
    if (running?.taskId === undefined) throw new Error("a fire starts a child process");
    // The child id is an ordinary opaque process id: neither the owning loop nor
    // the fire number is encoded in it (ADR-0016).
    expect(running.taskId).toMatch(/^bg-[a-z0-9]{5}$/);
    expect(running.taskId).not.toContain(loop.id);
    expect(running.taskId).not.toContain("#1");
    expect(running).toMatchObject({ fire: 1, outcome: "running" });
    await pidOf(task.harness, running.taskId);

    const status = resultText(await task.harness.call("bg_status", { id: running.taskId }));
    expect(status).toContain("name: watcher #1");
    expect(status).toContain("kind: process");
    expect(status).toContain("status: running");
    // A fire is a task of the session: the listing answers for it too (ADR-0014).
    expect(resultText(await task.harness.call("bg_status", {}))).toContain(running.taskId);

    await waitFor("the first output line", async () => {
      const logs = resultText(await task.harness.call("bg_logs", { id: running.taskId }));
      return logs.includes("fire start");
    });

    const finished = await waitForFire(task.harness, loop.id, 1, "success");
    expect(finished).toMatchObject({ exitCode: 0, taskId: running.taskId });
    expect(finished.outputBytes).toBeGreaterThan(0);
    const after = await loopDetails(task.harness, loop.id);
    if (after.lastOutputPath === undefined) throw new Error("a finished fire records its output");
    const written = await readFile(after.lastOutputPath, "utf8");
    expect(written).toContain("fire start");
    expect(written).toContain("fire end");
    expect(after.lastExitCode).toBe(0);
    // A healthy fire is quiet: nothing lands in the transcript (acceptance 9).
    expect(task.harness.messages).toEqual([]);
  });

  it("skips a fire while the previous one is still running, and counts it as skipped", async () => {
    const task = await setup();
    const script = await writeScript(
      task.directory.path,
      "slow.js",
      'console.log("started");\nsetTimeout(() => console.log("done"), 1500);\n',
    );
    const loop = await createCmd(task.harness, { command: script, name: "slow" });

    await fireDue(task, loop);
    const first = await loopDetails(task.harness, loop.id);
    if (first.fireHistory?.[0]?.taskId === undefined) throw new Error("the first fire must run");
    await pidOf(task.harness, first.fireHistory[0].taskId);

    task.advance(10_000);
    await task.harness.pump(task.now);

    const skipped = await loopDetails(task.harness, loop.id);
    expect(skipped.fires).toBe(2);
    expect(skipped.missedFires).toBe(1);
    expect(skipped.fireHistory?.map((entry) => entry.outcome)).toEqual(["running", "skipped"]);
    // A skipped fire never ran, so it carries no child and no exit code.
    expect(skipped.fireHistory?.[1]).toMatchObject({ fire: 2, outcome: "skipped" });
    expect(skipped.fireHistory?.[1]?.taskId).toBeUndefined();

    await waitForFire(task.harness, loop.id, 1, "success");
    await waitForFire(task.harness, loop.id, 2, "skipped");
  });

  it("stops the running fire when its loop stops, and never fires again", async () => {
    const task = await setup();
    const script = await writeScript(
      task.directory.path,
      "long.js",
      'console.log("started");\nsetTimeout(() => console.log("done"), 30_000);\n',
    );
    const loop = await createCmd(task.harness, { command: script, name: "long" });

    await fireDue(task, loop);
    const fired = await loopDetails(task.harness, loop.id);
    const child = fired.fireHistory?.[0]?.taskId;
    if (child === undefined) throw new Error("the fire must start a child");
    const pid = await pidOf(task.harness, child);
    if (pid === undefined) throw new Error("a running child must have a pid");

    const stopped = resultText(
      await task.harness.call("loop_update", { id: loop.id, action: "complete" }),
    );
    expect(stopped).toContain(`Completed loop ${loop.id}`);

    await waitFor("the child to die", () => (pid === undefined ? true : !isAlive(pid)));
    const interrupted = await waitForFire(task.harness, loop.id, 1, "interrupted");
    expect(interrupted).toMatchObject({ taskId: child });

    const stoppedLoop = await loopDetails(task.harness, loop.id);
    expect(stoppedLoop).toMatchObject({ status: "completed" });
    expect(stoppedLoop.nextFireAt).toBeUndefined();

    task.advance(60_000);
    await task.harness.pump(task.now);
    expect((await loopDetails(task.harness, loop.id)).fires).toBe(1);
  });

  it("rejects a loop that asks for both a prompt and a command, and one that asks for neither", async () => {
    const task = await setup();
    const both = resultText(
      await task.harness.call("loop_create", {
        schedule: "10s",
        prompt: "review the diff",
        command: "echo hi",
      }),
    );
    expect(both).toContain("either a prompt or a command, not both");
    expect(both).toContain("drop the prompt");

    const neither = resultText(await task.harness.call("loop_create", { schedule: "10s" }));
    expect(neither).toContain("needs a prompt or a command");
    expect(neither).toContain("bg_run");
  });

  it("rejects command-only options on a prompt loop instead of ignoring them", async () => {
    const task = await setup();
    for (const [option, value] of [
      ["cwd", task.directory.path],
      ["env", { NAME: "value" }],
      ["wakeOnFailure", true],
    ] as const) {
      const text = resultText(
        await task.harness.call("loop_create", {
          schedule: "10s",
          prompt: "review the diff",
          [option]: value,
        }),
      );
      expect(text).toContain(`Invalid ${option} for a prompt loop`);
      expect(text).toContain("This loop has a prompt and runs no command");
    }
  });

  it("announces a failed fire and stays silent when wakeOnFailure is off", async () => {
    const task = await setup();
    const script = await writeScript(
      task.directory.path,
      "boom.js",
      'console.error("boom");\nprocess.exit(3);\n',
    );
    const loud = await createCmd(task.harness, { command: script, name: "loud" });

    await fireDue(task, loud);
    await waitForFire(task.harness, loud.id, 1, "failed");

    expect(task.harness.messages).toHaveLength(1);
    const notice = task.harness.messages[0];
    expect(notice?.customType).toBe("task-finished");
    expect(notice?.content).toContain("name: loud #1");
    expect(notice?.content).toContain("exit code: 3");
    expect(notice?.content).toContain("boom");

    const quiet = await createCmd(task.harness, {
      command: script,
      name: "quiet",
      wakeOnFailure: false,
    });
    await fireDue(task, quiet);
    await waitForFire(task.harness, quiet.id, 1, "failed");
    expect(task.harness.messages).toHaveLength(1);
  });

  it("keeps the schedule across a restart and marks the in-flight fire interrupted", async () => {
    const task = await setup("session-restart");
    const script = await writeScript(
      task.directory.path,
      "hang.js",
      'console.log("started");\nsetTimeout(() => {}, 20_000);\n',
    );
    const loop = await createCmd(task.harness, { command: script, name: "hang" });
    const scheduledFor = loop.nextFireAt;
    if (scheduledFor === undefined) throw new Error("a loop must have a next fire");

    await fireDue(task, loop);
    const fired = await loopDetails(task.harness, loop.id);
    const child = fired.fireHistory?.[0]?.taskId;
    if (child === undefined) throw new Error("the fire must start a child");
    await pidOf(task.harness, child);
    expect(fired.nextFireAt).toBeGreaterThan(scheduledFor);

    // A second extension over the same session directory is what a restart looks
    // like: the store is reloaded, and load is where an interrupted run is closed.
    const restarted = createHarness(task.turn, { now: () => task.now });
    await restarted.startSession();

    const reloaded = await loopDetails(restarted, loop.id);
    expect(reloaded).toMatchObject({ status: "running", schedule: "10s", fires: 1 });
    expect(reloaded.nextFireAt).toBe(fired.nextFireAt);
    expect(reloaded.fireHistory?.[0]).toMatchObject({ fire: 1, outcome: "interrupted" });

    // The interrupted fire is never resumed: nothing new starts until the next slot.
    await restarted.pump(task.now);
    expect((await loopDetails(restarted, loop.id)).fires).toBe(1);
  });

  it("backs off after a failed fire, doubling the wait and capping it at an hour", async () => {
    const task = await setup();
    const script = await writeScript(
      task.directory.path,
      "fail.js",
      "process.exit(1);\n",
    );
    // A forty-minute schedule doubles past the cap on its first failure.
    const loop = await createCmd(task.harness, { command: script, schedule: "40m" });

    await fireDue(task, loop);
    await waitForFire(task.harness, loop.id, 1, "failed");

    const after = await loopDetails(task.harness, loop.id);
    expect(after.consecutiveFailures).toBe(1);
    if (after.nextFireAt === undefined || after.lastFireAt === undefined) {
      throw new Error("a failed loop must still be scheduled");
    }
    expect(after.nextFireAt - after.lastFireAt).toBeLessThanOrEqual(3_600_000);
    expect(after.nextFireAt - after.lastFireAt).toBeGreaterThan(3_500_000);
  });

  it("rewrites the loop into the current file version with its fire history", async () => {
    const task = await setup();
    const script = await writeScript(task.directory.path, "ok.js", 'console.log("ok");\n');
    const loop = await createCmd(task.harness, { command: script, name: "keeper" });
    await fireDue(task, loop);
    await waitForFire(task.harness, loop.id, 1, "success");

    const restarted = createHarness(task.turn, { now: () => task.now });
    const reloaded = detailsOf(await restarted.call("loop_list", { id: loop.id }));
    expect(reloaded).toMatchObject({ kind: "cmd-loop", command: script, fires: 1 });
    expect(reloaded.fireHistory?.[0]).toMatchObject({ fire: 1, outcome: "success" });
  });
});
