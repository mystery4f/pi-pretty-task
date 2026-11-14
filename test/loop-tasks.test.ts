/**
 * Behaviour of the loop store: creating schedules, pumping a fake clock, and
 * keeping loop records alive across a reload.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { afterEach, describe, expect, it } from "vitest";

import { sessionTaskDirectory } from "../src/tasks/base/runtime-state.js";
import { TaskSessions } from "../src/tasks/base/task-sessions.js";
import { TaskStore } from "../src/tasks/base/task-store.js";
import { type LoopFire, LoopTasks, MAX_LOOPS } from "../src/tasks/loop/loop-tasks.js";
import { makeTempDir } from "./support/processes.js";

const directories: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => directory.dispose()));
});

async function setup() {
  const directory = await makeTempDir();
  directories.push(directory);
  let now = Date.UTC(2026, 0, 1, 9, 0, 0);
  const sessions = new TaskSessions({ now: () => now });
  const fires: LoopFire[] = [];
  const loops = new LoopTasks({
    sessions,
    now: () => now,
    onFire: (fire) => {
      fires.push(fire);
    },
  });
  const scope = { cwd: directory.path, sessionId: "session-1" };
  return {
    directory,
    scope,
    loops,
    sessions,
    fires,
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
    async reload() {
      const store = new TaskStore(sessionTaskDirectory(scope.cwd, scope.sessionId));
      return store.load();
    },
  };
}

describe("LoopTasks", () => {
  it("creates a loop, persists it, and lists it with its schedule", async () => {
    const task = await setup();
    const { loops, scope } = task;

    const created = await loops.create({
      ...scope,
      schedule: "10m",
      prompt: "review the diff",
      name: "nightly review",
      maxFires: 5,
    });

    expect(created.task).toMatchObject({
      kind: "llm-loop",
      name: "nightly review",
      schedule: "10m",
      prompt: "review the diff",
      maxFires: 5,
      fires: 0,
      status: "running",
    });
    expect(created.task.id).toMatch(/^lp-[a-z0-9]{5}$/);
    expect(created.task.nextFireAt).toBe(task.now + 600_000);
    expect(created.untilNextFireMs).toBe(600_000);

    const listed = await loops.list(scope);
    expect(listed.map((view) => view.task.id)).toEqual([created.task.id]);

    const records = await task.reload();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: created.task.id,
      kind: "llm-loop",
      schedule: "10m",
      prompt: "review the diff",
      fires: 0,
      nextFireAt: created.task.nextFireAt,
    });
  });

  it("derives a name from the prompt when none is given", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "1h",
      prompt: "  Review   the diff\nand report  ",
    });

    expect(created.task.name).toBe("Review the diff");
  });

  it("rejects an invalid schedule with an example", async () => {
    const task = await setup();
    await expect(
      task.loops.create({ ...task.scope, schedule: "10 minutes", prompt: "keep going" }),
    ).rejects.toThrow(/Invalid schedule "10 minutes": .*30s, 10m or 2h/);
  });

  it("rejects an empty prompt, a bad maxFires, and a bad expiresIn", async () => {
    const task = await setup();
    await expect(
      task.loops.create({ ...task.scope, schedule: "10m", prompt: "   " }),
    ).rejects.toThrow(/prompt/i);
    await expect(
      task.loops.create({ ...task.scope, schedule: "10m", prompt: "go", maxFires: 0 }),
    ).rejects.toThrow(/maxFires/);
    await expect(
      task.loops.create({ ...task.scope, schedule: "10m", prompt: "go", maxFires: 1.5 }),
    ).rejects.toThrow(/maxFires/);
    await expect(
      task.loops.create({ ...task.scope, schedule: "10m", prompt: "go", expiresIn: "2d" }),
    ).rejects.toThrow(/expiresIn "2d": .*30s, 10m or 2h/);
  });

  it("fires five times in about a minute on a ten-second interval", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });
    const firstDue = created.task.nextFireAt ?? 0;
    expect(firstDue).toBe(task.now + 10_000);

    task.advance(9_999);
    expect(await task.loops.pump(task.now)).toEqual([]);

    for (let fire = 1; fire <= 5; fire += 1) {
      task.advance(1);
      const fired = await task.loops.pump(task.now);
      expect(fired).toHaveLength(1);
      expect(fired[0]?.fire).toBe(fire);
      expect(fired[0]?.task.id).toBe(created.task.id);
      task.advance(9_999);
    }

    expect(task.fires).toHaveLength(5);
    expect(task.fires.map((fire) => fire.fire)).toEqual([1, 2, 3, 4, 5]);

    const view = await task.loops.get(task.scope, created.task.id);
    expect(view?.task.fires).toBe(5);
    expect(view?.task.lastFireAt).toBe(firstDue + 4 * 10_000);
    expect(view?.task.nextFireAt).toBe((view?.task.lastFireAt ?? 0) + 10_000);
    expect(view?.task.status).toBe("running");
  });

  it("coalesces missed fires into one wake per pump", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });

    task.advance(35_000);
    const fired = await task.loops.pump(task.now);

    expect(fired).toHaveLength(1);
    expect(fired[0]?.fire).toBe(1);

    const view = await task.loops.get(task.scope, created.task.id);
    expect(view?.task.fires).toBe(1);
    expect(view?.task.nextFireAt).toBe(task.now + 10_000);
    expect(await task.loops.pump(task.now)).toEqual([]);
  });

  it("moves updatedAt when a loop fires", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });
    expect(created.task.updatedAt).toBe(created.task.createdAt);

    task.advance(10_000);
    expect(await task.loops.pump(task.now)).toHaveLength(1);

    const view = await task.loops.get(task.scope, created.task.id);
    expect(view?.task.updatedAt).toBe(task.now);
    expect(view?.task.updatedAt).toBeGreaterThan(view?.task.createdAt ?? 0);
  });

  it("completes after the maximum number of fires", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "1m",
      prompt: "keep going",
      maxFires: 2,
    });

    task.advance(60_000);
    expect(await task.loops.pump(task.now)).toHaveLength(1);

    task.advance(60_000);
    const lastFire = await task.loops.pump(task.now);
    expect(lastFire).toHaveLength(1);

    task.advance(60_000);
    expect(await task.loops.pump(task.now)).toEqual([]);

    const view = await task.loops.get(task.scope, created.task.id);
    expect(view?.task).toMatchObject({
      status: "completed",
      fires: 2,
      endedAt: task.now - 60_000,
    });
    expect(view?.task.nextFireAt).toBeUndefined();
  });

  it("serializes concurrent pumps so one due loop fires once", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });
    task.advance(10_000);

    // A timer tick and a turn end can ask at the same instant. Both read the
    // same `nextFireAt` unless the store serializes them.
    const [first, second] = await Promise.all([
      task.loops.pump(task.now),
      task.loops.pump(task.now),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(task.fires).toHaveLength(1);
    const view = await task.loops.get(task.scope, created.task.id);
    expect(view?.task.fires).toBe(1);
  });

  it("completes at the expiry instead of firing again", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
      expiresIn: "25s",
    });
    expect(created.task.expiresAt).toBe(task.now + 25_000);

    task.advance(10_000);
    expect(await task.loops.pump(task.now)).toHaveLength(1);
    task.advance(10_000);
    expect(await task.loops.pump(task.now)).toHaveLength(1);
    task.advance(10_000);
    expect(await task.loops.pump(task.now)).toEqual([]);

    const view = await task.loops.get(task.scope, created.task.id);
    expect(view?.task).toMatchObject({ status: "completed", fires: 2, endedAt: task.now });
  });

  it("pauses, resumes, completes, and deletes a loop", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });

    const paused = await task.loops.update({ ...task.scope, id: created.task.id, action: "pause" });
    expect(paused?.outcome).toBe("paused");
    expect(paused?.view.task.status).toBe("paused");
    expect(paused?.view.task.nextFireAt).toBeUndefined();
    task.advance(30_000);
    expect(await task.loops.pump(task.now)).toEqual([]);

    const resumed = await task.loops.update({
      ...task.scope,
      id: created.task.id,
      action: "resume",
    });
    expect(resumed?.outcome).toBe("resumed");
    expect(resumed?.view.task.status).toBe("running");
    expect(resumed?.view.task.nextFireAt).toBe(task.now + 10_000);

    task.advance(10_000);
    expect(await task.loops.pump(task.now)).toHaveLength(1);

    const completed = await task.loops.update({
      ...task.scope,
      id: created.task.id,
      action: "complete",
    });
    expect(completed?.outcome).toBe("completed");
    expect(completed?.view.task.status).toBe("completed");
    expect(completed?.view.task.endedAt).toBe(task.now);
    task.advance(10_000);
    expect(await task.loops.pump(task.now)).toEqual([]);

    const second = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "second",
    });
    expect(await task.loops.delete(task.scope, second.task.id)).toBeDefined();
    expect(await task.loops.get(task.scope, second.task.id)).toBeUndefined();
    expect(await task.loops.list(task.scope)).toHaveLength(1);
  });

  it("retunes a running loop from the update moment and keeps its record", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });

    task.advance(10_000);
    expect(await task.loops.pump(task.now)).toHaveLength(1);
    const before = await task.loops.get(task.scope, created.task.id);
    if (before === undefined || before.task.kind !== "llm-loop") {
      throw new Error("the loop record disappeared");
    }
    expect(before.task).toMatchObject({ schedule: "10s", fires: 1, lastFireAt: task.now });

    task.advance(5_000);
    const retuned = await task.loops.update({
      ...task.scope,
      id: created.task.id,
      schedule: "1h",
    });

    expect(retuned?.outcome).toBe("rescheduled");
    const after = retuned?.view.task;
    if (after === undefined || after.kind !== "llm-loop") {
      throw new Error("the loop record disappeared");
    }
    expect(after).toMatchObject({
      id: created.task.id,
      name: before.task.name,
      createdAt: before.task.createdAt,
      schedule: "1h",
      status: "running",
      fires: 1,
      lastFireAt: before.task.lastFireAt,
      nextFireAt: task.now + 3_600_000,
    });
    // Nothing was rebuilt: the iteration history is the same list, no fire orphaned.
    expect(after.iterations).toBe(before.task.iterations);

    // The slot the old 10s schedule had picked is gone; the loop re-arms from here.
    task.advance(10_000);
    expect(await task.loops.pump(task.now)).toEqual([]);

    task.advance(3_600_000 - 10_000);
    const fired = await task.loops.pump(task.now);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.fire).toBe(2);
  });

  it("retunes a paused loop and keeps it paused until resumed", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });

    task.advance(3_000);
    await task.loops.update({ ...task.scope, id: created.task.id, action: "pause" });

    const retuned = await task.loops.update({
      ...task.scope,
      id: created.task.id,
      schedule: "30m",
    });
    expect(retuned?.outcome).toBe("rescheduled");
    expect(retuned?.view.task).toMatchObject({ schedule: "30m", status: "paused", fires: 0 });
    expect(retuned?.view.task.nextFireAt).toBeUndefined();

    task.advance(20_000);
    expect(await task.loops.pump(task.now)).toEqual([]);

    const resumed = await task.loops.update({
      ...task.scope,
      id: created.task.id,
      action: "resume",
    });
    expect(resumed?.outcome).toBe("resumed");
    expect(resumed?.view.task.nextFireAt).toBe(task.now + 1_800_000);

    task.advance(1_800_000);
    expect(await task.loops.pump(task.now)).toHaveLength(1);
  });

  it("refuses an invalid schedule the way loop_create does and keeps the old one firing", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });

    const createMessage = await task.loops
      .create({ ...task.scope, schedule: "10 minutes", prompt: "keep going" })
      .then(
        () => "created",
        (error: Error) => error.message,
      );
    const updateMessage = await task.loops
      .update({ ...task.scope, id: created.task.id, schedule: "10 minutes" })
      .then(
        () => "updated",
        (error: Error) => error.message,
      );
    expect(updateMessage).toBe(createMessage);
    expect(updateMessage).toMatch(/^Invalid schedule "10 minutes": /);

    const unchanged = await task.loops.get(task.scope, created.task.id);
    expect(unchanged?.task).toMatchObject({
      schedule: "10s",
      status: "running",
      nextFireAt: created.task.nextFireAt,
      fires: 0,
    });

    task.advance(10_000);
    expect(await task.loops.pump(task.now)).toHaveLength(1);
  });

  it("fires once per new interval when retuned twice in the same instant", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });

    await task.loops.update({ ...task.scope, id: created.task.id, schedule: "30s" });
    await task.loops.update({ ...task.scope, id: created.task.id, schedule: "1h" });

    const view = await task.loops.get(task.scope, created.task.id);
    expect(view?.task.schedule).toBe("1h");
    expect(view?.task.nextFireAt).toBe(task.now + 3_600_000);

    // The 30s slot the first update armed is gone: only the last schedule counts.
    task.advance(30_000);
    expect(await task.loops.pump(task.now)).toEqual([]);

    task.advance(3_600_000 - 30_000);
    expect(await task.loops.pump(task.now)).toHaveLength(1);
    // The same slot never fires twice.
    expect(await task.loops.pump(task.now)).toEqual([]);
    expect((await task.loops.get(task.scope, created.task.id))?.task.fires).toBe(1);
  });

  it("leaves the schedule and its timing alone when an update carries no schedule", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });

    task.advance(10_000);
    await task.loops.pump(task.now);
    const before = await task.loops.get(task.scope, created.task.id);
    if (before === undefined) throw new Error("the loop record disappeared");

    await task.loops.update({ ...task.scope, id: created.task.id, action: "pause" });
    await task.loops.update({ ...task.scope, id: created.task.id, action: "resume" });

    const after = await task.loops.get(task.scope, created.task.id);
    expect(after?.task).toMatchObject({
      schedule: "10s",
      fires: before.task.fires,
      lastFireAt: before.task.lastFireAt,
      nextFireAt: task.now + 10_000,
    });
  });

  it("applies a retune before the action, so resume with a new schedule is one call", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });

    await task.loops.update({ ...task.scope, id: created.task.id, action: "pause" });
    const retuned = await task.loops.update({
      ...task.scope,
      id: created.task.id,
      action: "resume",
      schedule: "30m",
    });

    expect(retuned?.outcome).toBe("resumed");
    expect(retuned?.view.task).toMatchObject({
      schedule: "30m",
      status: "running",
      nextFireAt: task.now + 1_800_000,
    });
  });

  it("refuses an update that asks for neither a transition nor a retune", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });

    await expect(task.loops.update({ ...task.scope, id: created.task.id })).rejects.toThrow(
      /Give an action or a schedule/,
    );
  });

  it("keeps firing after a reload", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });

    task.advance(10_000);
    expect(await task.loops.pump(task.now)).toHaveLength(1);

    const sessions = new TaskSessions();
    const fires: LoopFire[] = [];
    const revived = new LoopTasks({
      sessions,
      now: () => task.now,
      onFire: (fire) => {
        fires.push(fire);
      },
    });
    await revived.attach(task.scope);

    const view = await revived.get(task.scope, created.task.id);
    expect(view?.task.status).toBe("running");
    expect(view?.task.fires).toBe(1);

    task.advance(10_000);
    const fired = await revived.pump(task.now);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.fire).toBe(2);
    expect(fires).toHaveLength(1);
  });

  it("limits the session to fifty active loops", async () => {
    const task = await setup();
    const created = [];
    for (let index = 0; index < MAX_LOOPS; index += 1) {
      created.push(
        await task.loops.create({ ...task.scope, schedule: "1h", prompt: `loop ${index}` }),
      );
    }

    await expect(
      task.loops.create({ ...task.scope, schedule: "1h", prompt: "one too many" }),
    ).rejects.toThrow(/50 active loop/);

    const first = created[0];
    if (first === undefined) throw new Error("first loop was not created");
    await task.loops.update({ ...task.scope, id: first.task.id, action: "complete" });
    await expect(
      task.loops.create({ ...task.scope, schedule: "1h", prompt: "room again" }),
    ).resolves.toBeDefined();
  });
});
