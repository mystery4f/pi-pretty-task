/**
 * Behaviour of the loop store: creating schedules, pumping a fake clock, and
 * keeping loop records alive across a reload.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { loopPromptPath, sessionTaskDirectory } from "../../src/tasks/base/runtime-state.js";
import type { PromptLoopTask } from "../../src/tasks/base/task.js";
import { TaskSessions } from "../../src/tasks/base/task-sessions.js";
import { TaskStore } from "../../src/tasks/base/task-store.js";
import type { TurnOutcome } from "../../src/tasks/loop/iteration.js";
import { type LoopFire, LoopTasks, MAX_LOOPS } from "../../src/tasks/loop/loop-tasks.js";
import { readPromptPreview } from "../../src/tasks/loop/prompt-file.js";
import { makeTempDir } from "../support/processes.js";

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
  const started: { fire: number; at: number; taskId: string }[] = [];
  const loops = new LoopTasks({
    sessions,
    now: () => now,
    onFire: (fire) => {
      fires.push(fire);
    },
    onCommandFire: async (fire) => {
      const taskId = `bg-fire-${String(started.length + 1)}`;
      started.push({ fire: fire.fire, at: fire.at, taskId });
      return { taskId };
    },
  });
  const scope = { cwd: directory.path, sessionId: "session-1" };
  return {
    directory,
    scope,
    loops,
    sessions,
    fires,
    started,
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

/** Charge a settled turn to its loop, the way `agent_settled` does (ticket #46). */
function settleTurn(
  task: Awaited<ReturnType<typeof setup>>,
  turn: { id: string; fire: number; end: TurnOutcome; error?: string },
): Promise<void> {
  return task.loops.completeTurns(task.scope, [turn]);
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
      kind: "prompt-loop",
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
      kind: "prompt-loop",
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

  it("rejects notify exit codes that cannot carry a signal, and refuses them on a prompt loop", async () => {
    const task = await setup();
    await expect(
      task.loops.create({ ...task.scope, schedule: "10m", command: "true", notifyExitCodes: [0] }),
    ).rejects.toThrow(/notifyExitCodes/);
    await expect(
      task.loops.create({ ...task.scope, schedule: "10m", command: "true", notifyExitCodes: [] }),
    ).rejects.toThrow(/notifyExitCodes/);
    await expect(
      task.loops.create({ ...task.scope, schedule: "10m", prompt: "go", notifyExitCodes: [1] }),
    ).rejects.toThrow(/Invalid notifyExitCodes for a prompt loop/);
  });

  it("realigns a drifted loop onto its schedule with rearm, keeping the expression", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "7m",
      command: "check",
    });
    const id = created.task.id;
    expect(created.task.nextFireAt).toBe(task.now + 7 * 60_000);

    // A failed fire doubles the wait measured from the slot it had picked, so
    // the loop lands between two slots: 09:21 instead of 09:14.
    task.advance(7 * 60_000);
    expect(await task.loops.pump(task.now)).toEqual([]);
    const running = task.started.at(-1);
    expect(running?.fire).toBe(1);
    await task.loops.completeFire({
      parentId: id,
      taskId: running?.taskId ?? "",
      fire: 1,
      status: "failed",
      exitCode: 2,
      outputPath: `${task.directory.path}/m1.log`,
      outputBytes: 0,
      durationMs: 5,
    });
    const drifted = await task.loops.get(task.scope, id);
    expect(drifted?.task.nextFireAt).toBe(task.now + 14 * 60_000);
    expect(drifted?.task.schedule).toBe("7m");

    const realigned = await task.loops.update({ ...task.scope, id, action: "rearm" });
    expect(realigned?.outcome).toBe("rearmed");
    expect(realigned?.view.task.nextFireAt).toBe(task.now + 7 * 60_000);
    expect(realigned?.view.task.schedule).toBe("7m");
    expect(realigned?.view.task.fires).toBe(1);
  });

  it("drops an outstanding signal with clear-signal, and says so when there is none", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10m",
      command: "check",
      notifyExitCodes: [1],
    });
    const id = created.task.id;

    expect((await task.loops.update({ ...task.scope, id, action: "clear-signal" }))?.outcome).toBe(
      "no-signal",
    );

    task.advance(10 * 60_000);
    await task.loops.pump(task.now);
    const running = task.started.at(-1);
    const completed = await task.loops.completeFire({
      parentId: id,
      taskId: running?.taskId ?? "",
      fire: 1,
      status: "failed",
      exitCode: 1,
      outputPath: `${task.directory.path}/signal.log`,
      outputBytes: 12,
      durationMs: 8,
    });
    expect(completed?.raised).toBe(true);

    const cleared = await task.loops.update({ ...task.scope, id, action: "clear-signal" });
    expect(cleared?.outcome).toBe("signal-cleared");
    const quiet = cleared?.view.task;
    if (quiet?.kind !== "cmd-loop") throw new Error("expected a command loop");
    expect(quiet.signalRaised).toBeUndefined();
  });

  it("fires a command loop by hand without taking a schedule slot or moving the clock", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "1h",
      command: "check",
    });
    const id = created.task.id;

    const view = await task.loops.fireNow({ ...task.scope, id });
    expect(view?.task.kind).toBe("cmd-loop");
    expect(task.started.at(-1)?.fire).toBe(-1);
    if (view?.task.kind !== "cmd-loop") throw new Error("expected a command loop");
    expect(view.task.fires).toBe(0);
    expect(view.task.nextFireAt).toBe(created.task.nextFireAt);
    expect(view.task.fireHistory.at(-1)).toMatchObject({ fire: -1, outcome: "running" });

    // A manual failure is a probe result, not a broken loop: no streak, no backoff.
    await task.loops.completeFire({
      parentId: id,
      taskId: task.started.at(-1)?.taskId ?? "",
      fire: -1,
      status: "failed",
      exitCode: 3,
      outputPath: `${task.directory.path}/manual.log`,
      outputBytes: 4,
      durationMs: 3,
    });
    const after = await task.loops.get(task.scope, id);
    if (after?.task.kind !== "cmd-loop") throw new Error("expected a command loop");
    expect(after.task.nextFireAt).toBe(created.task.nextFireAt);
    expect(after.task.consecutiveFailures).toBeUndefined();
    expect(after.task.fireHistory.at(-1)).toMatchObject({ fire: -1, outcome: "failed" });

    const prompted = await task.loops.create({ ...task.scope, schedule: "1h", prompt: "go" });
    await expect(task.loops.fireNow({ ...task.scope, id: prompted.task.id })).rejects.toThrow(
      /Only a command loop/,
    );
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

  it("pushes a caught-up fire away from the boundary it almost landed on", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "*/10 * * * *",
      prompt: "check",
    });
    expect(created.task.nextFireAt).toBe(Date.UTC(2026, 0, 1, 9, 10, 0));

    // The pump was away and catches up five seconds before the next slot: the
    // shape that used to start two fires inside ten seconds (ADR-0018).
    task.advance(19 * 60_000 + 55_000);
    expect(await task.loops.pump(task.now)).toHaveLength(1);

    const view = await task.loops.get(task.scope, created.task.id);
    expect(view?.task.lastFireAt).toBe(task.now);
    expect(view?.task.nextFireAt).toBe(Date.UTC(2026, 0, 1, 9, 30, 0));
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

  it("records a failed turn on the loop, with its error and time, and waits longer", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });
    task.advance(10_000);
    expect(await task.loops.pump(task.now)).toHaveLength(1);
    const firedAt = task.now;

    // The turn the fire woke ends with the provider giving up, two seconds in.
    task.advance(2_000);
    await settleTurn(task, {
      id: created.task.id,
      fire: 1,
      end: "failed",
      error: "529 overloaded_error: the provider is busy",
    });

    const view = await task.loops.get(task.scope, created.task.id);
    if (view?.task.kind !== "prompt-loop") throw new Error("expected a prompt loop");
    expect(view.task.consecutiveFailures).toBe(1);
    expect(view.task.lastError).toBe("529 overloaded_error: the provider is busy");
    expect(view.task.lastFailureAt).toBe(task.now);
    // One failure on a ten-second schedule waits twenty seconds from the failure.
    expect(view.task.nextFireAt).toBe(task.now + 20_000);
    expect(view.task.lastFireAt).toBe(firedAt);

    // The record only exists on disk: a reader must see the failure there too.
    const records = await task.reload();
    expect(records.find((record) => record.id === created.task.id)).toMatchObject({
      consecutiveFailures: 1,
      lastError: "529 overloaded_error: the provider is busy",
      lastFailureAt: task.now,
    });
  });

  it("clears the failure streak and its error on a turn that finished", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });
    task.advance(10_000);
    await task.loops.pump(task.now);
    task.advance(1_000);
    await settleTurn(task, { id: created.task.id, fire: 1, end: "failed", error: "fetch failed" });

    task.advance(20_000);
    await task.loops.pump(task.now);
    const firedAt = task.now;
    task.advance(1_000);
    await settleTurn(task, { id: created.task.id, fire: 2, end: "healthy" });

    const view = await task.loops.get(task.scope, created.task.id);
    if (view?.task.kind !== "prompt-loop") throw new Error("expected a prompt loop");
    expect(view.task.consecutiveFailures).toBe(0);
    expect(view.task.lastError).toBeUndefined();
    expect(view.task.lastFailureAt).toBeUndefined();
    // A healthy fire ends the backoff: the next fire is one interval away.
    expect(view.task.nextFireAt).toBe(firedAt + 10_000);
  });

  it("leaves the streak alone when the user aborted the turn", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });
    task.advance(10_000);
    await task.loops.pump(task.now);
    task.advance(1_000);
    await settleTurn(task, { id: created.task.id, fire: 1, end: "failed", error: "fetch failed" });
    const failed = await task.loops.get(task.scope, created.task.id);
    if (failed?.task.kind !== "prompt-loop") throw new Error("expected a prompt loop");

    task.advance(20_000);
    const secondFireAt = task.now;
    await task.loops.pump(task.now);
    task.advance(1_000);
    await settleTurn(task, { id: created.task.id, fire: 2, end: "aborted" });

    const view = await task.loops.get(task.scope, created.task.id);
    if (view?.task.kind !== "prompt-loop") throw new Error("expected a prompt loop");
    // A stop by the user says nothing about the provider: the streak and the
    // error of the failed fire before it stay exactly as they were.
    expect(view.task.consecutiveFailures).toBe(1);
    expect(view.task.lastError).toBe("fetch failed");
    expect(view.task.lastFailureAt).toBe(failed.task.lastFailureAt);
    // The aborted fire leaves the schedule where the pump put it: no backoff.
    expect(view.task.nextFireAt).toBe(secondFireAt + 10_000);
  });

  it("records nothing against a loop whose fire is no longer in the record", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });
    task.advance(10_000);
    await task.loops.pump(task.now);

    // A turn that outlived its loop: the late settle must not resurrect it, and
    // must not throw on the way out either.
    await task.loops.delete(task.scope, created.task.id);
    await settleTurn(task, { id: created.task.id, fire: 1, end: "failed", error: "fetch failed" });
    expect(await task.loops.list(task.scope)).toEqual([]);
  });

  it("leaves the streak alone when nothing was observed about the turn", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });
    task.advance(10_000);
    await task.loops.pump(task.now);
    task.advance(1_000);
    await settleTurn(task, { id: created.task.id, fire: 1, end: "failed", error: "fetch failed" });
    const failed = await task.loops.get(task.scope, created.task.id);
    if (failed?.task.kind !== "prompt-loop") throw new Error("expected a prompt loop");

    task.advance(20_000);
    const secondFireAt = task.now;
    await task.loops.pump(task.now);
    task.advance(1_000);
    // No assistant message described this turn, so its outcome is unknown and an
    // unknown outcome is not a successful one.
    await settleTurn(task, { id: created.task.id, fire: 2, end: "unobserved" });

    const view = await task.loops.get(task.scope, created.task.id);
    if (view?.task.kind !== "prompt-loop") throw new Error("expected a prompt loop");
    expect(view.task.consecutiveFailures).toBe(1);
    expect(view.task.lastError).toBe("fetch failed");
    expect(view.task.lastFailureAt).toBe(failed.task.lastFailureAt);
    // The unobserved turn moves nothing at all, the backoff included: the fire that
    // was already scheduled stays where the pump put it.
    expect(view.task.nextFireAt).toBe(secondFireAt + 10_000);
  });

  it("clears the error of an earlier failure when the failed turn reports none", async () => {
    const task = await setup();
    const created = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "keep going",
    });
    task.advance(10_000);
    await task.loops.pump(task.now);
    task.advance(1_000);
    await settleTurn(task, { id: created.task.id, fire: 1, end: "failed", error: "fetch failed" });
    const failed = await task.loops.get(task.scope, created.task.id);
    if (failed?.task.kind !== "prompt-loop") throw new Error("expected a prompt loop");
    expect(failed.task.lastError).toBe("fetch failed");

    task.advance((failed.task.nextFireAt ?? task.now) - task.now);
    await task.loops.pump(task.now);
    task.advance(1_000);
    // A second failure whose message carried nothing: the error and the time must
    // name the same fire, so the old error cannot stay behind a moved timestamp.
    await settleTurn(task, { id: created.task.id, fire: 2, end: "failed" });

    const view = await task.loops.get(task.scope, created.task.id);
    if (view?.task.kind !== "prompt-loop") throw new Error("expected a prompt loop");
    expect(view.task.consecutiveFailures).toBe(2);
    expect(view.task.lastFailureAt).toBe(task.now);
    expect(view.task.lastError).toBeUndefined();
  });

  it("charges one settled turn to every loop that fired it", async () => {
    const task = await setup();
    const first = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "review the diff",
    });
    const second = await task.loops.create({
      ...task.scope,
      schedule: "10s",
      prompt: "triage the issues",
    });
    task.advance(10_000);
    // Both came due while the agent was busy, so one turn is both their fire.
    expect(await task.loops.pump(task.now)).toHaveLength(2);
    const firedAt = task.now;
    task.advance(2_000);
    await task.loops.completeTurns(task.scope, [
      { id: first.task.id, fire: 1, end: "failed", error: "fetch failed" },
      { id: second.task.id, fire: 1, end: "failed", error: "fetch failed" },
    ]);

    for (const id of [first.task.id, second.task.id]) {
      const view = await task.loops.get(task.scope, id);
      if (view?.task.kind !== "prompt-loop") throw new Error("expected a prompt loop");
      expect(view.task.consecutiveFailures).toBe(1);
      expect(view.task.lastError).toBe("fetch failed");
      expect(view.task.lastFailureAt).toBe(task.now);
      expect(view.task.nextFireAt).toBe(firedAt + 2_000 + 20_000);
    }

    // The healthy round clears both streaks, not only the loop the settle named.
    task.advance(firedAt + 2_000 + 20_000 - task.now);
    expect(await task.loops.pump(task.now)).toHaveLength(2);
    const healedAt = task.now;
    task.advance(1_000);
    await task.loops.completeTurns(task.scope, [
      { id: first.task.id, fire: 2, end: "healthy" },
      { id: second.task.id, fire: 2, end: "healthy" },
    ]);

    for (const id of [first.task.id, second.task.id]) {
      const view = await task.loops.get(task.scope, id);
      if (view?.task.kind !== "prompt-loop") throw new Error("expected a prompt loop");
      expect(view.task.consecutiveFailures).toBe(0);
      expect(view.task.lastError).toBeUndefined();
      expect(view.task.nextFireAt).toBe(healedAt + 10_000);
    }
    // One settle, one write: both loops and both closed schedules are on disk.
    const records = await task.reload();
    for (const id of [first.task.id, second.task.id]) {
      expect(records.find((record) => record.id === id)).toMatchObject({
        consecutiveFailures: 0,
        nextFireAt: healedAt + 10_000,
      });
    }
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
    if (before === undefined || before.task.kind !== "prompt-loop") {
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
    if (after === undefined || after.kind !== "prompt-loop") {
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

  it("refuses an invalid schedule the way pretty_task_loop_create does and keeps the old one firing", async () => {
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

describe("prompt file", () => {
  /** The address of one loop's prompt file, derived the way the plugin derives it. */
  function promptPath(task: Awaited<ReturnType<typeof setup>>, loopId: string): string {
    return loopPromptPath(sessionTaskDirectory(task.scope.cwd, task.scope.sessionId), loopId);
  }

  async function createPromptLoop(
    task: Awaited<ReturnType<typeof setup>>,
    prompt = "review the diff",
  ) {
    return task.loops.create({ ...task.scope, schedule: "10s", prompt });
  }

  /** The record, once it is known to be the prompt loop the test created. */
  async function promptLoopOf(
    task: Awaited<ReturnType<typeof setup>>,
    loopId: string,
  ): Promise<PromptLoopTask> {
    const view = await task.loops.get(task.scope, loopId);
    if (view?.task.kind !== "prompt-loop")
      throw new Error("the loop did not load as a prompt loop");
    return view.task;
  }

  it("writes the prompt to the derived path when the loop is created", async () => {
    const task = await setup();
    const created = await createPromptLoop(task);

    const path = promptPath(task, created.task.id);
    expect(created.promptFile).toBe(path);
    expect(await readFile(path, "utf8")).toBe("review the diff");
    // The record keeps the same text as the seed, not a copy of the file's state.
    expect((await promptLoopOf(task, created.task.id)).prompt).toBe("review the diff");
  });

  it("fires the text in the file, so an edited prompt reaches the next fire", async () => {
    const task = await setup();
    const created = await createPromptLoop(task);
    await writeFile(promptPath(task, created.task.id), "refined wording\n", "utf8");

    task.advance(10_000);
    const fired = await task.loops.pump(task.now);

    expect(fired).toHaveLength(1);
    expect(fired[0]?.prompt).toBe("refined wording\n");
    // Reading is not writing: the file stays exactly what the user saved.
    expect(await readFile(promptPath(task, created.task.id), "utf8")).toBe("refined wording\n");
  });

  it("rebuilds a missing file from the record and says so on the record", async () => {
    const task = await setup();
    const created = await createPromptLoop(task);
    const path = promptPath(task, created.task.id);
    await rm(path);

    task.advance(10_000);
    const fired = await task.loops.pump(task.now);

    expect(fired[0]?.prompt).toBe("review the diff");
    expect(await readFile(path, "utf8")).toBe("review the diff");
    expect((await promptLoopOf(task, created.task.id)).promptWarning).toContain("is missing");
  });

  it("treats a file of whitespace as unreadable, because an empty wake says nothing", async () => {
    const task = await setup();
    const created = await createPromptLoop(task);
    const path = promptPath(task, created.task.id);
    await writeFile(path, "  \n\t\n", "utf8");

    task.advance(10_000);
    const fired = await task.loops.pump(task.now);

    expect(fired[0]?.prompt).toBe("review the diff");
    expect(await readFile(path, "utf8")).toBe("review the diff");
    expect((await promptLoopOf(task, created.task.id)).promptWarning).toContain("is empty");
  });

  it("clears the warning once the file reads cleanly again", async () => {
    const task = await setup();
    const created = await createPromptLoop(task);
    const path = promptPath(task, created.task.id);
    await rm(path);
    task.advance(10_000);
    await task.loops.pump(task.now);

    task.advance(10_000);
    await task.loops.pump(task.now);

    expect((await promptLoopOf(task, created.task.id)).promptWarning).toBeUndefined();
  });

  it("keeps the schedule when the file cannot be read or rebuilt, and sends a diagnostic", async () => {
    const task = await setup();
    const created = await createPromptLoop(task);
    const path = promptPath(task, created.task.id);
    // A directory where the file belongs: unreadable, and the rebuild cannot rename over it.
    await rm(path);
    await mkdir(path);

    task.advance(10_000);
    const fired = await task.loops.pump(task.now);

    expect(fired).toHaveLength(1);
    const text = fired[0]?.prompt ?? "";
    expect(text).toContain(path);
    expect(text).toContain("keeps firing on its schedule");
    const view = await task.loops.get(task.scope, created.task.id);
    expect(view?.task.status).toBe("running");
    expect(view?.task.fires).toBe(1);
    expect(view?.task.nextFireAt).toBe(task.now + 10_000);
  });

  it("deletes the prompt file with the loop", async () => {
    const task = await setup();
    const created = await createPromptLoop(task);
    const path = promptPath(task, created.task.id);

    await task.loops.delete(task.scope, created.task.id);

    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives a loop that predates the file its prompt file on the first fire", async () => {
    const task = await setup();
    const created = await createPromptLoop(task);
    const path = promptPath(task, created.task.id);
    await rm(path);

    task.advance(10_000);
    await task.loops.pump(task.now);

    expect(await readFile(path, "utf8")).toBe("review the diff");
  });

  it("previews three non-empty lines and the file's own modification time", async () => {
    const task = await setup();
    const created = await createPromptLoop(task);
    const path = promptPath(task, created.task.id);
    const directory = sessionTaskDirectory(task.scope.cwd, task.scope.sessionId);
    await writeFile(
      path,
      "\n  step one: check the queue  \n\nstep two\nstep three\nstep four that never shows\n",
      "utf8",
    );

    const preview = await readPromptPreview(directory, created.task.id);

    // The panel draws these three lines and no more, so the iteration list keeps its room.
    expect(preview.path).toBe(path);
    expect(preview.lines).toEqual(["step one: check the queue", "step two", "step three"]);
    expect(preview.changedAt).toBe((await stat(path)).mtimeMs);
    // Nothing went wrong, so the page has nothing to warn about.
    expect(preview.problem).toBeUndefined();
  });

  it("names the path and previews nothing when the file is gone", async () => {
    const task = await setup();
    const created = await createPromptLoop(task);
    const path = promptPath(task, created.task.id);
    const directory = sessionTaskDirectory(task.scope.cwd, task.scope.sessionId);
    await rm(path);

    const preview = await readPromptPreview(directory, created.task.id);

    // No throw and no preview: the reader gets the address, why there is no text,
    // and the record's own warning when the last fire had to rebuild it.
    expect(preview.path).toBe(path);
    expect(preview.lines).toEqual([]);
    expect(preview.changedAt).toBeUndefined();
    expect(preview.problem).toBe("is missing");
  });

  it("keeps the file's time and names it empty when every line is blank", async () => {
    const task = await setup();
    const created = await createPromptLoop(task);
    const path = promptPath(task, created.task.id);
    const directory = sessionTaskDirectory(task.scope.cwd, task.scope.sessionId);
    await writeFile(path, "  \n\t\n", "utf8");

    const preview = await readPromptPreview(directory, created.task.id);

    // A blank file is readable, so the panel can still say when it last changed;
    // "is empty" is why there is nothing between the path and that time.
    expect(preview.lines).toEqual([]);
    expect(preview.changedAt).toBe((await stat(path)).mtimeMs);
    expect(preview.problem).toBe("is empty");
  });
});
