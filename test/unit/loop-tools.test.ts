/**
 * The loop tools and the wake they send, driven through the extension exactly
 * as pi would drive it: registered tools, a fake clock, and an explicit pump.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { tempPathFor } from "../../src/tasks/base/atomic.js";
import {
  loopPromptPath,
  sessionTaskDirectory,
  taskRecordPath,
} from "../../src/tasks/base/runtime-state.js";
import {
  createHarness,
  type Harness,
  resultText,
  type Turn,
} from "../support/extension-harness.js";
import { makeTempDir } from "../support/processes.js";

interface LoopDetails {
  id: string;
  name: string;
  kind: string;
  status: string;
  schedule: string;
  prompt: string;
  promptFile?: string;
  promptWarning?: string;
  fires: number;
  maxFires?: number;
  nextFireAt?: number;
  lastFireAt?: number;
  endedAt?: number;
  untilNextFireMs?: number;
  outcome?: string;
  promptWrite?: { outcome: string; error?: string };
  iterations?: Array<{ fire: number; status: string }>;
  error?: string;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function setup(seed?: (turn: Turn) => Promise<void>) {
  const directory = await makeTempDir();
  cleanup.push(directory.dispose);
  let now = Date.UTC(2026, 0, 1, 9, 0, 0);
  const turn: Turn = { cwd: directory.path, sessionId: "session-loops" };
  if (seed !== undefined) await seed(turn);
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
  return detailsOf(await harness.call("pretty_task_loop_create", { schedule: "10s", ...params }));
}

describe("loop tools", () => {
  it("registers the loop tools and the wake renderer", async () => {
    const task = await setup();
    expect(task.harness.toolNames).toEqual(
      expect.arrayContaining([
        "pretty_task_loop_create",
        "pretty_task_loop_list",
        "pretty_task_loop_update",
        "pretty_task_loop_delete",
      ]),
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

    const promptFile = loopPromptPath(
      sessionTaskDirectory(task.turn.cwd, task.turn.sessionId),
      created.id,
    );
    expect(created).toMatchObject({
      kind: "prompt-loop",
      status: "running",
      schedule: "10s",
      prompt: "review the diff",
      promptFile,
      fires: 0,
      maxFires: 3,
      nextFireAt: task.now + 10_000,
      untilNextFireMs: 10_000,
    });
    // The seed the record keeps and the file the fires read start out the same.
    expect(await readFile(promptFile, "utf8")).toBe("review the diff");

    const listed = await task.harness.call("pretty_task_loop_list", {});
    const text = resultText(listed);
    expect(text).toContain("schedule: 10s");
    expect(text).toContain("next fire:");
    expect(text).toContain("(in 10.0s)");
    expect(text).toContain("fires: 0 / 3");
    expect(text).toContain("status: running");
    // The list names the file the fires read, not a copy of the text (ADR-0024).
    expect(text).toContain(`prompt file: ${promptFile}`);

    const one = await task.harness.call("pretty_task_loop_list", { id: created.id });
    expect(detailsOf(one).id).toBe(created.id);
    expect(detailsOf(one).promptFile).toBe(promptFile);
  });

  it("rejects a bad schedule with a clear example", async () => {
    const task = await setup();
    const result = await task.harness.call("pretty_task_loop_create", {
      schedule: "10 minutes",
      prompt: "keep going",
    });

    const text = resultText(result);
    expect(text).toContain('Invalid schedule "10 minutes"');
    expect(text).toContain("30s, 10m or 2h");
    expect(detailsOf(result).id).toBeUndefined();
  });

  it("takes a five-field cron expression and lists its raw text and next fire", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, {
      schedule: "0 9 * * 1-5",
      prompt: "review the day",
    });

    expect(created.schedule).toBe("0 9 * * 1-5");
    const nextFireAt = created.nextFireAt;
    if (nextFireAt === undefined) throw new Error("a cron loop must have a next fire");
    const next = new Date(nextFireAt);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect([1, 2, 3, 4, 5]).toContain(next.getDay());
    expect(nextFireAt).toBeGreaterThan(task.now);

    const text = resultText(await task.harness.call("pretty_task_loop_list", {}));
    expect(text).toContain("schedule: 0 9 * * 1-5");
    expect(text).toContain(`next fire: ${next.toISOString()}`);
  });

  it("waits for the cron instant, then recomputes the next one", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, {
      schedule: "0 9 * * 1-5",
      prompt: "review the day",
    });
    const first = created.nextFireAt;
    if (first === undefined) throw new Error("a cron loop must have a next fire");

    task.advance(first - task.now - 1);
    expect(await task.harness.pump(task.now)).toEqual([]);
    expect(task.harness.messages).toEqual([]);

    task.advance(1);
    expect(await task.harness.pump(task.now)).toHaveLength(1);
    expect(task.harness.messages).toHaveLength(1);

    const listed = detailsOf(await task.harness.call("pretty_task_loop_list", { id: created.id }));
    expect(listed.fires).toBe(1);
    if (listed.nextFireAt === undefined) throw new Error("the loop must keep a next fire");
    expect(listed.nextFireAt).toBeGreaterThan(first);
    expect(new Date(listed.nextFireAt).getHours()).toBe(9);
  });

  it("refuses a six-field cron expression and points at the interval shorthand", async () => {
    const task = await setup();
    const result = await task.harness.call("pretty_task_loop_create", {
      schedule: "0 0 9 * * 1-5",
      prompt: "keep going",
    });

    const text = resultText(result);
    expect(text).toContain('Invalid schedule "0 0 9 * * 1-5"');
    expect(text).toContain("six fields");
    expect(text).toContain("30s, 10m or 2h");
    expect(text).toContain("0 9 * * 1-5");
    expect(detailsOf(result).id).toBeUndefined();
  });

  it("refuses an invalid cron expression at create time and names both shapes", async () => {
    const task = await setup();
    const result = await task.harness.call("pretty_task_loop_create", {
      schedule: "0 25 * * *",
      prompt: "keep going",
    });

    const text = resultText(result);
    expect(text).toContain('Invalid schedule "0 25 * * *"');
    expect(text).toContain("30s, 10m or 2h");
    expect(text).toContain("0 9 * * 1-5");
    expect(detailsOf(result).id).toBeUndefined();
  });

  it("rejects a bad maxFires and a bad expiresIn", async () => {
    const task = await setup();
    const badMax = await task.harness.call("pretty_task_loop_create", {
      schedule: "10m",
      prompt: "keep going",
      maxFires: 0,
    });
    expect(resultText(badMax)).toContain("maxFires");

    const badExpiry = await task.harness.call("pretty_task_loop_create", {
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

    const listed = await task.harness.call("pretty_task_loop_list", { id: created.id });
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

  it("pauses, resumes, completes, and deletes through pretty_task_loop_update and pretty_task_loop_delete", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, { schedule: "10s", prompt: "keep going" });

    const paused = await task.harness.call("pretty_task_loop_update", {
      id: created.id,
      action: "pause",
    });
    expect(resultText(paused)).toContain("Paused loop");
    expect(detailsOf(paused)).toMatchObject({ status: "paused", outcome: "paused" });

    task.advance(30_000);
    expect(await task.harness.pump(task.now)).toEqual([]);
    expect(task.harness.messages).toEqual([]);

    const resumed = await task.harness.call("pretty_task_loop_update", {
      id: created.id,
      action: "resume",
    });
    expect(resultText(resumed)).toContain("Resumed loop");
    expect(detailsOf(resumed)).toMatchObject({
      status: "running",
      outcome: "resumed",
      nextFireAt: task.now + 10_000,
    });

    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toHaveLength(1);

    const completed = await task.harness.call("pretty_task_loop_update", {
      id: created.id,
      action: "complete",
    });
    expect(resultText(completed)).toContain("Completed loop");
    expect(detailsOf(completed)).toMatchObject({ status: "completed", outcome: "completed" });

    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toEqual([]);

    const deleted = await task.harness.call("pretty_task_loop_delete", { id: created.id });
    expect(resultText(deleted)).toContain("Deleted loop");
    expect(resultText(await task.harness.call("pretty_task_loop_list", {}))).toContain("No loops");
    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toEqual([]);
    expect(task.harness.messages).toHaveLength(1);
  });

  it("retunes a loop through pretty_task_loop_update and keeps its id, fires and iterations", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, { schedule: "10s", prompt: "keep going" });

    task.advance(10_000);
    await task.harness.pump(task.now);
    const before = detailsOf(await task.harness.call("pretty_task_loop_list", { id: created.id }));
    expect(before).toMatchObject({ fires: 1, schedule: "10s" });
    expect(before.iterations).toHaveLength(1);

    task.advance(5_000);
    const retuned = await task.harness.call("pretty_task_loop_update", {
      id: created.id,
      schedule: "1h",
    });
    expect(resultText(retuned)).toContain("Retuned loop");
    expect(detailsOf(retuned)).toMatchObject({
      id: created.id,
      outcome: "rescheduled",
      status: "running",
      schedule: "1h",
      fires: before.fires,
      lastFireAt: before.lastFireAt,
      nextFireAt: task.now + 3_600_000,
    });

    const listed = await task.harness.call("pretty_task_loop_list", { id: created.id });
    expect(resultText(listed)).toContain("schedule: 1h");
    expect(detailsOf(listed).iterations).toEqual(before.iterations);

    // The 10s slot the old schedule had picked does not fire; the 1h one does.
    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toEqual([]);
    task.advance(3_600_000 - 10_000);
    expect(await task.harness.pump(task.now)).toHaveLength(1);
  });

  it("retunes a paused loop through pretty_task_loop_update and leaves it paused", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, { schedule: "10s", prompt: "keep going" });
    await task.harness.call("pretty_task_loop_update", { id: created.id, action: "pause" });

    const retuned = await task.harness.call("pretty_task_loop_update", {
      id: created.id,
      schedule: "30m",
    });
    expect(resultText(retuned)).toContain("stays paused");
    expect(detailsOf(retuned)).toMatchObject({
      outcome: "rescheduled",
      status: "paused",
      schedule: "30m",
    });
    expect(detailsOf(retuned).nextFireAt).toBeUndefined();

    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toEqual([]);

    const resumed = await task.harness.call("pretty_task_loop_update", {
      id: created.id,
      action: "resume",
    });
    expect(detailsOf(resumed)).toMatchObject({
      status: "running",
      nextFireAt: task.now + 1_800_000,
    });
  });

  it("rejects an invalid schedule on pretty_task_loop_update with the message pretty_task_loop_create gives", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, { schedule: "10s", prompt: "keep going" });
    const rejectedCreate = await task.harness.call("pretty_task_loop_create", {
      schedule: "10 minutes",
      prompt: "keep going",
    });

    const rejectedUpdate = await task.harness.call("pretty_task_loop_update", {
      id: created.id,
      schedule: "10 minutes",
    });
    expect(resultText(rejectedUpdate)).toBe(resultText(rejectedCreate));
    expect(detailsOf(rejectedUpdate).error).toContain('Invalid schedule "10 minutes"');
    expect(detailsOf(rejectedUpdate).id).toBeUndefined();

    const unchanged = detailsOf(
      await task.harness.call("pretty_task_loop_list", { id: created.id }),
    );
    expect(unchanged).toMatchObject({
      schedule: "10s",
      status: "running",
      nextFireAt: created.nextFireAt,
    });

    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toHaveLength(1);
  });

  it("asks for an action, a schedule or a prompt when pretty_task_loop_update gets none", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, { schedule: "10s", prompt: "keep going" });

    const result = await task.harness.call("pretty_task_loop_update", { id: created.id });
    expect(resultText(result)).toContain("Give an action, a schedule or a prompt");
    expect(detailsOf(result).outcome).toBeUndefined();
    expect(detailsOf(result).error).toContain("Give an action, a schedule or a prompt");

    // The loop is untouched by the refusal, not merely unchanged in the reply.
    const listed = detailsOf(await task.harness.call("pretty_task_loop_list", { id: created.id }));
    expect(listed).toMatchObject({ schedule: "10s", status: "running" });
  });

  it("replaces a loop's prompt through pretty_task_loop_update and names the file it wrote", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, { schedule: "10s", prompt: "keep going" });
    task.advance(10_000);
    await task.harness.pump(task.now);
    const before = detailsOf(await task.harness.call("pretty_task_loop_list", { id: created.id }));
    expect(before).toMatchObject({ fires: 1 });
    expect(before.iterations).toHaveLength(1);

    const path = loopPromptPath(
      sessionTaskDirectory(task.turn.cwd, task.turn.sessionId),
      created.id,
    );
    const updated = await task.harness.call("pretty_task_loop_update", {
      id: created.id,
      prompt: "review only the parser module",
    });

    const said = resultText(updated);
    expect(said).toContain("Rewrote the prompt of loop");
    expect(said).toContain("its next fire is");
    expect(said).toContain("prompt text: replaced");
    // The reply names the one file it wrote, and keeps the seed and the file apart.
    expect(said).toContain(path);
    expect(detailsOf(updated)).toMatchObject({
      outcome: "prompt-updated",
      promptWrite: { outcome: "written" },
      promptFile: path,
      prompt: "keep going",
      fires: before.fires,
      lastFireAt: before.lastFireAt,
      nextFireAt: before.nextFireAt,
    });
    expect(await readFile(path, "utf8")).toBe("review only the parser module");

    // The history the update promised to keep is still there, and the next fire
    // sends the new wording.
    const listed = detailsOf(await task.harness.call("pretty_task_loop_list", { id: created.id }));
    expect(listed.iterations).toEqual(before.iterations);
    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toHaveLength(1);
    expect(task.harness.messages.at(-1)?.content).toBe("review only the parser module");
  });

  // A paused or finished loop cannot act on the new text, so the reply must not
  // promise a fire that will never happen ("its next fire is none" would be dead
  // information dressed up as news).
  it("does not promise a fire when the rewritten loop is paused or finished", async () => {
    const task = await setup();
    const paused = await createLoop(task.harness, { schedule: "10s", prompt: "keep going" });
    await task.harness.call("pretty_task_loop_update", { id: paused.id, action: "pause" });
    const pausedSaid = resultText(
      await task.harness.call("pretty_task_loop_update", { id: paused.id, prompt: "paused text" }),
    );
    expect(pausedSaid).toContain("Rewrote the prompt of loop");
    expect(pausedSaid).toContain("stays paused until resumed");
    expect(pausedSaid).not.toContain("its next fire is");

    const finished = await createLoop(task.harness, { schedule: "10s", prompt: "keep going" });
    await task.harness.call("pretty_task_loop_update", { id: finished.id, action: "complete" });
    const finishedSaid = resultText(
      await task.harness.call("pretty_task_loop_update", {
        id: finished.id,
        prompt: "finished text",
      }),
    );
    expect(finishedSaid).toContain("Rewrote the prompt of loop");
    expect(finishedSaid).toContain("will not fire again");
    expect(finishedSaid).not.toContain("its next fire is");

    // Both files did change; only the promise of a fire was wrong.
    const directory = sessionTaskDirectory(task.turn.cwd, task.turn.sessionId);
    expect(await readFile(loopPromptPath(directory, paused.id), "utf8")).toBe("paused text");
    expect(await readFile(loopPromptPath(directory, finished.id), "utf8")).toBe("finished text");
  });

  it("reports a prompt that could not be written through the result instead of throwing", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, { schedule: "10s", prompt: "keep going" });
    const path = loopPromptPath(
      sessionTaskDirectory(task.turn.cwd, task.turn.sessionId),
      created.id,
    );
    // A directory where the atomic write's temp file belongs: the write cannot land.
    await mkdir(tempPathFor(path));

    const updated = await task.harness.call("pretty_task_loop_update", {
      id: created.id,
      prompt: "review only the parser module",
    });

    const said = resultText(updated);
    expect(said).toContain("Could not replace the prompt");
    expect(said).toContain("not replaced");
    expect(detailsOf(updated).outcome).toBe("prompt-write-failed");
    expect(detailsOf(updated).promptWrite).toMatchObject({ outcome: "failed" });
    expect(detailsOf(updated).promptWrite?.error).toBeTruthy();
    // The old text is what the next fire sends, because it is what the file holds.
    expect(await readFile(path, "utf8")).toBe("keep going");
    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toHaveLength(1);
    expect(task.harness.messages.at(-1)?.content).toBe("keep going");
  });

  it("refuses a prompt on a command loop through the tool result", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, { schedule: "10s", command: "echo hi" });

    const result = await task.harness.call("pretty_task_loop_update", {
      id: created.id,
      prompt: "keep going",
    });

    expect(detailsOf(result).outcome).toBeUndefined();
    expect(detailsOf(result).error).toMatch(/runs a command, so it has no prompt file to rewrite/);
  });

  it("reloads a loop after a restart and keeps its fire count", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, { schedule: "10s", prompt: "keep going" });

    task.advance(10_000);
    expect(await task.harness.pump(task.now)).toHaveLength(1);

    const restarted = createHarness(task.turn, { now: () => task.now });
    await restarted.startSession();

    const listed = await restarted.call("pretty_task_loop_list", { id: created.id });
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

  it("loads a version 2 loop file, fires it, and rewrites it in the new version", async () => {
    const first = Date.UTC(2026, 0, 1, 9, 0, 10);
    const task = await setup(async (turn) => {
      const directory = sessionTaskDirectory(turn.cwd, turn.sessionId);
      await mkdir(directory, { recursive: true });
      await writeFile(
        taskRecordPath(directory),
        JSON.stringify({
          version: 2,
          tasks: [
            {
              id: "lp0001",
              kind: "loop",
              name: "legacy review",
              status: "running",
              createdAt: first - 20_000,
              schedule: "10s",
              prompt: "keep reviewing",
              fires: 2,
              maxFires: 5,
              nextFireAt: first,
              lastFireAt: first - 10_000,
            },
          ],
        }),
      );
    });

    await task.harness.startSession();
    task.advance(first - task.now);
    expect(await task.harness.pump(task.now)).toHaveLength(1);
    expect(task.harness.messages[0]?.content).toBe("keep reviewing");

    const listed = detailsOf(await task.harness.call("pretty_task_loop_list", { id: "lp0001" }));
    expect(listed).toMatchObject({
      id: "lp0001",
      kind: "prompt-loop",
      name: "legacy review",
      schedule: "10s",
      fires: 3,
      maxFires: 5,
    });

    const directory = sessionTaskDirectory(task.turn.cwd, task.turn.sessionId);
    const document = JSON.parse(await readFile(taskRecordPath(directory), "utf8")) as {
      version: number;
      tasks: Array<{ id: string; kind: string; nextFireAt?: number }>;
    };
    expect(document.version).toBe(5);
    expect(document.tasks[0]).toMatchObject({ id: "lp0001", kind: "prompt-loop" });
    expect(document.tasks[0]?.nextFireAt).toBeGreaterThan(first);
  });
  it("names a settled turn's verdict in the iteration listing, not completed (ticket 53)", async () => {
    const task = await setup();
    const created = await createLoop(task.harness, {
      schedule: "10s",
      prompt: "keep going",
    });

    // Close the loop's own turn as pi does, then fire the first real wake.
    await task.harness.emit({ type: "agent_start" });
    task.advance(10_000);
    await task.harness.pump(task.now);
    await task.harness.emit({ type: "agent_settled", aborted: false });

    // The provider gave up on this turn: a failed attempt, then the settle.
    await task.harness.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "…" }],
        stopReason: "error",
        errorMessage: "529 overloaded_error",
      },
    });
    await task.harness.emit({ type: "agent_settled", aborted: false });

    const listed = await task.harness.call("pretty_task_loop_list", { id: created.id });
    expect(resultText(listed)).toContain("fire 1 · failed");
    expect(resultText(listed)).not.toContain("fire 1 · completed");
  });
});
