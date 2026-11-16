/**
 * Wake delivery policy (ADR-0009): a wake waits for an idle agent, a wake whose
 * loop stopped is dropped before it is ever sent, and a dropped wake takes its
 * pending iteration with it. The harness tests in `loop-wakes.test.ts` prove the
 * behaviour end to end; these cases pin the four rules the desk decides alone —
 * idle gating, drop before send, the final wake, and a drop that fails.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { describe, expect, it, vi } from "vitest";
import type { PromptLoopTask, TaskStatus } from "../../src/tasks/base/task.js";
import type { OwnedTaskSession } from "../../src/tasks/base/task-sessions.js";
import type { Iterations } from "../../src/tasks/loop/iterations.js";
import type { LoopFire } from "../../src/tasks/loop/loop-tasks.js";
import { WakeDesk } from "../../src/tasks/loop/wake-desk.js";

/** A loop and the fire it just produced, with its record still mutable. */
function fireOf(id: string, options: { status?: TaskStatus; final?: boolean } = {}) {
  const task = { id, kind: "prompt-loop", status: options.status ?? "running" };
  const session = { tasks: new Map([[id, task]]) };
  const fire = {
    task: task as unknown as PromptLoopTask,
    at: 1_000,
    fire: 1,
    session: session as unknown as OwnedTaskSession,
    final: options.final ?? false,
  };
  return { fire: fire as LoopFire, task };
}

/** The desk wired to recording fakes: every call lands in `events` in order. */
function deskOf(options: { failDrop?: boolean } = {}) {
  const events: string[] = [];
  const sent: LoopFire[] = [];
  let changes = 0;
  const iterations = {
    bind: (fire: LoopFire) => {
      events.push(`bind:${fire.task.id}`);
    },
    drop: async (fire: LoopFire) => {
      events.push(`drop:${fire.task.id}`);
      if (options.failDrop === true) throw new Error("record failed");
    },
  } as unknown as Iterations;
  const desk = new WakeDesk({
    iterations,
    send: (fire) => {
      events.push(`send:${fire.task.id}`);
      sent.push(fire);
    },
    onChange: () => {
      changes += 1;
    },
  });
  return { desk, events, sent, changes: () => changes };
}

describe("wake desk", () => {
  it("holds a wake while a turn runs and sends it once the agent settles", async () => {
    const { desk, sent, events, changes } = deskOf();
    const { fire } = fireOf("lp-a");

    desk.busy();
    desk.record(fire);
    await desk.flush();

    expect(desk.size).toBe(1);
    expect(sent).toEqual([]);
    expect(events).toEqual([]);
    expect(changes()).toBe(0);

    await desk.settled();

    expect(desk.size).toBe(0);
    expect(sent).toEqual([fire]);
    // The iteration binds before the send, so the turn it wakes records its calls.
    expect(events).toEqual(["bind:lp-a", "send:lp-a"]);
    expect(changes()).toBe(1);
  });

  it("drops the wake of a loop that stopped before it could be delivered", async () => {
    const { desk, sent, events } = deskOf();
    const live = fireOf("lp-live");
    const paused = fireOf("lp-paused", { status: "paused" });

    desk.busy();
    desk.record(paused.fire);
    desk.record(live.fire);
    await desk.settled();

    expect(sent).toEqual([live.fire]);
    // The drop goes out before the deliveries of the same flush.
    expect(events).toEqual(["drop:lp-paused", "bind:lp-live", "send:lp-live"]);
  });

  it("still delivers the wake of a loop whose last allowed fire completed it", async () => {
    const { desk, sent } = deskOf();
    const { fire } = fireOf("lp-last", { status: "completed", final: true });

    desk.busy();
    desk.record(fire);
    await desk.settled();

    expect(sent).toEqual([fire]);
  });

  it("cancels only one loop's wakes, oldest first", async () => {
    const { desk } = deskOf();
    const first = fireOf("lp-a");
    const other = fireOf("lp-b");
    const second = fireOf("lp-a");

    desk.busy();
    desk.record(first.fire);
    desk.record(other.fire);
    desk.record(second.fire);

    expect(desk.cancel("lp-a")).toEqual([first.fire, second.fire]);
    expect(desk.size).toBe(1);
    expect(desk.cancel("lp-missing")).toEqual([]);
  });

  it("reports a dropped record on stderr and keeps delivering the rest", async () => {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      const { desk, sent } = deskOf({ failDrop: true });
      const stopped = fireOf("lp-stopped", { status: "completed" });
      const live = fireOf("lp-live");

      desk.busy();
      desk.record(stopped.fire);
      desk.record(live.fire);
      await desk.settled();

      expect(sent).toEqual([live.fire]);
      expect(written.join("")).toContain("iteration record failed");
    } finally {
      spy.mockRestore();
    }
  });
});
