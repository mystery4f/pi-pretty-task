/**
 * The loop tools and the wake they send, driven through the extension exactly
 * as pi would drive it: registered tools, a fake clock, and an explicit pump.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness, resultText } from "./support/extension-harness.js";
import { makeTempDir } from "./support/processes.js";

interface LoopDetails {
  id: string;
  name: string;
  kind: string;
  status: string;
  schedule: string;
  prompt: string;
  fires: number;
  maxFires?: number;
  nextFireAt?: number;
  lastFireAt?: number;
  endedAt?: number;
  untilNextFireMs?: number;
  outcome?: string;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function setup() {
  const directory = await makeTempDir();
  cleanup.push(directory.dispose);
  let now = Date.UTC(2026, 0, 1, 9, 0, 0);
  const turn = { cwd: directory.path, sessionId: "session-loops" };
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

function detailsOf(result: { details: unknown }): LoopDetails {
  return result.details as LoopDetails;
}

async function createLoop(harness: Harness, params: Record<string, unknown>): Promise<LoopDetails> {
  return detailsOf(await harness.call("loop_create", { schedule: "10s", ...params }));
}

describe("loop tools", () => {
  it("registers the loop tools and the wake renderer", async () => {
    const task = await setup();
    expect(task.harness.toolNames).toEqual(
      expect.arrayContaining(["loop_create", "loop_list", "loop_update", "loop_delete"]),
    );
    expect(task.harness.rendererTypes).toContain("loop-wake");
  });

  it("creates a loop and lists its raw schedule, next fire, count and status", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, {
      schedule: "10s",
      prompt: "review the diff",
      maxFires: 3,
    });

    expect(created).toMatchObject({
      kind: "loop",
      status: "running",
      schedule: "10s",
      prompt: "review the diff",
      fires: 0,
      maxFires: 3,
      nextFireAt: task.now + 10_000,
      untilNextFireMs: 10_000,
    });

    const listed = await task.harness.call("loop_list", {});
    const text = resultText(listed);
    expect(text).toContain("schedule: 10s");
    expect(text).toContain("next fire:");
    expect(text).toContain("(in 10.0s)");
    expect(text).toContain("fires: 0 / 3");
    expect(text).toContain("status: running");
    expect(text).toContain("prompt: review the diff");

    const one = await task.harness.call("loop_list", { id: created.id });
    expect(detailsOf(one).id).toBe(created.id);
  });

  it("rejects a bad schedule with a clear example", async () => {
    const task = await setup();
    const result = await task.harness.call("loop_create", {
      schedule: "10 minutes",
      prompt: "keep going",
    });

    const text = resultText(result);
    expect(text).toContain('Invalid schedule "10 minutes"');
    expect(text).toContain("30s, 10m or 2h");
    expect(detailsOf(result).id).toBeUndefined();
  });

  it("rejects a bad maxFires and a bad expiresIn", async () => {
    const task = await setup();
    const badMax = await task.harness.call("loop_create", {
      schedule: "10m",
      prompt: "keep going",
      maxFires: 0,
    });
    expect(resultText(badMax)).toContain("maxFires");

    const badExpiry = await task.harness.call("loop_create", {
      schedule: "10m",
      prompt: "keep going",
      expiresIn: "2d",
    });
    expect(resultText(badExpiry)).toContain('expiresIn "2d"');
  });

  it("pumps the prompt into the session as a follow-up that starts a turn", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, {
      schedule: "10s",
      prompt: "keep working on the refactor",
    });

    task.advance(9_999);
    expect(await task.harness.pump(task.now)).toEqual([]);
    expect(task.harness.messages).toEqual([]);

    task.advance(1);
    const fires = await task.harness.pump(task.now);
    expect(fires).toHaveLength(1);
    expect(task.harness.messages).toHaveLength(1);

    const message = task.harness.messages[0];
    if (message === undefined) throw new Error("no loop wake was sent");
    expect(message.customType).toBe("loop-wake");
    expect(message.content).toBe("keep working on the refactor");
    expect(message.display).toBe(true);
    expect(message.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(message.details).toMatchObject({
      id: created.id,
      name: "keep working on the refactor",
      schedule: "10s",
      fire: 1,
    });

    const rendered = task.harness.render("loop-wake", message.details);
    expect(rendered).toContain("loop");
    expect(rendered).toContain("fire 1");
    expect(rendered).toContain("keep working on the refactor");

    const listed = await task.harness.call("loop_list", { id: created.id });
    expect(detailsOf(listed)).toMatchObject({ fires: 1, lastFireAt: task.now });
  });

  it("keeps firing on later turns without another user message", async () => {
    const task = await setup();
    await createLoop(task.harness, { schedule: "10s", prompt: "one more pass" });

    for (let fire = 1; fire <= 3; fire += 1) {
      task.advance(10_000);
      const fired = await task.harness.pump(task.now);
      expect(fired).toHaveLength(1);
      expect(fired[0]?.fire).toBe(fire);
    }

    expect(task.harness.messages.map((message) => message.content)).toEqual([
      "one more pass",
      "one more pass",
      "one more pass",
    ]);
  });

  it("pauses, resumes, completes, and deletes through loop_update and loop_delete", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, { schedule: "10s", prompt: "keep going" });

    const paused = await task.harness.call("loop_update", { id: created.id, action: "pause" });
    expect(resultText(paused)).toContain("Paused loop");
    expect(detailsOf(paused)).toMatchObject({ status: "paused", outcome: "paused" });

    task.advance(30_000);
    expect(await task.harness.pump(task.now)).toEqual([]);
    expect(task.harness.messages).toEqual([]);

    const resumed = await task.harness.call("loop_update", { id: created.id, action: "resume" });
    expect(resultText(resumed)).toContain("Resumed loop");
    expect(detailsOf(resumed)).toMatchObject({
      status: "running",
      outcome: "resumed",
      nextFireAt: task.now + 10_000,
    });

    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toHaveLength(1);

    const completed = await task.harness.call("loop_update", {
      id: created.id,
      action: "complete",
    });
    expect(resultText(completed)).toContain("Completed loop");
    expect(detailsOf(completed)).toMatchObject({ status: "completed", outcome: "completed" });

    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toEqual([]);

    const deleted = await task.harness.call("loop_delete", { id: created.id });
    expect(resultText(deleted)).toContain("Deleted loop");
    expect(resultText(await task.harness.call("loop_list", {}))).toContain("No loops");
    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toEqual([]);
    expect(task.harness.messages).toHaveLength(1);
  });

  it("reloads a loop after a restart and keeps its fire count", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, { schedule: "10s", prompt: "keep going" });

    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toHaveLength(1);

    const restarted = createHarness(task.turn, { now: () => task.now });
    await restarted.startSession();

    const listed = await restarted.call("loop_list", { id: created.id });
    expect(detailsOf(listed)).toMatchObject({
      id: created.id,
      status: "running",
      schedule: "10s",
      fires: 1,
    });

    task.advance(10_000);
    const fired = await restarted.pump(task.now);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.fire).toBe(2);
    expect(restarted.messages[0]?.content).toBe("keep going");
  });
});
