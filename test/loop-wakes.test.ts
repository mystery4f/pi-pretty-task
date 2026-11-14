/**
 * Wake delivery: a fire is queued when the pump records it and only handed to
 * pi while the agent is idle (ADR-0009). pi's `followUp` queue cannot be
 * recalled, so a wake sent to a busy agent would still arrive after its loop
 * was completed — these tests drive the idle transitions and the queue through
 * the extension boundary, with a fake clock and no UI.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness, resultText } from "./support/extension-harness.js";
import { makeTempDir } from "./support/processes.js";

interface LoopDetails {
  id: string;
  status: string;
  fires: number;
  maxFires?: number;
  iterationCount?: number;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function setup() {
  const directory = await makeTempDir();
  cleanup.push(directory.dispose);
  let now = Date.UTC(2026, 0, 1, 9, 0, 0);
  const turn = { cwd: directory.path, sessionId: "session-wakes" };
  const harness = createHarness(turn, { now: () => now });
  return {
    harness,
    turn,
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

function detailsOf<T>(result: { details: unknown }): T {
  return result.details as T;
}

async function createLoop(harness: Harness, params: Record<string, unknown> = {}) {
  return detailsOf<LoopDetails>(
    await harness.call("loop_create", { schedule: "10s", prompt: "review the diff", ...params }),
  );
}

describe("reload", () => {
  it("keeps a running loop armed when the module reloads before its first fire", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, { schedule: "30s", maxFires: 1 });

    // A reload is a second extension instance over the same session directory.
    const reloaded = createHarness(task.turn, { now: () => task.now });
    await reloaded.pump(task.now + 1_000);
    const afterLoad = detailsOf<LoopDetails>(await reloaded.call("loop_list", { id: created.id }));
    expect(afterLoad.status).toBe("running");
    expect(afterLoad.fires).toBe(0);

    await reloaded.pump(task.now + 31_000);
    const fired = detailsOf<LoopDetails>(await reloaded.call("loop_list", { id: created.id }));
    expect(fired.fires).toBe(1);
    expect(fired.status).toBe("completed");
  });
});

describe("wake delivery", () => {
  it("holds a wake while the agent is busy and delivers it when the agent settles", async () => {
    const task = await setup();
    const created = await createLoop(task.harness);

    // The agent is mid-turn when the loop comes due: the wake has to wait.
    await task.harness.emit({ type: "agent_start" });
    task.advance(10_000);
    const fired = await task.harness.pump(task.now);
    expect(fired).toHaveLength(1);
    expect(task.harness.messages).toEqual([]);
    expect(task.harness.pendingWakes).toBe(1);

    await task.harness.emit({ type: "agent_settled", aborted: false });

    expect(task.harness.messages).toHaveLength(1);
    expect(task.harness.pendingWakes).toBe(0);
    const [message] = task.harness.messages;
    expect(message?.details).toMatchObject({ id: created.id, fire: 1 });
    expect(message?.content).toBe("review the diff");
    expect(resultText(await task.harness.call("loop_list", {}))).toContain("fires: 1");
  });

  it("drops the queued wake when the loop is completed before delivery", async () => {
    const task = await setup();
    const created = await createLoop(task.harness);

    await task.harness.emit({ type: "agent_start" });
    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toHaveLength(1);
    expect(task.harness.messages).toEqual([]);

    const updated = detailsOf<LoopDetails>(
      await task.harness.call("loop_update", { id: created.id, action: "complete" }),
    );
    expect(updated.status).toBe("completed");

    await task.harness.emit({ type: "agent_settled", aborted: false });

    expect(task.harness.messages).toEqual([]);
    // The pending iteration went with the wake: no turn happened, so no record.
    const view = detailsOf<LoopDetails>(await task.harness.call("loop_list", { id: created.id }));
    expect(view.iterationCount ?? 0).toBe(0);
  });

  it("drops queued wakes when their loops are paused or deleted", async () => {
    const task = await setup();
    const paused = await createLoop(task.harness, { name: "paused" });
    const deleted = await createLoop(task.harness, { name: "deleted" });

    await task.harness.emit({ type: "agent_start" });
    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toHaveLength(2);

    await task.harness.call("loop_update", { id: paused.id, action: "pause" });
    await task.harness.call("loop_delete", { id: deleted.id });

    await task.harness.emit({ type: "agent_settled", aborted: false });

    expect(task.harness.messages).toEqual([]);
  });

  it("delivers the final maxFires wake exactly once, even when it fired while busy", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, { maxFires: 2 });

    // First fire while idle: delivered at once.
    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toHaveLength(1);
    expect(task.harness.messages).toHaveLength(1);

    // Second fire reaches the limit while the agent is busy: the loop completes
    // now, but that wake is the reason it ran to the limit and must still go out.
    await task.harness.emit({ type: "agent_start" });
    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toHaveLength(1);
    expect(task.harness.messages).toHaveLength(1);

    await task.harness.emit({ type: "agent_settled", aborted: false });
    expect(task.harness.messages).toHaveLength(2);
    expect(task.harness.messages[1]?.details).toMatchObject({ id: created.id, fire: 2 });

    await task.harness.emit({ type: "agent_settled", aborted: false });
    expect(task.harness.messages).toHaveLength(2);
    const view = detailsOf<LoopDetails>(await task.harness.call("loop_list", { id: created.id }));
    expect(view.status).toBe("completed");
    expect(view.fires).toBe(2);
  });

  it("drops a queued wake when its loop finished for another reason", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, { expiresIn: "25s" });

    await task.harness.emit({ type: "agent_start" });
    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toHaveLength(1);

    // The loop expires before the agent settles: the queued wake is stale.
    task.advance(20_000);
    expect(await task.harness.pump(task.now)).toEqual([]);

    await task.harness.emit({ type: "agent_settled", aborted: false });

    expect(task.harness.messages).toEqual([]);
    const view = detailsOf<LoopDetails>(await task.harness.call("loop_list", { id: created.id }));
    expect(view.status).toBe("completed");
  });
});
