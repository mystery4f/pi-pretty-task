/**
 * Restart seam: what a session sees after the extension that wrote its tasks is
 * gone. Every harness is one extension instance, so loading a second harness
 * against the same working directory and session id is exactly a restart.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { sessionTaskDirectory, taskRecordPath } from "../src/tasks/base/runtime-state.js";
import type { Task } from "../src/tasks/base/task.js";
import { TaskStore } from "../src/tasks/base/task-store.js";
import { createHarness, type Harness, resultText } from "./support/extension-harness.js";
import { killTree, makeTempDir, waitFor, writeScript } from "./support/processes.js";

interface TaskDetails {
  id: string;
  name: string;
  kind: string;
  status: string;
  pid?: number;
  outputBytes: number;
  outputPath: string;
  exitCode?: number | null;
}

const cleanup: Array<() => Promise<void>> = [];
const spawned: number[] = [];

afterEach(async () => {
  while (spawned.length > 0) await killTree(spawned.pop());
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function tempDirectory(): Promise<string> {
  const dir = await makeTempDir();
  cleanup.push(dir.dispose);
  return dir.path;
}

function trackPid(details: TaskDetails): number {
  const { pid } = details;
  if (pid === undefined) throw new Error("bg_run returned no pid");
  spawned.push(pid);
  return pid;
}

async function status(harness: Harness, id: string): Promise<TaskDetails> {
  const result = await harness.call("bg_status", { id });
  return result.details as TaskDetails;
}

async function waitForStatus(harness: Harness, id: string, wanted: string): Promise<TaskDetails> {
  let latest = await status(harness, id);
  await waitFor(`task ${id} to reach ${wanted}`, async () => {
    latest = await status(harness, id);
    return latest.status === wanted;
  });
  return latest;
}

/**
 * The in-memory status flips before the record lands: a real restart reads the
 * file, so waiting on the store alone would race the writer.
 */
async function waitForRecorded(
  cwd: string,
  sessionId: string,
  id: string,
  wanted: string,
): Promise<void> {
  const path = taskRecordPath(sessionTaskDirectory(cwd, sessionId));
  await waitFor(`task ${id} to be recorded as ${wanted}`, async () => {
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as { tasks?: Task[] };
      return record.tasks?.some((task) => task.id === id && task.status === wanted) === true;
    } catch {
      return false;
    }
  });
}

describe("history across a restart", () => {
  it("lists a finished task with the same name, id, kind and final output", async () => {
    const cwd = await tempDirectory();
    const command = await writeScript(
      cwd,
      "writer.js",
      "console.log('line one');\nconsole.log('line two');\n",
    );
    const turn = { cwd, sessionId: "session-restart" };
    const before = createHarness(turn);
    const started = (await before.call("bg_run", { name: "regression run", command }))
      .details as TaskDetails;
    trackPid(started);
    const finished = await waitForStatus(before, started.id, "completed");
    await waitForRecorded(turn.cwd, turn.sessionId, finished.id, "completed");

    const after = createHarness(turn);

    const listed = resultText(await after.call("bg_status", {}));
    expect(listed).toContain(finished.id);
    expect(listed).toContain("regression run");

    const restored = await status(after, finished.id);
    expect(restored).toMatchObject({
      id: finished.id,
      name: "regression run",
      kind: "process",
      status: "completed",
      exitCode: 0,
    });

    const logs = resultText(await after.call("bg_logs", { id: finished.id }));
    expect(logs).toContain("line one");
    expect(logs).toContain("line two");
  });

  it("keeps the history of different sessions apart", async () => {
    const cwd = await tempDirectory();
    const command = await writeScript(cwd, "sleeper.js", "setTimeout(() => {}, 30000);\n");
    const first = createHarness({ cwd, sessionId: "session-left" });
    const second = createHarness({ cwd, sessionId: "session-right" });
    const left = (await first.call("bg_run", { name: "left task", command }))
      .details as TaskDetails;
    trackPid(left);
    const right = (await second.call("bg_run", { name: "right task", command }))
      .details as TaskDetails;
    trackPid(right);

    const restartedLeft = createHarness({ cwd, sessionId: "session-left" });
    const restartedRight = createHarness({ cwd, sessionId: "session-right" });

    const leftIds = (await restartedLeft.call("bg_status", {})).details as {
      tasks: TaskDetails[];
    };
    const rightIds = (await restartedRight.call("bg_status", {})).details as {
      tasks: TaskDetails[];
    };

    expect(leftIds.tasks.map((task) => task.name)).toEqual(["left task"]);
    expect(rightIds.tasks.map((task) => task.name)).toEqual(["right task"]);
  });
});

describe("recovery after a crash", () => {
  it("marks a leftover running task interrupted and leaves its process alone", async () => {
    const cwd = await tempDirectory();
    const command = await writeScript(
      cwd,
      "sleeper.js",
      "console.log('still alive');\nsetTimeout(() => {}, 60000);\n",
    );
    const turn = { cwd, sessionId: "session-crash" };
    const before = createHarness(turn);
    const started = (await before.call("bg_run", { name: "long job", command }))
      .details as TaskDetails;
    const pid = trackPid(started);
    await waitFor("the task to write its first line", async () =>
      resultText(await before.call("bg_logs", { id: started.id })).includes("still alive"),
    );

    const after = createHarness(turn);

    const restored = await status(after, started.id);
    expect(restored.status).toBe("interrupted");
    // No pid is carried over: a reused pid must never be mistaken for this task.
    expect(restored.pid).toBeUndefined();
    expect(restored.outputBytes).toBeGreaterThan(0);

    // Startup touched the record and nothing else: the process the earlier
    // instance spawned is still alive.
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(resultText(await after.call("bg_logs", { id: started.id }))).toContain("still alive");
  });

  it("falls back to the previous generation when the current record file is corrupt", async () => {
    const cwd = await tempDirectory();
    const command = await writeScript(cwd, "writer.js", "console.log('final output');\n");
    const turn = { cwd, sessionId: "session-corrupt" };
    const before = createHarness(turn);
    const started = (await before.call("bg_run", { name: "build", command }))
      .details as TaskDetails;
    trackPid(started);
    await waitForStatus(before, started.id, "completed");

    // Starting and finishing wrote two generations, so a damaged current file
    // still has the one written by bg_run behind it. The store writes behind the
    // in-memory status, so wait for the finished generation to land first — a
    // clobber that races the store's own rename can rotate the damage into .prev
    // and leave nothing to fall back to.
    const recordPath = taskRecordPath(sessionTaskDirectory(cwd, turn.sessionId));
    await waitFor("the finished generation to reach disk", async () => {
      const text = await readFile(recordPath, "utf8").catch(() => "");
      return text.includes('"status": "completed"');
    });
    await writeFile(recordPath, '{"version":1,"tasks":[', "utf8");

    const after = createHarness(turn);
    const restored = await status(after, started.id);
    expect(restored).toMatchObject({ id: started.id, name: "build", kind: "process" });
    expect(resultText(await after.call("bg_logs", { id: started.id }))).toContain("final output");
  });

  it("keeps every task when two updates arrive back to back", async () => {
    const cwd = await tempDirectory();
    const command = await writeScript(cwd, "sleeper.js", "setTimeout(() => {}, 30000);\n");
    const turn = { cwd, sessionId: "session-race" };
    const before = createHarness(turn);
    const results = await Promise.all([
      before.call("bg_run", { name: "first", command }),
      before.call("bg_run", { name: "second", command }),
    ]);
    for (const result of results) trackPid(result.details as TaskDetails);

    const after = createHarness(turn);
    const listed = (await after.call("bg_status", {})).details as { tasks: TaskDetails[] };

    expect(listed.tasks.map((task) => task.name).sort()).toEqual(["first", "second"]);
  });

  it("keeps a loop record when a process task updates the same session", async () => {
    const cwd = await tempDirectory();
    const turn = { cwd, sessionId: "session-mixed" };
    const directory = sessionTaskDirectory(cwd, turn.sessionId);
    await mkdir(directory, { recursive: true });
    // An llm loop record in its arm's shape, plus a field this version does not
    // know, so the save path is proven to preserve both kinds and unknown data.
    const loop = {
      id: "lp0001",
      kind: "llm-loop",
      name: "nightly review",
      status: "completed",
      createdAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      schedule: "15m",
      prompt: "review the diff",
      fires: 4,
      nextFireAt: 1_700_000_900_000,
      intervalMs: 900_000,
    } as unknown as Task;
    await new TaskStore(directory).save([loop]);

    const harness = createHarness(turn);
    const command = await writeScript(cwd, "writer.js", "console.log('mixed');\n");
    const started = (await harness.call("bg_run", { name: "build", command }))
      .details as TaskDetails;
    trackPid(started);
    await waitForStatus(harness, started.id, "completed");

    const records = await new TaskStore(directory).load();
    expect(records.map((record) => record.kind).sort()).toEqual(["llm-loop", "process"]);
    const restoredLoop = records.find((record) => record.id === "lp0001");
    expect(restoredLoop).toMatchObject({ name: "nightly review", status: "completed" });
    // Unknown fields round-trip untouched: the schema defends what it knows and
    // preserves what it does not.
    expect((restoredLoop as unknown as { intervalMs: number }).intervalMs).toBe(900_000);
  });
});
