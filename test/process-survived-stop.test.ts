/**
 * A kill that loses: the supervisor can answer `tree-survived`, and that answer is
 * not an ending. The record stays running, the reason that asked for the kill stays
 * with it, the kill is tried again, and a chain whose step survived does not report
 * a clean stop.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskScope } from "../src/tasks/base/runtime-state.js";
import { TaskSessions } from "../src/tasks/base/task-sessions.js";
import { ChainTasks, type ChainTaskView } from "../src/tasks/chain/chain-tasks.js";
import {
  ProcessTasks,
  type ProcessTasksOptions,
  type ProcessTaskView,
} from "../src/tasks/process/process-tasks.js";
import { processTaskTools } from "../src/tasks/process/tools.js";
import { fakeSupervisor } from "./support/fake-supervisor.js";
import { makeTempDir, waitFor } from "./support/processes.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** The stores as the extension wires them, over one fake supervisor. */
function makeStores(options: Pick<ProcessTasksOptions, "survivedRetryMs">) {
  const sessions = new TaskSessions();
  const supervisor = fakeSupervisor();
  const processes = new ProcessTasks({
    sessions,
    supervise: supervisor.supervise,
    ...options,
    onFinish: (view: ProcessTaskView) => {
      void chainTasks.advance(view);
    },
  });
  const chainTasks = new ChainTasks({
    sessions,
    processes: () => processes,
    onFinish: (_view: ChainTaskView) => {},
  });
  return { sessions, processes, chainTasks, supervisor };
}

/** Run `bg_kill` on one id the way the tool does, and return what it said. */
async function kill(
  stores: ReturnType<typeof makeStores>,
  scope: TaskScope,
  id: string,
): Promise<string> {
  const tool = processTaskTools(stores.processes, stores.chainTasks).find(
    (candidate) => candidate.name === "bg_kill",
  );
  if (tool === undefined) throw new Error("bg_kill is not registered");
  const ctx = {
    cwd: scope.cwd,
    sessionManager: { getSessionId: () => scope.sessionId },
  } as unknown as ExtensionToolContext;
  const result = await tool.execute("call-bg-kill", { id }, undefined, undefined, ctx);
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

describe("a stop whose tree survived", () => {
  it("leaves the task running with the reason, so its eventual exit is still the kill", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const stores = makeStores({});
    const scope: TaskScope = { cwd: dir.path, sessionId: "session-survived-stop" };
    const task = await stores.processes.start({ ...scope, command: "sleep 1", name: "stuck" });
    const fake = stores.supervisor.processes[0];
    if (fake === undefined) throw new Error("the task must be supervised");
    fake.survive = true;

    const stopped = await stores.processes.stop(scope, task.id, { reason: "user" });

    expect(stopped?.outcome).toBe("tree-survived");
    expect(stopped?.detail).toBe("the tree did not answer");
    const running = (await stores.processes.get(scope, task.id))?.task;
    // Nothing ended: the record still says running, and it says why it is still here.
    expect(running?.status).toBe("running");
    expect(running?.endedAt).toBeUndefined();
    expect(running?.killReason).toBeUndefined();
    expect(running?.error).toContain("the tree did not answer");

    // The reason was kept, so the exit the tree eventually makes is the kill the
    // user asked for — not a task that ended by itself.
    fake.end(0);
    await waitFor("the surviving tree to exit", async () => {
      const view = await stores.processes.get(scope, task.id);
      return view?.task.status === "killed";
    });
    expect((await stores.processes.get(scope, task.id))?.task.killReason).toBe("user");
  });

  it("tries the kill again when a timed-out tree survives, and keeps the timeout reason", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const stores = makeStores({ survivedRetryMs: 20 });
    const scope: TaskScope = { cwd: dir.path, sessionId: "session-survived-timeout" };
    const task = await stores.processes.start({
      ...scope,
      command: "sleep 1",
      name: "slow",
      timeoutMs: 10,
    });
    const fake = stores.supervisor.processes[0];
    if (fake === undefined) throw new Error("the task must be supervised");
    fake.survive = true;

    await waitFor("the runtime cap to ask for a kill", () => fake.stops >= 1);
    // The deadline has not been honoured, so it is armed again instead of forgotten.
    await waitFor("the cap to ask again", () => fake.stops >= 2);

    fake.survive = false;
    await waitFor("the retried kill to end the task", async () => {
      const view = await stores.processes.get(scope, task.id);
      return view?.task.status === "killed";
    });
    expect((await stores.processes.get(scope, task.id))?.task.killReason).toBe("timeout");
  });

  it("treats an output-capped tree that survives as still capped", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const stores = makeStores({ survivedRetryMs: 20 });
    const scope: TaskScope = { cwd: dir.path, sessionId: "session-survived-cap" };
    const task = await stores.processes.start({ ...scope, command: "yes", name: "loud" });
    const fake = stores.supervisor.processes[0];
    if (fake === undefined) throw new Error("the task must be supervised");
    fake.survive = true;

    fake.options.onOutputCap?.();
    await waitFor("the output cap to ask for a kill", () => fake.stops >= 1);
    await waitFor("the cap to ask again", () => fake.stops >= 2);
    expect((await stores.processes.get(scope, task.id))?.task.error).toContain(
      "the tree did not answer",
    );

    fake.survive = false;
    await waitFor("the retried kill to end the task", async () => {
      const view = await stores.processes.get(scope, task.id);
      return view?.task.status === "killed";
    });
    expect((await stores.processes.get(scope, task.id))?.task.killReason).toBe("output_cap");
  });

  it("reports a surviving step as a surviving chain stop, not a clean one", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const stores = makeStores({});
    const scope: TaskScope = { cwd: dir.path, sessionId: "session-survived-chain" };
    const first = await stores.processes.start({ ...scope, command: "sleep 1", name: "first" });
    const queued = await stores.chainTasks.enqueue(scope, first.id, {
      command: "sleep 1",
      name: "second",
    });
    const fake = stores.supervisor.processes[0];
    if (fake === undefined) throw new Error("the step must be supervised");
    fake.survive = true;

    const stopped = await stores.chainTasks.stop(scope, queued.chain.id);

    expect(stopped?.outcome).toBe("tree-survived");
    expect(stopped?.detail).toBe("the tree did not answer");
    // The step is still out there, so the chain cannot claim it was stopped.
    expect(stopped?.step?.task.status).toBe("running");
    const chain = await stores.chainTasks.get(scope, queued.chain.id);
    expect(chain?.task.status).toBe("killed");
  });

  it("says in bg_kill that the chain ended but its step could not be stopped", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const stores = makeStores({});
    const scope: TaskScope = { cwd: dir.path, sessionId: "session-survived-chain-report" };
    const first = await stores.processes.start({ ...scope, command: "sleep 1", name: "first" });
    const queued = await stores.chainTasks.enqueue(scope, first.id, {
      command: "sleep 1",
      name: "second",
    });
    const fake = stores.supervisor.processes[0];
    if (fake === undefined) throw new Error("the step must be supervised");
    fake.survive = true;

    const said = await kill(stores, scope, queued.chain.id);

    expect(said).toContain("steps behind it will not run");
    expect(said).toContain(`its running step ${first.id} could not be stopped`);
    expect(said).toContain("the tree did not answer");
    expect(said).not.toContain(`Stopped chain ${queued.chain.id}`);
  });

  it("says in bg_kill that a single task outlived its kill", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const stores = makeStores({});
    const scope: TaskScope = { cwd: dir.path, sessionId: "session-survived-report" };
    const task = await stores.processes.start({ ...scope, command: "sleep 1", name: "stuck" });
    const fake = stores.supervisor.processes[0];
    if (fake === undefined) throw new Error("the task must be supervised");
    fake.survive = true;

    const said = await kill(stores, scope, task.id);

    expect(said).toContain(`Background task ${task.id} could not be stopped`);
    expect(said).toContain("the tree did not answer");
    // The record still says running, and the note it carries is in the answer.
    expect(said).toContain("status: running");
    expect(said).toContain("could not be stopped: the tree did not answer");
  });
});
