/**
 * State-file seam: one record file per session, holding both kinds under one
 * schema, written atomically and read with a previous-generation fallback.
 * Every test uses a real temporary directory; the filesystem is never mocked.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { previousTaskRecordPath, taskRecordPath } from "../src/tasks/base/runtime-state.js";
import type { LoopTask, ProcessTask } from "../src/tasks/base/task.js";
import { TaskStore } from "../src/tasks/base/task-store.js";
import { makeTempDir } from "./support/processes.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function stateDirectory(): Promise<string> {
  const dir = await makeTempDir();
  cleanup.push(dir.dispose);
  return dir.path;
}

function processTask(overrides: Partial<ProcessTask> = {}): ProcessTask {
  return {
    id: "ab12cd",
    kind: "process",
    name: "build",
    status: "completed",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    command: "npm run build",
    cwd: "/work/project",
    outputPath: "/state/ab12cd.output",
    exitCode: 0,
    outputBytes: 42,
    ...overrides,
  };
}

/** A loop arm record, plus one field this version does not know, to prove it round-trips. */
function loopRecord(overrides: Partial<LoopTask> = {}): LoopTask {
  return {
    id: "lp12cd",
    kind: "loop",
    name: "nightly review",
    status: "completed",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    endedAt: 1_700_000_002_000,
    schedule: "5m",
    prompt: "review the diff",
    maxFires: 10,
    fires: 3,
    nextFireAt: 1_700_000_300_000,
    intervalMs: 300_000,
    iterations: [],
    ...overrides,
  } as LoopTask;
}

describe("the task record file", () => {
  it("holds process and loop records side by side under one schema", async () => {
    const directory = await stateDirectory();
    const records = [processTask(), loopRecord()];

    await new TaskStore(directory).save(records);
    const loaded = await new TaskStore(directory).load();

    expect(loaded).toEqual(records);
    expect(taskRecordPath(directory)).toBe(join(directory, "tasks.json"));
    expect(previousTaskRecordPath(directory)).toBe(join(directory, "tasks.json.prev"));
  });

  it("reads a version 1 record without an update time as created, then writes version 2", async () => {
    const directory = await stateDirectory();
    const oldProcess: Record<string, unknown> = { ...processTask({ id: "ab12cd" }) };
    delete oldProcess.updatedAt;
    const oldLoop: Record<string, unknown> = { ...loopRecord({ id: "lp12cd" }) };
    delete oldLoop.updatedAt;
    await writeFile(
      taskRecordPath(directory),
      JSON.stringify({ version: 1, tasks: [oldProcess, oldLoop] }),
      "utf8",
    );

    const loaded = await new TaskStore(directory).load();

    // The old file has no recency, so the record's own creation is the closest
    // honest answer; the six-character id is a reference and is left alone.
    expect(loaded).toHaveLength(2);
    for (const record of loaded) {
      expect(record.updatedAt).toBe(record.createdAt);
    }
    expect(loaded[0]?.id).toBe("ab12cd");

    await new TaskStore(directory).save(loaded);

    const saved = JSON.parse(await readFile(taskRecordPath(directory), "utf8")) as {
      version: number;
    };
    expect(saved.version).toBe(2);
  });

  it("has no records before the first write, and never throws for that", async () => {
    const directory = await stateDirectory();
    expect(await new TaskStore(directory).load()).toEqual([]);
  });

  it("falls back to the previous generation when the current file is corrupt", async () => {
    const directory = await stateDirectory();
    const first = processTask({ id: "aaaaaa", name: "first" });
    const second = processTask({ id: "bbbbbb", name: "second" });

    const store = new TaskStore(directory);
    await store.save([first]);
    await store.save([first, second]);
    await writeFile(taskRecordPath(directory), '{"version":1,"tasks":[', "utf8");

    const loaded = await new TaskStore(directory).load();
    expect(loaded).toEqual([first]);
  });

  it("falls back when the current file is valid JSON but not a record set", async () => {
    const directory = await stateDirectory();
    const first = processTask({ id: "aaaaaa", name: "first" });
    const second = processTask({ id: "bbbbbb", name: "second" });

    const store = new TaskStore(directory);
    await store.save([first]);
    await store.save([first, second]);
    await writeFile(taskRecordPath(directory), '{"version":1,"tasks":[{"id":7}]}', "utf8");

    expect(await new TaskStore(directory).load()).toEqual([first]);
  });

  it("has no history when both generations are unusable, instead of throwing", async () => {
    const directory = await stateDirectory();
    const store = new TaskStore(directory);
    await store.save([processTask()]);
    await store.save([processTask(), processTask({ id: "bbbbbb" })]);
    await writeFile(taskRecordPath(directory), "not json at all", "utf8");
    await writeFile(previousTaskRecordPath(directory), "{oops", "utf8");

    expect(await new TaskStore(directory).load()).toEqual([]);
  });

  it("stays readable through two rapid successive updates", async () => {
    const directory = await stateDirectory();
    const first = processTask({ id: "aaaaaa", name: "first" });
    const second = processTask({ id: "bbbbbb", name: "second" });
    const store = new TaskStore(directory);

    await Promise.all([store.save([first]), store.save([first, second])]);

    expect(await new TaskStore(directory).load()).toEqual([first, second]);
    // Both generations are complete documents: even now, the earlier copy is
    // there to fall back to.
    await writeFile(taskRecordPath(directory), '{"version":1,"tasks":[', "utf8");
    expect(await new TaskStore(directory).load()).toEqual([first]);
  });

  it("marks a record left running as interrupted, with no pid to adopt", async () => {
    const directory = await stateDirectory();
    const leftover = processTask({
      id: "cccccc",
      name: "left behind",
      status: "running",
      pid: 4242,
      outputBytes: 12,
    });
    await new TaskStore(directory).save([leftover]);

    const loaded = await new TaskStore(directory, { now: () => 1_700_000_009_000 }).load();

    expect(loaded).toHaveLength(1);
    const record = loaded[0] as ProcessTask;
    expect(record.status).toBe("interrupted");
    expect(record.endedAt).toBe(1_700_000_009_000);
    expect(record.pid).toBeUndefined();
    expect(record.name).toBe("left behind");
    expect(record.outputBytes).toBe(12);
  });

  it("keeps a running loop schedule across a restart", async () => {
    const directory = await stateDirectory();
    const loop = loopRecord({ status: "running", fires: 2 });
    delete loop.endedAt;
    await new TaskStore(directory).save([loop]);

    const loaded = await new TaskStore(directory, { now: () => 1_700_000_009_000 }).load();

    // A loop owns no process, so starting the store does not end it.
    expect(loaded).toEqual([loop]);
  });

  it("interrupts the iteration a restart left running, and the calls inside it", async () => {
    const directory = await stateDirectory();
    const loop = loopRecord({
      status: "running",
      iterations: [
        {
          fire: 2,
          startedAt: 1_700_000_000_100,
          status: "running",
          droppedCalls: 0,
          calls: [
            {
              id: "call-a",
              tool: "bash",
              subject: "npm test",
              startedAt: 1_700_000_000_200,
              status: "running",
            },
          ],
        },
      ],
    });
    delete loop.endedAt;
    await new TaskStore(directory).save([loop]);

    const loaded = await new TaskStore(directory, { now: () => 1_700_000_009_000 }).load();

    // The loop itself survives a restart; the turn it woke cannot, because no
    // turn outlives the process that was running it.
    expect(loaded).toHaveLength(1);
    const record = loaded[0];
    if (record?.kind !== "loop") throw new Error("the loop record did not load");
    expect(record.status).toBe("running");
    const [iteration] = record.iterations;
    expect(iteration).toMatchObject({ status: "interrupted", endedAt: 1_700_000_009_000 });
    expect(iteration?.calls[0]).toMatchObject({
      status: "interrupted",
      endedAt: 1_700_000_009_000,
      durationMs: 8_800,
    });
  });
});
