/**
 * Extension seam: chains as the model meets them — `bg_run` queues behind a task or
 * a chain, `bg_status` reads a queue and its steps, `bg_kill` stops a queue. The
 * steps are ordinary tasks throughout, so every outcome is read from a task record.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, resultText } from "./support/extension-harness.js";
import { killTree, makeTempDir, waitFor, writeScript } from "./support/processes.js";

interface TaskDetails {
  id: string;
  name: string;
  kind: string;
  status: string;
  parentId?: string;
  cursor?: number;
  steps?: string[];
  pid?: number;
  exitCode?: number | null;
  error?: string;
}

const cleanup: Array<() => Promise<void>> = [];
const spawned: number[] = [];

afterEach(async () => {
  while (spawned.length > 0) await killTree(spawned.pop());
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** One step script: it records when it starts and ends, then exits as told. */
const STEP_SCRIPT = [
  'const fs = require("node:fs");',
  "const log = process.env.STEP_LOG;",
  'const name = process.env.STEP_NAME || "step";',
  'fs.appendFileSync(log, "start " + name + "\\n");',
  'console.log("start " + name);',
  "setTimeout(() => {",
  '  fs.appendFileSync(log, "end " + name + "\\n");',
  '  console.log("end " + name);',
  "  process.exit(Number(process.env.STEP_EXIT || 0));",
  "}, Number(process.env.STEP_DELAY || 0));",
  "",
].join("\n");

/** `bg_run` and return its details, tracking the pid for cleanup. */
async function run(harness: Harness, params: Record<string, unknown>): Promise<TaskDetails> {
  const result = await harness.call("bg_run", params);
  const details = result.details as TaskDetails;
  if (details.pid !== undefined) spawned.push(details.pid);
  return details;
}

async function status(harness: Harness, id: string): Promise<TaskDetails> {
  return (await harness.call("bg_status", { id })).details as TaskDetails;
}

/** Ask for one task's status until its status is one of `statuses`. */
async function waitForStatus(
  harness: Harness,
  id: string,
  ...statuses: string[]
): Promise<TaskDetails> {
  await waitFor(`task ${id} to be ${statuses.join(" or ")}`, async () => {
    const details = await status(harness, id);
    return statuses.includes(details.status);
  });
  return status(harness, id);
}

describe("bg_run after", () => {
  it("queues the command behind a running task and answers with the queue it joined", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const log = join(dir.path, "steps.log");
    const command = await writeScript(dir.path, "step.js", STEP_SCRIPT);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-after" });

    const ahead = await run(harness, {
      name: "build",
      command,
      env: { STEP_LOG: log, STEP_NAME: "build", STEP_DELAY: "400" },
    });
    // A task of no chain stays a process task: it is never a chain of one.
    expect((await status(harness, ahead.id)).kind).toBe("process");
    const result = await harness.call("bg_run", {
      name: "deploy",
      command,
      after: ahead.id,
      env: { STEP_LOG: log, STEP_NAME: "deploy" },
    });
    const text = resultText(result);
    const queued = result.details as TaskDetails;
    const chainId = queued.parentId ?? "";
    expect(chainId).toMatch(/^ch-[a-z0-9]{5}$/);
    // The answer names both ids: the step the model may read, and the queue to watch.
    expect(text).toContain(queued.id);
    expect(text).toContain(chainId);
    expect(text).toContain("waiting");

    // A waiting step is never called running, and it says which queue holds it.
    const step = await status(harness, queued.id);
    expect(step.status).toBe("waiting");
    expect(step.parentId).toBe(chainId);

    // The queue is one row of its own; the step is not a second row.
    const chain = await waitForStatus(harness, chainId, "completed");
    expect(chain.steps).toEqual([ahead.id, queued.id]);
    expect(chain.cursor).toBe(2);
    const listed = (await harness.call("bg_status", {})).details as { tasks: TaskDetails[] };
    const ids = listed.tasks.map((task) => task.id);
    expect(ids).toContain(chainId);
    expect(ids).not.toContain(queued.id);
    expect(ids).not.toContain(ahead.id);
  });

  it("runs the queued steps one at a time and shows the queue with its steps", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const log = join(dir.path, "steps.log");
    const command = await writeScript(dir.path, "step.js", STEP_SCRIPT);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-chain" });

    const first = await run(harness, {
      name: "one",
      command,
      env: { STEP_LOG: log, STEP_NAME: "one", STEP_DELAY: "100" },
    });
    const second = await run(harness, {
      name: "two",
      command,
      after: first.id,
      env: { STEP_LOG: log, STEP_NAME: "two", STEP_DELAY: "100" },
    });
    const chainId = second.parentId ?? "";
    const third = await run(harness, {
      name: "three",
      command,
      after: chainId,
      env: { STEP_LOG: log, STEP_NAME: "three" },
    });

    await waitForStatus(harness, chainId, "completed");
    const queue = resultText(await harness.call("bg_status", { id: chainId }));
    expect(queue).toContain(`kind: chain`);
    expect(queue).toContain(`steps: 3`);
    // Every step reads its own record: status, exit code and output are its own.
    for (const step of [first, second, third]) {
      expect(queue).toContain(step.id);
      expect(queue).toContain(step.name);
    }
    expect(queue).toContain("completed · exit 0");
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "start one",
      "end one",
      "start two",
      "end two",
      "start three",
      "end three",
    ]);
  });

  it("fails the queue on a failing step and skips what was behind it", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const log = join(dir.path, "steps.log");
    const command = await writeScript(dir.path, "step.js", STEP_SCRIPT);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-chain-fail" });

    const build = await run(harness, {
      name: "build",
      command,
      env: { STEP_LOG: log, STEP_NAME: "build", STEP_EXIT: "1" },
    });
    const deploy = await run(harness, {
      name: "deploy",
      command,
      after: build.id,
      env: { STEP_LOG: log, STEP_NAME: "deploy" },
    });
    const chainId = deploy.parentId ?? "";

    await waitForStatus(harness, chainId, "failed");
    const queue = resultText(await harness.call("bg_status", { id: chainId }));
    expect(queue).toContain("failed");
    expect(queue).toContain("skipped");
    expect(queue).toContain(`parent ${chainId} did not succeed`);

    const skipped = await status(harness, deploy.id);
    expect(skipped.status).toBe("skipped");
    expect(skipped.error).toContain(`parent ${chainId} did not succeed`);
    expect(skipped.error).toContain(build.id);
  });

  it("stops the running step and marks the steps behind it stopped", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const log = join(dir.path, "steps.log");
    const command = await writeScript(dir.path, "step.js", STEP_SCRIPT);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-chain-stop" });

    const long = await run(harness, {
      name: "long",
      command,
      env: { STEP_LOG: log, STEP_NAME: "long", STEP_DELAY: "30000" },
    });
    const behind = await run(harness, {
      name: "behind",
      command,
      after: long.id,
      env: { STEP_LOG: log, STEP_NAME: "behind" },
    });
    const chainId = behind.parentId ?? "";

    const killed = await harness.call("bg_kill", { id: chainId });
    const text = resultText(killed);
    expect(text).toContain(`Stopped chain ${chainId}`);
    expect(text).toContain("killed");
    const queue = await status(harness, chainId);
    expect(queue.status).toBe("killed");
    expect((await status(harness, long.id)).status).toBe("killed");
    expect((await status(harness, behind.id)).status).toBe("stopped");
    // Stopping a queue that already ended answers instead of failing.
    const again = resultText(await harness.call("bg_kill", { id: chainId }));
    expect(again).toContain("already finished");
  });

  it("refuses to queue behind anything but a process task, naming the allowed kind", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "step.js", STEP_SCRIPT);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-chain-refuse" });

    const loop = (await harness.call("loop_create", { schedule: "1h", prompt: "keep going" }))
      .details as { id: string };
    const refused = resultText(
      await harness.call("bg_run", { command, after: loop.id, name: "never" }),
    );
    expect(refused).toContain("Only process tasks can be queued");
    expect(refused).toContain("llm-loop");
    expect(refused).toContain("The task was not started.");

    const missing = resultText(await harness.call("bg_run", { command, after: "bg00000" }));
    expect(missing).toContain("No background task with id bg00000.");
    // Neither refusal left a queue or a step behind.
    const listed = (await harness.call("bg_status", {})).details as { tasks: TaskDetails[] };
    expect(listed.tasks).toHaveLength(0);
  });

  it("sends output and wait questions about a chain to its steps", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const log = join(dir.path, "steps.log");
    const command = await writeScript(dir.path, "step.js", STEP_SCRIPT);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-chain-output" });

    const first = await run(harness, {
      name: "one",
      command,
      env: { STEP_LOG: log, STEP_NAME: "one", STEP_DELAY: "400" },
    });
    const second = await run(harness, {
      name: "two",
      command,
      after: first.id,
      env: { STEP_LOG: log, STEP_NAME: "two" },
    });
    const chainId = second.parentId ?? "";

    // A chain writes nothing itself, so the answer points at the step that does.
    const logs = resultText(await harness.call("bg_logs", { id: chainId }));
    expect(logs).toContain(`Task ${chainId} is a chain`);
    expect(logs).toContain(first.id);
    const wait = resultText(await harness.call("bg_wait", { id: chainId, timeoutSeconds: 1 }));
    expect(wait).toContain(`Task ${chainId} is a chain`);
    // The step's own output is still reachable by its own id.
    await waitForStatus(harness, chainId, "completed");
    expect(resultText(await harness.call("bg_logs", { id: second.id }))).toContain("start two");
  });
});
