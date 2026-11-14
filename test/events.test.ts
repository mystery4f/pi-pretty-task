/**
 * Extension seam: what another extension sees (issue #23). A task ending and a
 * loop firing are published on pi's shared event bus, so a listener can react
 * without polling this extension's store — and a listener that misbehaves must
 * never become this extension's problem.
 *
 * The tests listen on the harness's bus, which is pi's own, and read the store
 * file from disk inside the listener: that is the only way to prove the event
 * arrives after the record it describes.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readFileSync } from "node:fs";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
  LOOP_FIRED_EVENT,
  type LoopFiredEvent,
  publishTaskFinished,
  TASK_FINISHED_EVENT,
  type TaskFinishedEvent,
  taskFinishedEvent,
} from "../src/tasks/base/events.js";
import { sessionTaskDirectory, taskRecordPath } from "../src/tasks/base/runtime-state.js";
import type { Task } from "../src/tasks/base/task.js";
import { createHarness, type Harness, resultText, type Turn } from "./support/extension-harness.js";
import { killTree, makeTempDir, waitFor, writeScript } from "./support/processes.js";

interface TaskDetails {
  id: string;
  status: string;
  pid?: number;
}

interface LoopDetails {
  id: string;
  name: string;
  kind: string;
  status: string;
  nextFireAt?: number;
}

interface FireDetails {
  fire: number;
  outcome: string;
  taskId?: string;
}

const cleanup: Array<() => Promise<void>> = [];
const spawned: number[] = [];

afterEach(async () => {
  while (spawned.length > 0) await killTree(spawned.pop());
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/**
 * One temp directory and a harness whose bus a test listens on. The clock is
 * pinned so a pump lands on a fire slot; a test that measures a real runtime
 * asks for the wall clock instead.
 */
async function setup(options: { realClock?: boolean } = {}) {
  const directory = await makeTempDir();
  cleanup.push(directory.dispose);
  let now = Date.UTC(2026, 0, 1, 9, 0, 0);
  const turn: Turn = { cwd: directory.path, sessionId: "session-events" };
  const harness = createHarness(turn, options.realClock === true ? {} : { now: () => now });
  const finished: TaskFinishedEvent[] = [];
  const fired: LoopFiredEvent[] = [];
  harness.events.on(TASK_FINISHED_EVENT, (data) => {
    finished.push(data as TaskFinishedEvent);
  });
  harness.events.on(LOOP_FIRED_EVENT, (data) => {
    fired.push(data as LoopFiredEvent);
  });
  return {
    directory,
    turn,
    harness,
    finished,
    fired,
    /** The store file a listener would read to find a record. */
    recordPath: taskRecordPath(sessionTaskDirectory(turn.cwd, turn.sessionId)),
    advance(ms: number): void {
      now += ms;
    },
    get now(): number {
      return now;
    },
  };
}

/** The task records currently on disk for this session. */
function tasksOnDisk(recordPath: string): Task[] {
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as { tasks?: Task[] };
  return record.tasks ?? [];
}

/** Start a task through `bg_run` and wait until it has ended. */
async function runToEnd(harness: Harness, command: string, name: string): Promise<TaskDetails> {
  const result = await harness.call("bg_run", { name, command });
  const details = result.details as TaskDetails;
  if (details.pid !== undefined) spawned.push(details.pid);
  await waitFor("the task to end", async () => {
    const status = await harness.call("bg_status", { id: details.id });
    return (status.details as TaskDetails).status !== "running";
  });
  return details;
}

/** Create a command loop, advance the pinned clock to its slot, and pump once. */
async function fireCmdLoop(
  task: { advance(ms: number): void; now: number; harness: Harness },
  params: Record<string, unknown>,
): Promise<LoopDetails> {
  const created = (await task.harness.call("loop_create", { schedule: "10s", ...params }))
    .details as LoopDetails;
  task.advance(Math.max(0, (created.nextFireAt ?? task.now) - task.now));
  await task.harness.pump(task.now);
  return created;
}

describe("task-finished event", () => {
  it("publishes one event per ending, with the fields a listener acts on", async () => {
    // The wall clock: a real runtime is what makes `durationMs` mean anything.
    const task = await setup({ realClock: true });
    const command = await writeScript(task.directory.path, "done.js", "console.log('finished');\n");

    const ended = await runToEnd(task.harness, command, "greeting");
    await waitFor("the finished event", () => task.finished.length > 0);

    expect(task.finished[0]).toEqual({
      id: ended.id,
      kind: "process",
      name: "greeting",
      status: "completed",
      exitCode: 0,
      durationMs: expect.any(Number),
    });
    expect(task.finished[0]?.durationMs).toBeGreaterThan(0);
  });

  it("publishes exactly one event for an ending, never two", async () => {
    const task = await setup();
    const command = await writeScript(task.directory.path, "once.js", "console.log('once');\n");

    await runToEnd(task.harness, command, "once");
    await waitFor("the finished event", () => task.finished.length > 0);
    // A late exit or a second observer must not announce the same ending again.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(task.finished).toHaveLength(1);
  });

  it("publishes after the record is on disk, so a listener finds the ending", async () => {
    const task = await setup();
    const command = await writeScript(task.directory.path, "persisted.js", "console.log('ok');\n");
    const seen: Array<{ status?: string; endedAt?: number } | undefined> = [];
    // Read the file at the instant the event arrives: the ending has to be there
    // already, not a tick later.
    task.harness.events.on(TASK_FINISHED_EVENT, (data) => {
      const id = (data as TaskFinishedEvent).id;
      seen.push(tasksOnDisk(task.recordPath).find((entry) => entry.id === id));
    });

    const ended = await runToEnd(task.harness, command, "persisted");
    await waitFor("the listener to read the record", () => seen.length > 0);

    expect(seen[0]).toMatchObject({
      id: ended.id,
      status: "completed",
      endedAt: expect.any(Number),
    });
  });

  it("carries no output text and no environment values", async () => {
    const task = await setup();
    const command = await writeScript(
      task.directory.path,
      "secret.js",
      "console.log('secret-output-marker');\n",
    );

    await runToEnd(task.harness, command, "secret");
    await waitFor("the finished event", () => task.finished.length > 0);
    const event = task.finished[0] as TaskFinishedEvent;

    // The field set is the contract: anything beyond it would be a leak waiting
    // to happen, so the assertion is exact rather than a subset.
    expect(Object.keys(event).sort()).toEqual([
      "durationMs",
      "exitCode",
      "id",
      "kind",
      "name",
      "status",
    ]);
    const wire = JSON.stringify(event);
    expect(wire).not.toContain("secret-output-marker");
    expect(wire).not.toContain(task.directory.path);
    expect(wire).not.toContain("PI_PRETTY_TASK");
  });
});

describe("loop-fired event", () => {
  it("names the iteration an llm-loop fire opened", async () => {
    const task = await setup();
    const created = (
      await task.harness.call("loop_create", {
        schedule: "10s",
        prompt: "keep going",
        name: "ticker",
      })
    ).details as LoopDetails;

    task.advance(Math.max(0, (created.nextFireAt ?? task.now) - task.now));
    await task.harness.pump(task.now);

    expect(task.fired).toHaveLength(1);
    const event = task.fired[0] as LoopFiredEvent;
    expect(event).toEqual({
      kind: "llm-loop",
      id: created.id,
      name: "ticker",
      fire: 1,
      at: task.now,
      iteration: { fire: 1, startedAt: task.now },
    });
    // No child process: an llm loop never spawns one.
    expect("taskId" in event).toBe(false);
  });

  it("publishes the fire after the iteration is on disk", async () => {
    const task = await setup();
    const created = (
      await task.harness.call("loop_create", {
        schedule: "10s",
        prompt: "keep going",
        name: "ticker",
      })
    ).details as LoopDetails;
    const seen: Array<{ fire: number; status: string } | undefined> = [];
    task.harness.events.on(LOOP_FIRED_EVENT, (data) => {
      const event = data as LoopFiredEvent;
      const loop = tasksOnDisk(task.recordPath).find((entry) => entry.id === event.id);
      const iteration =
        loop?.kind === "llm-loop"
          ? loop.iterations.find((entry) => entry.fire === event.fire)
          : undefined;
      seen.push(iteration);
    });

    task.advance(Math.max(0, (created.nextFireAt ?? task.now) - task.now));
    await task.harness.pump(task.now);
    await waitFor("the listener to read the iteration", () => seen.length > 0);

    // The iteration is the record the event points at, and it is already open.
    expect(seen[0]).toMatchObject({ fire: 1, status: "running" });
  });

  it("names the child task a cmd-loop fire started", async () => {
    const task = await setup();
    const script = await writeScript(task.directory.path, "fire.js", "console.log('fired');\n");
    const created = await fireCmdLoop(task, { command: script, name: "watcher" });

    expect(task.fired).toHaveLength(1);
    const event = task.fired[0] as LoopFiredEvent;
    const listed = (await task.harness.call("loop_list", { id: created.id })).details as {
      fireHistory?: FireDetails[];
    };
    const child = listed.fireHistory?.[0]?.taskId;
    if (child === undefined) throw new Error("a cmd fire starts a child process");

    expect(event).toEqual({
      kind: "cmd-loop",
      id: created.id,
      name: "watcher",
      fire: 1,
      at: task.now,
      taskId: child,
    });
    // The named task is real and reachable through the ordinary task tools.
    expect(resultText(await task.harness.call("bg_status", { id: child }))).toContain(
      "kind: process",
    );
    // The child is watched so a failed assertion cannot leave it running.
    const status = (await task.harness.call("bg_status", { id: child })).details as TaskDetails;
    if (status.pid !== undefined) spawned.push(status.pid);
  });
});

describe("a listener that throws", () => {
  it("does not break the ending or the schedule", async () => {
    const task = await setup();
    task.harness.events.on(TASK_FINISHED_EVENT, () => {
      throw new Error("listener exploded");
    });
    task.harness.events.on(LOOP_FIRED_EVENT, () => {
      throw new Error("listener exploded");
    });

    const command = await writeScript(task.directory.path, "after.js", "console.log('after');\n");
    const ended = await runToEnd(task.harness, command, "after");
    // The ending is recorded and reported whatever the listener did.
    const status = (await task.harness.call("bg_status", { id: ended.id })).details as TaskDetails;
    expect(status.status).toBe("completed");

    const script = await writeScript(task.directory.path, "repeating.js", "console.log('tick');\n");
    const created = await fireCmdLoop(task, { command: script, name: "repeating" });

    // The loop still fires, and still fires again afterwards: the throwing
    // listener cost the schedule nothing.
    expect(task.fired).toHaveLength(1);
    await waitFor("the first fire to end", async () => {
      const listed = (await task.harness.call("loop_list", { id: created.id })).details as {
        fireHistory?: FireDetails[];
      };
      return listed.fireHistory?.[0]?.outcome === "success";
    });
    task.advance(10_000);
    await task.harness.pump(task.now);
    expect(task.fired.map((event) => event.fire)).toEqual([1, 2]);
  });

  it("does not turn a bus failure into a task failure", () => {
    // A bus can refuse the emit itself — pi's own refuses once the extension is
    // deactivated — and the ending has already happened by then.
    const closed: EventBus = {
      emit() {
        throw new Error("extension is not active");
      },
      on() {
        return () => undefined;
      },
    };

    expect(() =>
      publishTaskFinished(closed, {
        task: {
          id: "bg-abcde",
          kind: "process",
          name: "greeting",
          status: "completed",
          createdAt: 1,
          updatedAt: 2,
          exitCode: 0,
        },
        elapsedMs: 12,
      }),
    ).not.toThrow();
  });
});

describe("taskFinishedEvent", () => {
  it("omits the exit code for a kind that has none", () => {
    const event = taskFinishedEvent({
      task: {
        id: "ll-abcde",
        kind: "llm-loop",
        name: "ticker",
        status: "completed",
        createdAt: 1,
        updatedAt: 2,
      },
      elapsedMs: 5,
    });

    expect(event).toEqual({
      id: "ll-abcde",
      kind: "llm-loop",
      name: "ticker",
      status: "completed",
      durationMs: 5,
    });
    // Absent, not `undefined`: a listener serializing the event sees no empty key.
    expect("exitCode" in event).toBe(false);
  });

  it("keeps a signal's `null` exit code distinct from a missing one", () => {
    const event = taskFinishedEvent({
      task: {
        id: "bg-abcde",
        kind: "process",
        name: "killed",
        status: "killed",
        createdAt: 1,
        updatedAt: 2,
        exitCode: null,
      },
      elapsedMs: 7,
    });

    expect(event.exitCode).toBeNull();
  });
});
