/**
 * The chain store, as the process store reports into it: a queue of steps that run
 * one at a time, share the session's records with everything else, and read every
 * outcome from the step's own record (ADR-0013, ADR-0014).
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskScope } from "../src/tasks/base/runtime-state.js";
import { TaskSessions } from "../src/tasks/base/task-sessions.js";
import { ChainTasks, type ChainTaskView } from "../src/tasks/chain/chain-tasks.js";
import { ProcessTasks, type ProcessTaskView } from "../src/tasks/process/process-tasks.js";
import { killTree, makeTempDir, waitFor, writeScript } from "./support/processes.js";

const cleanup: Array<() => Promise<void>> = [];
const spawned: number[] = [];

afterEach(async () => {
  while (spawned.length > 0) await killTree(spawned.pop());
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** The stores as the extension wires them: a step's end advances its chain. */
function makeStores() {
  const sessions = new TaskSessions();
  const chainEndings: ChainTaskView[] = [];
  const processes = new ProcessTasks({
    sessions,
    onFinish: (view: ProcessTaskView) => {
      if (view.task.pid !== undefined) spawned.push(view.task.pid);
      void chainTasks.advance(view);
    },
  });
  const chainTasks = new ChainTasks({
    sessions,
    processes: () => processes,
    onFinish: (view: ChainTaskView) => chainEndings.push(view),
  });
  return { sessions, processes, chainTasks, chainEndings };
}

/** One step script: it records when it starts and ends, then exits as told. */
const STEP_SCRIPT = [
  'const fs = require("node:fs");',
  "const log = process.env.STEP_LOG;",
  'const name = process.env.STEP_NAME || "step";',
  'fs.appendFileSync(log, "start " + name + "\\n");',
  "setTimeout(() => {",
  '  fs.appendFileSync(log, "end " + name + "\\n");',
  "  process.exit(Number(process.env.STEP_EXIT || 0));",
  "}, Number(process.env.STEP_DELAY || 0));",
  "",
].join("\n");

async function queue(
  stores: ReturnType<typeof makeStores>,
  scope: TaskScope,
  after: string,
  command: string,
  name: string,
  env: Record<string, string>,
): Promise<{ chainId: string; stepId: string }> {
  const queued = await stores.chainTasks.enqueue(scope, after, { command, name, env });
  return { chainId: queued.chain.id, stepId: queued.step.id };
}

describe("chain tasks", () => {
  it("queues a step behind a chain as a waiting record, one queue for one chain", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const log = join(dir.path, "steps.log");
    const command = await writeScript(dir.path, "step.js", STEP_SCRIPT);
    const stores = makeStores();
    const scope = { cwd: dir.path, sessionId: "session-chain-queue" };
    // A running task of no chain: queueing behind it is what gives the queue a row.
    const first = await stores.processes.start({
      ...scope,
      command,
      name: "first",
      env: { STEP_LOG: log, STEP_NAME: "first", STEP_DELAY: "400" },
    });

    const queued = await stores.chainTasks.enqueue(scope, first.id, {
      command,
      name: "second",
      env: { STEP_LOG: log, STEP_NAME: "second" },
    });

    expect(queued.chain.id).toMatch(/^ch-[a-z0-9]{5}$/);
    expect(queued.chain.kind).toBe("chain");
    expect(queued.chain.status).toBe("running");
    // The anchor was adopted as the first step: no chain of one, ever.
    expect(queued.chain.steps).toEqual([first.id, queued.step.id]);
    expect(queued.chain.cursor).toBe(0);
    // The step exists now, waiting, and points back at the queue.
    expect(queued.step.status).toBe("waiting");
    expect(queued.step.parentId).toBe(queued.chain.id);
    expect(queued.step.pid).toBeUndefined();
    // The adopted task is a step now, so it left the processes list with the new one.
    expect(await stores.processes.list(scope)).toHaveLength(0);
    expect((await stores.processes.get(scope, first.id))?.task.parentId).toBe(queued.chain.id);
    // The queue is readable by its own id while the step ahead still runs.
    const appended = await stores.chainTasks.enqueue(scope, queued.chain.id, {
      command,
      name: "third",
      env: { STEP_LOG: log, STEP_NAME: "third" },
    });
    expect(appended.chain.id).toBe(queued.chain.id);
    expect(appended.chain.steps).toHaveLength(3);
    // `bg_status` never calls a waiting step running.
    expect((await stores.processes.get(scope, appended.step.id))?.task.status).toBe("waiting");
  });

  it("runs the steps one at a time, in queue order, each after the one ahead exited 0", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const log = join(dir.path, "steps.log");
    const command = await writeScript(dir.path, "step.js", STEP_SCRIPT);
    const stores = makeStores();
    const scope = { cwd: dir.path, sessionId: "session-chain-order" };
    const first = await stores.processes.start({
      ...scope,
      command,
      name: "one",
      env: { STEP_LOG: log, STEP_NAME: "one", STEP_DELAY: "100" },
    });
    const second = await queue(stores, scope, first.id, command, "two", {
      STEP_LOG: log,
      STEP_NAME: "two",
      STEP_DELAY: "100",
    });
    const third = await queue(stores, scope, second.chainId, command, "three", {
      STEP_LOG: log,
      STEP_NAME: "three",
    });

    const chain = await waitForChain(stores, scope, second.chainId, "completed");

    expect(chain.task.cursor).toBe(3);
    expect(chain.task.error).toBeUndefined();
    expect((await stores.processes.get(scope, third.stepId))?.task.status).toBe("completed");
    // The log is the proof of one-at-a-time: each step ended before the next began.
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "start one",
      "end one",
      "start two",
      "end two",
      "start three",
      "end three",
    ]);
    expect(stores.chainEndings.map((view) => view.task.status)).toEqual(["completed"]);
  });

  it("fails the chain on the first failing step and skips the rest, naming what failed", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const log = join(dir.path, "steps.log");
    const command = await writeScript(dir.path, "step.js", STEP_SCRIPT);
    const stores = makeStores();
    const scope = { cwd: dir.path, sessionId: "session-chain-fail" };
    const first = await stores.processes.start({
      ...scope,
      command,
      name: "build",
      env: { STEP_LOG: log, STEP_NAME: "build", STEP_EXIT: "1" },
    });
    const second = await queue(stores, scope, first.id, command, "deploy", {
      STEP_LOG: log,
      STEP_NAME: "deploy",
    });
    const third = await queue(stores, scope, second.chainId, command, "smoke", {
      STEP_LOG: log,
      STEP_NAME: "smoke",
    });

    const chain = await waitForChain(stores, scope, second.chainId, "failed");

    // The cursor stays on the step that failed: that is where the queue stopped.
    expect(chain.task.cursor).toBe(0);
    expect(chain.task.error).toContain(first.id);
    const skipped = (await stores.processes.get(scope, third.stepId))?.task;
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.endedAt).toBeDefined();
    // A skipped step names the queue and the step that stopped it.
    expect(skipped?.error).toContain(`parent ${second.chainId} did not succeed`);
    expect(skipped?.error).toContain(first.id);
    // Nothing behind the failure ever ran.
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["start build", "end build"]);
    expect(stores.chainEndings.map((view) => view.task.status)).toEqual(["failed"]);
  });

  it("stops the running step and marks the steps behind it stopped, not skipped", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const log = join(dir.path, "steps.log");
    const command = await writeScript(dir.path, "step.js", STEP_SCRIPT);
    const stores = makeStores();
    const scope = { cwd: dir.path, sessionId: "session-chain-stop" };
    const first = await stores.processes.start({
      ...scope,
      command,
      name: "long",
      env: {
        STEP_LOG: log,
        STEP_NAME: "long",
        STEP_DELAY: "30000",
      },
    });
    const second = await queue(stores, scope, first.id, command, "next", {
      STEP_LOG: log,
      STEP_NAME: "next",
    });
    const third = await queue(stores, scope, second.chainId, command, "last", {
      STEP_LOG: log,
      STEP_NAME: "last",
    });

    const result = await stores.chainTasks.stop(scope, second.chainId);

    expect(result?.outcome).toBe("stopped");
    expect(result?.view.task.status).toBe("killed");
    expect(result?.view.task.killReason).toBe("user");
    // The step that was running is a killed process, not a stopped one: it existed.
    expect(result?.step?.task.id).toBe(first.id);
    expect(result?.step?.task.status).toBe("killed");
    // The queue behind it never ran, and says so without claiming a failure.
    const waiting = (await stores.processes.get(scope, second.stepId))?.task;
    expect(waiting?.status).toBe("stopped");
    expect(waiting?.error).toBeUndefined();
    expect((await stores.processes.get(scope, third.stepId))?.task.status).toBe("stopped");
    expect((await readFile(log, "utf8")).trim()).toBe("start long");
    // A second stop is answered with the record instead of stopping anything again.
    const again = await stores.chainTasks.stop(scope, second.chainId);
    expect(again?.outcome).toBe("already-finished");
  });

  it("survives a restart with the same queue order, cursor and final status", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const log = join(dir.path, "steps.log");
    const command = await writeScript(dir.path, "step.js", STEP_SCRIPT);
    const scope = { cwd: dir.path, sessionId: "session-chain-restart" };
    const before = makeStores();
    const first = await before.processes.start({
      ...scope,
      command,
      name: "one",
      env: { STEP_LOG: log, STEP_NAME: "one" },
    });
    const second = await queue(before, scope, first.id, command, "two", {
      STEP_LOG: log,
      STEP_NAME: "two",
    });
    await queue(before, scope, second.chainId, command, "three", {
      STEP_LOG: log,
      STEP_NAME: "three",
    });
    const ended = await waitForChain(before, scope, second.chainId, "completed");
    // The status flips in memory before the write lands; the ending notice comes
    // after it, so waiting for the notice is waiting for the chain to be on disk.
    await waitFor("the chain's end to reach the disk", () =>
      before.chainEndings.some(
        (view) => view.task.id === second.chainId && view.task.status === "completed",
      ),
    );

    // A restart is a set of fresh stores over the same state directory.
    const after = makeStores();
    const reloaded = await after.chainTasks.get(scope, second.chainId);

    expect(reloaded?.task.steps).toEqual(ended.task.steps);
    expect(reloaded?.task.cursor).toBe(3);
    expect(reloaded?.task.status).toBe("completed");
    expect(reloaded?.task.createdAt).toBe(ended.task.createdAt);
    expect(reloaded?.task.endedAt).toBe(ended.task.endedAt);
    expect(await after.chainTasks.list(scope)).toHaveLength(1);
  });

  it("refuses to queue anything but a process task, naming the allowed kind", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const stores = makeStores();
    const scope = { cwd: dir.path, sessionId: "session-chain-refuse" };
    const command = await writeScript(dir.path, "step.js", STEP_SCRIPT);
    // An llm loop of the session, recorded by hand: this seam is the chain store.
    const session = await stores.sessions.session(scope);
    const now = Date.now();
    session.tasks.set("lp00001", {
      id: "lp00001",
      kind: "llm-loop",
      name: "nightly",
      status: "running",
      createdAt: now,
      updatedAt: now,
      schedule: "every 1h",
      prompt: "keep going",
      fires: 0,
      iterations: [],
    });

    await expect(
      stores.chainTasks.enqueue(scope, "lp00001", { command, name: "never" }),
    ).rejects.toThrow("Only process tasks can be queued: lp00001 is a llm-loop.");
    await expect(
      stores.chainTasks.enqueue(scope, "ch00000", { command, name: "never" }),
    ).rejects.toThrow("No background task with id ch00000.");
    // Nothing was created by a refused queue: no chain, no waiting step.
    expect(await stores.chainTasks.list(scope)).toHaveLength(0);
    expect(await stores.processes.list(scope)).toHaveLength(0);
  });

  it("keeps a completed chain extendable and refuses to revive one that failed", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const log = join(dir.path, "steps.log");
    const command = await writeScript(dir.path, "step.js", STEP_SCRIPT);
    const stores = makeStores();
    const scope = { cwd: dir.path, sessionId: "session-chain-extend" };
    const first = await stores.processes.start({
      ...scope,
      command,
      name: "one",
      env: { STEP_LOG: log, STEP_NAME: "one" },
    });
    const second = await queue(stores, scope, first.id, command, "two", {
      STEP_LOG: log,
      STEP_NAME: "two",
    });
    await waitForChain(stores, scope, second.chainId, "completed");

    // A successful queue can take one more step: the cursor reaches the new end.
    const third = await queue(stores, scope, second.chainId, command, "three", {
      STEP_LOG: log,
      STEP_NAME: "three",
    });
    const extended = await waitForChain(stores, scope, second.chainId, "completed");
    expect(extended.task.cursor).toBe(3);
    expect((await stores.processes.get(scope, third.stepId))?.task.status).toBe("completed");

    // A failed chain may not be revived: its skipped steps are history.
    const failing = await stores.processes.start({
      ...scope,
      command,
      name: "bad",
      env: { STEP_LOG: log, STEP_NAME: "bad", STEP_EXIT: "3" },
    });
    const failed = await queue(stores, scope, failing.id, command, "after bad", {
      STEP_LOG: log,
      STEP_NAME: "after bad",
    });
    await waitForChain(stores, scope, failed.chainId, "failed");
    await expect(
      stores.chainTasks.enqueue(scope, failed.chainId, { command, name: "never" }),
    ).rejects.toThrow(/already ended failed/);
  });
});

/** Read a chain until it reaches `status`, then return it. */
async function waitForChain(
  stores: ReturnType<typeof makeStores>,
  scope: TaskScope,
  id: string,
  status: string,
): Promise<ChainTaskView> {
  await waitFor(`the chain ${id} to be ${status}`, async () => {
    const view = await stores.chainTasks.get(scope, id);
    return view?.task.status === status;
  });
  const view = await stores.chainTasks.get(scope, id);
  if (view === undefined) throw new Error(`chain ${id} disappeared`);
  return view;
}
