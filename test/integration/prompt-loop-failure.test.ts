/**
 * A prompt loop's fire that the provider gave up on (ticket #46), driven through
 * the pi events and the loop tools. The record has to carry the failure, and the
 * settle has to charge it to every loop the one turn fired — several loops come due
 * while the agent is busy and are delivered into the same turn.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { afterEach, describe, expect, it } from "vitest";

import { sessionTaskDirectory } from "../../src/tasks/base/runtime-state.js";
import { TaskStore } from "../../src/tasks/base/task-store.js";
import { createHarness, type Harness } from "../support/extension-harness.js";
import { makeTempDir } from "../support/processes.js";

interface LoopDetails {
  id: string;
  fires: number;
  /** The failure streak a fire's turn adds to or clears (ticket #46). */
  consecutiveFailures?: number;
  /** What the provider said when it last gave up on a fire's turn. */
  lastError?: string;
  lastFailureAt?: number;
  nextFireAt?: number;
  lastFireAt?: number;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function setup() {
  const directory = await makeTempDir();
  cleanup.push(directory.dispose);
  let now = Date.UTC(2026, 0, 1, 9, 0, 0);
  const turn = { cwd: directory.path, sessionId: "session-loop-failure" };
  const harness = createHarness(turn, { now: () => now });
  return {
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

function detailsOf<T>(result: { details: unknown }): T {
  return result.details as T;
}

async function createLoop(harness: Harness, params: Record<string, unknown> = {}) {
  return detailsOf<LoopDetails>(
    await harness.call("pretty_task_loop_create", {
      schedule: "10s",
      prompt: "review the diff",
      ...params,
    }),
  );
}

/** One loop's own facts — streak, error, schedule — as the tools report them. */
async function loopOf(harness: Harness, id: string): Promise<LoopDetails> {
  return detailsOf<LoopDetails>(await harness.call("pretty_task_loop_list", { id }));
}

/** The last assistant message of a turn: its stop reason is the only signal pi forwards. */
async function endAttempt(
  harness: Harness,
  outcome: { stopReason?: string; errorMessage?: string } = {},
): Promise<void> {
  await harness.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "…" }],
      stopReason: outcome.stopReason ?? "stop",
      ...(outcome.errorMessage === undefined ? {} : { errorMessage: outcome.errorMessage }),
    },
  });
}

/**
 * The harness's own turn, left open, with `loops` created before the agent goes
 * busy. The settle in the middle closes that turn and sends the queued wakes,
 * which is what binds their iterations.
 */
async function openTurns(prompts: readonly string[]) {
  const task = await setup();
  const created: LoopDetails[] = [];
  for (const prompt of prompts) created.push(await createLoop(task.harness, { prompt }));
  await task.harness.emit({ type: "agent_start" });
  task.advance(10_000);
  await task.harness.pump(task.now);
  await task.harness.emit({ type: "agent_settled", aborted: false });
  return { task, created };
}

describe("a loop fire the provider gave up on", () => {
  it("records the failure on the loop, on disk, and pushes the next fire back", async () => {
    const { task, created } = await openTurns(["review the diff"]);
    const loop = created[0];
    if (loop === undefined) throw new Error("no loop was created");
    const firedAt = task.now;

    task.advance(2_000);
    await endAttempt(task.harness, {
      stopReason: "error",
      errorMessage: "529 overloaded_error: the provider is busy",
    });
    await task.harness.emit({ type: "agent_settled", aborted: false });

    const after = await loopOf(task.harness, loop.id);
    expect(after.consecutiveFailures).toBe(1);
    expect(after.lastError).toBe("529 overloaded_error: the provider is busy");
    expect(after.lastFailureAt).toBe(task.now);
    // One failure doubles a ten-second schedule: the next fire is twenty seconds
    // from the failure, so the loop does not spend its fires on a broken provider.
    expect((after.nextFireAt ?? 0) - firedAt).toBe(22_000);

    // One settle is one write, and the record only exists on disk: a reader must
    // see the closed iteration and the loop's failure in the same file.
    const store = new TaskStore(sessionTaskDirectory(task.turn.cwd, task.turn.sessionId));
    const stored = (await store.load()).find((record) => record.id === loop.id);
    if (stored?.kind !== "prompt-loop") throw new Error("the loop was not persisted");
    expect(stored).toMatchObject({
      consecutiveFailures: 1,
      lastError: "529 overloaded_error: the provider is busy",
      lastFailureAt: task.now,
    });
    expect(stored.iterations?.[0]?.status).toBe("completed");
  });

  it("charges both loops when one turn is the fire of both", async () => {
    // Two loops came due while the agent was busy, so one turn carries both wakes:
    // the failure belongs to both schedules, not to whichever iteration is newest.
    const { task, created } = await openTurns(["review the diff", "triage the issues"]);
    const firedAt = task.now;
    task.advance(2_000);
    await endAttempt(task.harness, { stopReason: "error", errorMessage: "fetch failed" });
    await task.harness.emit({ type: "agent_settled", aborted: false });

    for (const loop of created) {
      const after = await loopOf(task.harness, loop.id);
      expect(after.consecutiveFailures).toBe(1);
      expect(after.lastError).toBe("fetch failed");
      expect(after.lastFailureAt).toBe(task.now);
      expect((after.nextFireAt ?? 0) - firedAt).toBe(22_000);
    }
  });

  it("clears both streaks when the next turn of both loops finished", async () => {
    const { task, created } = await openTurns(["review the diff", "triage the issues"]);
    await endAttempt(task.harness, { stopReason: "error", errorMessage: "fetch failed" });
    await task.harness.emit({ type: "agent_settled", aborted: false });
    const failed = await loopOf(task.harness, created[0]?.id ?? "");
    expect(failed.consecutiveFailures).toBe(1);

    // The backed-off fires: due where the failure pushed them, and this turn lands.
    task.advance((failed.nextFireAt ?? task.now) - task.now);
    await task.harness.pump(task.now);
    const firedAt = task.now;
    await endAttempt(task.harness);
    await task.harness.emit({ type: "agent_settled", aborted: false });

    for (const loop of created) {
      const after = await loopOf(task.harness, loop.id);
      expect(after.consecutiveFailures).toBe(0);
      expect(after.lastError).toBeUndefined();
      expect(after.lastFailureAt).toBeUndefined();
      // A healthy fire ends the backoff: the next fire is one interval away.
      expect((after.nextFireAt ?? 0) - firedAt).toBe(10_000);
    }
  });
});
