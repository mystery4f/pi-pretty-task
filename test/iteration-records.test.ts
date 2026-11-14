/**
 * Iteration recording: every fire opens one child record on its loop, the tool
 * calls of the turn it wakes are recorded by call id, and the end of the turn
 * closes it (ADR-0002). The tests drive the extension through the pi events and
 * the loop tools, with no UI anywhere: that is the only boundary an iteration
 * has.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness, resultText } from "./support/extension-harness.js";
import { makeTempDir } from "./support/processes.js";

interface IterationCallDetails {
  id: string;
  tool: string;
  subject: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  error?: string;
}

interface IterationDetails {
  fire: number;
  status: string;
  startedAt: number;
  endedAt?: number;
  calls: IterationCallDetails[];
  droppedCalls: number;
}

interface LoopDetails {
  id: string;
  fires: number;
  iterations?: IterationDetails[];
  iterationCount?: number;
  droppedIterations?: number;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function setup(options: { callLimit?: number; historyLimit?: number } = {}) {
  const directory = await makeTempDir();
  cleanup.push(directory.dispose);
  let now = Date.UTC(2026, 0, 1, 9, 0, 0);
  const turn = { cwd: directory.path, sessionId: "session-iterations" };
  const harness = createHarness(turn, {
    now: () => now,
    ...(options.callLimit === undefined ? {} : { iterationCallLimit: options.callLimit }),
    ...(options.historyLimit === undefined ? {} : { iterationHistoryLimit: options.historyLimit }),
  });
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

function detailsOf<T>(result: { details: unknown }): T {
  return result.details as T;
}

async function createLoop(harness: Harness, params: Record<string, unknown> = {}) {
  const created = detailsOf<LoopDetails>(
    await harness.call("loop_create", { schedule: "10s", prompt: "review the diff", ...params }),
  );
  return created;
}

async function startCall(
  harness: Harness,
  id: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  await harness.emit({ type: "tool_execution_start", toolCallId: id, toolName, args });
}

async function endCall(
  harness: Harness,
  id: string,
  toolName: string,
  outcome: { isError?: boolean; result?: unknown; durationMs?: number } = {},
): Promise<void> {
  await harness.emit({
    type: "tool_execution_end",
    toolCallId: id,
    toolName,
    result: outcome.result ?? { ok: true },
    isError: outcome.isError ?? false,
    ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
  });
}

/** One loop's iterations as `loop_list id=…` reports them, newest first. */
async function iterationsOf(harness: Harness, id: string): Promise<IterationDetails[]> {
  const result = await harness.call("loop_list", { id });
  return detailsOf<LoopDetails>(result).iterations ?? [];
}

describe("iteration recording", () => {
  it("records every tool call of the turn a fire woke, not only background tasks", async () => {
    const task = await setup();
    const created = await createLoop(task.harness);

    // A 10s loop is due once its interval has passed: the fire opens the iteration.
    task.advance(10_000);
    await task.harness.pump(task.now);
    task.advance(1_000);
    await startCall(task.harness, "call-a", "bash", { command: "git status --short" });
    await endCall(task.harness, "call-a", "bash", { durationMs: 120 });
    await startCall(task.harness, "call-b", "read", { path: "src/index.ts" });
    await endCall(task.harness, "call-b", "read", { durationMs: 4 });
    await task.harness.emit({ type: "agent_settled", aborted: false });

    const iterations = await iterationsOf(task.harness, created.id);
    expect(iterations).toHaveLength(1);
    const [iteration] = iterations;
    if (iteration === undefined) throw new Error("no iteration was recorded");
    expect(iteration).toMatchObject({ fire: 1, status: "completed", droppedCalls: 0 });
    expect(iteration.endedAt).toBe(task.now);
    expect(iteration.calls.map((call) => call.tool)).toEqual(["bash", "read"]);
    expect(iteration.calls[0]).toMatchObject({
      id: "call-a",
      subject: "git status --short",
      status: "completed",
      durationMs: 120,
    });
    expect(iteration.calls[1]).toMatchObject({
      id: "call-b",
      subject: "src/index.ts",
      status: "completed",
      durationMs: 4,
    });

    const text = resultText(await task.harness.call("loop_list", { id: created.id }));
    expect(text).toContain("fire 1");
    expect(text).toContain("git status --short");
    expect(text).toContain("src/index.ts");
    expect(text).toContain("completed");
  });

  it("pairs parallel calls to their results by call id, never by order", async () => {
    const task = await setup();
    const created = await createLoop(task.harness);

    // A 10s loop is due once its interval has passed: the fire opens the iteration.
    task.advance(10_000);
    await task.harness.pump(task.now);
    // Starts arrive in source order, ends in completion order: the second call
    // finishes first, and only that one failed.
    await startCall(task.harness, "call-first", "bash", { command: "npm test" });
    await startCall(task.harness, "call-second", "bash", { command: "npm run lint" });
    await endCall(task.harness, "call-second", "bash", {
      isError: true,
      result: { content: [{ type: "text", text: "biome: 3 errors" }] },
    });
    await endCall(task.harness, "call-first", "bash", { result: { exitCode: 0 } });
    await task.harness.emit({ type: "agent_settled", aborted: false });

    const [iteration] = await iterationsOf(task.harness, created.id);
    if (iteration === undefined) throw new Error("no iteration was recorded");
    const byId = new Map(iteration.calls.map((call) => [call.id, call]));
    expect(byId.get("call-first")).toMatchObject({
      tool: "bash",
      subject: "npm test",
      status: "completed",
    });
    expect(byId.get("call-second")).toMatchObject({
      tool: "bash",
      subject: "npm run lint",
      status: "failed",
    });
    expect(byId.get("call-second")?.error).toContain("biome: 3 errors");
    expect(byId.get("call-first")?.error).toBeUndefined();
  });

  it("records nothing for a tool call made outside the turn a fire woke", async () => {
    const task = await setup();
    const created = await createLoop(task.harness);

    await startCall(task.harness, "call-elsewhere", "bash", { command: "ls" });
    await endCall(task.harness, "call-elsewhere", "bash");

    expect(await iterationsOf(task.harness, created.id)).toEqual([]);
  });
  it("closes an aborted turn as aborted, and the call still running with it", async () => {
    const task = await setup();
    const created = await createLoop(task.harness);

    task.advance(10_000);
    await task.harness.pump(task.now);
    await startCall(task.harness, "call-done", "bash", { command: "npm run build" });
    await endCall(task.harness, "call-done", "bash", { durationMs: 30 });
    await startCall(task.harness, "call-lost", "bash", { command: "sleep 600" });
    task.advance(500);
    await task.harness.emit({ type: "agent_settled", aborted: true });

    const [iteration] = await iterationsOf(task.harness, created.id);
    if (iteration === undefined) throw new Error("no iteration was recorded");
    expect(iteration).toMatchObject({ status: "aborted", endedAt: task.now });
    const byId = new Map(iteration.calls.map((call) => [call.id, call]));
    expect(byId.get("call-done")).toMatchObject({ status: "completed", durationMs: 30 });
    // A call still running when the run was aborted cannot end: it is marked,
    // not left looking like work in progress.
    expect(byId.get("call-lost")).toMatchObject({
      status: "aborted",
      endedAt: task.now,
      durationMs: 500,
    });
  });

  it("caps the calls it keeps and states how many it dropped", async () => {
    const task = await setup({ callLimit: 2 });
    const created = await createLoop(task.harness);

    task.advance(10_000);
    await task.harness.pump(task.now);
    for (const command of ["first", "second", "third"]) {
      const id = `call-${command}`;
      await startCall(task.harness, id, "bash", { command });
      await endCall(task.harness, id, "bash", { durationMs: 5 });
    }
    await task.harness.emit({ type: "agent_settled", aborted: false });

    const [iteration] = await iterationsOf(task.harness, created.id);
    if (iteration === undefined) throw new Error("no iteration was recorded");
    expect(iteration.droppedCalls).toBe(1);
    expect(iteration.calls.map((call) => call.subject)).toEqual(["second", "third"]);
    const text = resultText(await task.harness.call("loop_list", { id: created.id }));
    expect(text).toContain("+1 earlier calls dropped");
  });

  it("keeps the newest iterations only, and states how many older ones it dropped", async () => {
    const task = await setup({ historyLimit: 1 });
    const created = await createLoop(task.harness);

    for (let fire = 1; fire <= 2; fire += 1) {
      task.advance(10_000);
      await task.harness.pump(task.now);
      await task.harness.emit({ type: "agent_settled", aborted: false });
    }

    const iterations = await iterationsOf(task.harness, created.id);
    expect(iterations.map((iteration) => iteration.fire)).toEqual([2]);
    // The loop's own listing says the history is cut, wherever it is read from.
    const all = resultText(await task.harness.call("loop_list", {}));
    expect(all).toContain("iterations: 1 (1 older dropped)");
  });
});
