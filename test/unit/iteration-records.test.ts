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

import { sessionTaskDirectory } from "../../src/tasks/base/runtime-state.js";
import { TaskStore } from "../../src/tasks/base/task-store.js";
import { DEFAULT_RETRY_BUDGET, retryBudget } from "../../src/tasks/loop/iterations.js";
import { createHarness, type Harness, resultText } from "../support/extension-harness.js";
import { makeTempDir } from "../support/processes.js";

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
  /** The provider retry the turn was on, when it was retrying (ticket #47). */
  retry?: { attempt: number; maxAttempts: number; status?: string };
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

async function setup(
  options: { callLimit?: number; historyLimit?: number; maxRetries?: number } = {},
) {
  const directory = await makeTempDir();
  cleanup.push(directory.dispose);
  let now = Date.UTC(2026, 0, 1, 9, 0, 0);
  const turn = { cwd: directory.path, sessionId: "session-iterations" };
  const harness = createHarness(turn, {
    now: () => now,
    ...(options.callLimit === undefined ? {} : { iterationCallLimit: options.callLimit }),
    ...(options.historyLimit === undefined ? {} : { iterationHistoryLimit: options.historyLimit }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
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
    await harness.call("pretty_task_loop_create", {
      schedule: "10s",
      prompt: "review the diff",
      ...params,
    }),
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

/** One loop's iterations as `pretty_task_loop_list id=…` reports them, newest first. */
async function iterationsOf(harness: Harness, id: string): Promise<IterationDetails[]> {
  const result = await harness.call("pretty_task_loop_list", { id });
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

    const text = resultText(await task.harness.call("pretty_task_loop_list", { id: created.id }));
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
    const text = resultText(await task.harness.call("pretty_task_loop_list", { id: created.id }));
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
    const all = resultText(await task.harness.call("pretty_task_loop_list", {}));
    expect(all).toContain("iterations: 1 (1 older dropped)");
  });

  it("binds the iteration to the wake's own turn, not to the turn running when it fired", async () => {
    const task = await setup();
    const created = await createLoop(task.harness);

    // The loop comes due while the agent is busy with a turn the user started.
    await task.harness.emit({ type: "agent_start" });
    task.advance(10_000);
    await task.harness.pump(task.now);
    await startCall(task.harness, "call-user", "bash", { command: "ls" });
    await endCall(task.harness, "call-user", "bash");

    // That turn is not the wake's turn: the pending iteration stays empty.
    const before = await iterationsOf(task.harness, created.id);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ fire: 1, calls: [] });

    // Settling closes the user's turn and sends the wake; its own turn records.
    task.advance(1_000);
    await task.harness.emit({ type: "agent_settled", aborted: false });
    await startCall(task.harness, "call-wake", "read", { path: "src/index.ts" });
    await endCall(task.harness, "call-wake", "read", { durationMs: 7 });
    await task.harness.emit({ type: "agent_settled", aborted: false });

    const [iteration] = await iterationsOf(task.harness, created.id);
    if (iteration === undefined) throw new Error("no iteration was recorded");
    expect(iteration).toMatchObject({ fire: 1, status: "completed" });
    expect(iteration.calls.map((call) => call.id)).toEqual(["call-wake"]);
  });

  it("does not leave a pending iteration running after a restart", async () => {
    const task = await setup();
    const created = await createLoop(task.harness);

    await task.harness.emit({ type: "agent_start" });
    task.advance(10_000);
    await task.harness.pump(task.now);

    // No settle: the process dies with the wake still queued. The next load
    // repairs a stored `running` iteration to `interrupted`, as everywhere else.
    const store = new TaskStore(sessionTaskDirectory(task.turn.cwd, task.turn.sessionId));
    const records = await store.load();
    const loop = records.find((record) => record.id === created.id);
    if (loop?.kind !== "prompt-loop") throw new Error("the loop was not persisted");
    expect(loop.iterations?.[0]).toMatchObject({ fire: 1, status: "interrupted" });
  });
});

/**
 * One assistant attempt ended, as pi reports it at `message_end`. The failed
 * attempt of a retried provider error is the only trace an extension gets: pi
 * emits no retry event (ticket #47).
 */
async function endAttempt(
  harness: Harness,
  outcome: { role?: string; stopReason?: string; errorMessage?: string } = {},
): Promise<void> {
  const role = outcome.role ?? "assistant";
  const message =
    role === "assistant"
      ? {
          role,
          content: [{ type: "text", text: "…" }],
          stopReason: outcome.stopReason ?? "stop",
          ...(outcome.errorMessage === undefined ? {} : { errorMessage: outcome.errorMessage }),
        }
      : { role, content: [{ type: "text", text: "…" }] };
  await harness.emit({ type: "message_end", message });
}

/**
 * A fire's turn, open: the wake left for pi and the turn it produced has not
 * settled. The settle in the middle closes the turn the test itself started and
 * sends the queued wake, which is what binds the iteration.
 */
async function openTurn(options: { maxRetries?: number } = {}) {
  const task = await setup(options);
  const created = await createLoop(task.harness);
  await task.harness.emit({ type: "agent_start" });
  task.advance(10_000);
  await task.harness.pump(task.now);
  await task.harness.emit({ type: "agent_settled", aborted: false });
  return { task, created };
}

describe("the provider retry of a turn", () => {
  it("attaches the failed attempt to the open iteration, in the record on disk", async () => {
    const { task, created } = await openTurn();
    await endAttempt(task.harness, {
      stopReason: "error",
      errorMessage: "529 overloaded_error: the provider is busy",
    });

    const [iteration] = await iterationsOf(task.harness, created.id);
    expect(iteration?.retry).toEqual({ attempt: 1, maxAttempts: 3, status: "529" });

    // The record only exists on disk: a reader must see the retry there too.
    const store = new TaskStore(sessionTaskDirectory(task.turn.cwd, task.turn.sessionId));
    const loop = (await store.load()).find((record) => record.id === created.id);
    if (loop?.kind !== "prompt-loop") throw new Error("the loop was not persisted");
    expect(loop.iterations?.[0]?.retry).toEqual({ attempt: 1, maxAttempts: 3, status: "529" });
  });

  it("counts each retry of the turn up to the budget pi was configured with", async () => {
    const { task, created } = await openTurn({ maxRetries: 5 });
    await endAttempt(task.harness, {
      stopReason: "error",
      errorMessage: "529 overloaded_error",
    });
    await endAttempt(task.harness, {
      stopReason: "error",
      errorMessage: "503 service unavailable",
    });

    const [iteration] = await iterationsOf(task.harness, created.id);
    expect(iteration?.retry).toEqual({ attempt: 2, maxAttempts: 5, status: "503" });
  });

  it("states the attempt without a status when the failure carried none", async () => {
    const { task, created } = await openTurn();
    await endAttempt(task.harness, { stopReason: "error", errorMessage: "fetch failed" });

    const [iteration] = await iterationsOf(task.harness, created.id);
    expect(iteration?.retry).toEqual({ attempt: 1, maxAttempts: 3 });
  });

  it("clears the retry when the attempt that follows succeeds", async () => {
    const { task, created } = await openTurn();
    await endAttempt(task.harness, { stopReason: "error", errorMessage: "529 overloaded_error" });
    const [retrying] = await iterationsOf(task.harness, created.id);
    expect(retrying?.retry).toBeDefined();

    await endAttempt(task.harness);

    const [recovered] = await iterationsOf(task.harness, created.id);
    expect(recovered?.status).toBe("running");
    expect(recovered?.retry).toBeUndefined();
  });

  it("clears the retry when the turn ends on the failure pi gave up on", async () => {
    const { task, created } = await openTurn();
    await endAttempt(task.harness, { stopReason: "error", errorMessage: "529 overloaded_error" });
    await task.harness.emit({ type: "agent_settled", aborted: false });

    const [iteration] = await iterationsOf(task.harness, created.id);
    expect(iteration?.status).toBe("completed");
    expect(iteration?.retry).toBeUndefined();
  });

  it("records nothing outside a fire's turn, or for a message that is not the assistant's", async () => {
    // No fire has opened an iteration here: the failed attempt belongs to a turn
    // the user started, and there is no iteration for it to land on.
    const task = await setup();
    await endAttempt(task.harness, { stopReason: "error", errorMessage: "529 overloaded_error" });
    expect(await iterationsOf(task.harness, "lp-missing")).toEqual([]);

    // A user message, and a tool result, are not failed attempts: only the
    // assistant's turn ends with a stop reason.
    const open = await openTurn();
    await endAttempt(open.task.harness, { role: "user", stopReason: "error" });
    const [iteration] = await iterationsOf(open.task.harness, open.created.id);
    expect(iteration?.retry).toBeUndefined();
  });

  it("counts nothing when pi's retries are budgeted at zero", async () => {
    // A zero budget means pi gives up at the first failure, so `retry 1/0` would
    // promise a retry that is never coming: the failed attempt records nothing.
    const { task, created } = await openTurn({ maxRetries: 0 });
    await endAttempt(task.harness, { stopReason: "error", errorMessage: "529 overloaded_error" });

    const [iteration] = await iterationsOf(task.harness, created.id);
    expect(iteration?.status).toBe("running");
    expect(iteration?.retry).toBeUndefined();
  });
});

describe("the retry budget", () => {
  it("reads pi's own count and falls back to pi's default when the key is absent", () => {
    expect(retryBudget({ retry: { maxRetries: 5 } })).toBe(5);
    expect(retryBudget({ retry: {} })).toBe(DEFAULT_RETRY_BUDGET);
    expect(retryBudget({})).toBe(DEFAULT_RETRY_BUDGET);
    expect(retryBudget(undefined)).toBe(DEFAULT_RETRY_BUDGET);
  });

  it("counts nothing while retries are disabled", () => {
    expect(retryBudget({ retry: { enabled: false, maxRetries: 3 } })).toBe(0);
    expect(retryBudget({ retry: { maxRetries: 0 } })).toBe(0);
  });
});
