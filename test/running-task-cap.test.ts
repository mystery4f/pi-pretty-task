/**
 * The running-task cap: `docs/scope-v1.md` promises at most 20 running process
 * tasks per session, and a fire or a chain step is a process too, so it meets the
 * same ceiling. The store refuses the task that would cross it, and the two
 * callers that start work out of sight — a command loop's fire and a chain's next
 * step — end with the reason written where the reader looks.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { afterEach, describe, expect, it } from "vitest";
import type { TaskScope } from "../src/tasks/base/runtime-state.js";
import { MAX_RUNNING_TASKS_ENV } from "../src/tasks/base/settings.js";
import { TaskSessions } from "../src/tasks/base/task-sessions.js";
import { ChainTasks, type ChainTaskView } from "../src/tasks/chain/chain-tasks.js";
import {
  ProcessTasks,
  type ProcessTasksOptions,
  type ProcessTaskView,
} from "../src/tasks/process/process-tasks.js";
import type { RunningProcess, StartProcessOptions } from "../src/tasks/process/supervisor.js";
import { createHarness, resultText } from "./support/extension-harness.js";
import { killTree, makeTempDir, waitFor, writeScript } from "./support/processes.js";

const cleanup: Array<() => Promise<void>> = [];
const spawned: number[] = [];

afterEach(async () => {
  while (spawned.length > 0) await killTree(spawned.pop());
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** One supervised command a test answers for, instead of a real process. */
interface FakeProcess {
  readonly running: RunningProcess;
  /** How many stops reached this command. */
  stops: number;
  /** Answer every later stop with `tree-survived` and stay alive. */
  survive: boolean;
  /** End the command as a real exit would. */
  end(exitCode?: number | null): void;
}

/**
 * A supervisor seam that spawns nothing: the cap counts records, not processes,
 * so the store can be driven without a process per count — and the count stays
 * put instead of moving while the test talks.
 */
function fakeSupervisor(): {
  supervise: (options: StartProcessOptions) => RunningProcess;
  processes: FakeProcess[];
} {
  const processes: FakeProcess[] = [];
  const supervise = (_options: StartProcessOptions): RunningProcess => {
    let settle: (exit: { exitCode: number | null; signal: NodeJS.Signals | null }) => void =
      () => {};
    const exit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        settle = resolve;
      },
    );
    const fake: FakeProcess = {
      stops: 0,
      survive: false,
      running: {
        pid: undefined,
        exit,
        bytesWritten: () => 0,
        signalled: () => fake.stops > 0,
        stop: async () => {
          fake.stops += 1;
          if (fake.survive) {
            return { outcome: "tree-survived", tookMs: 1, detail: "the tree did not answer" };
          }
          // A killed command exits on its own just after the answer.
          setImmediate(() => {
            settle({ exitCode: null, signal: "SIGTERM" });
          });
          return { outcome: "stopped", tookMs: 1 };
        },
      },
      end: (exitCode = 0) => {
        settle({ exitCode, signal: null });
      },
    };
    processes.push(fake);
    return fake.running;
  };
  return { supervise, processes };
}

/** The stores as the extension wires them, over one fake supervisor. */
function makeStores(options: Pick<ProcessTasksOptions, "maxRunningTasks">) {
  const sessions = new TaskSessions();
  const supervisor = fakeSupervisor();
  const chainEndings: ChainTaskView[] = [];
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
    onFinish: (view: ChainTaskView) => chainEndings.push(view),
  });
  return { sessions, processes, chainTasks, chainEndings, supervisor };
}

describe("the running-task cap", () => {
  it("refuses the task after the ceiling and leaves no record behind", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const stores = makeStores({ maxRunningTasks: 2 });
    const scope: TaskScope = { cwd: dir.path, sessionId: "session-cap-refuse" };

    await stores.processes.start({ ...scope, command: "sleep 1", name: "first" });
    await stores.processes.start({ ...scope, command: "sleep 1", name: "second" });

    await expect(
      stores.processes.start({ ...scope, command: "sleep 1", name: "third" }),
    ).rejects.toThrow(/already has 2 running process tasks; the limit is 2/);
    // A refused start is not a task that failed: nothing was written to explain.
    expect(await stores.processes.listAll(scope)).toHaveLength(2);
  });

  it("counts a child task against the same ceiling", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const stores = makeStores({ maxRunningTasks: 2 });
    const scope: TaskScope = { cwd: dir.path, sessionId: "session-cap-child" };

    const parent = await stores.processes.start({
      ...scope,
      command: "sleep 1",
      name: "parent",
    });
    // A fire is a child of its loop and a chain step a child of its chain: one
    // process record either way, so the same ceiling has to hold it (ADR-0014).
    await stores.processes.start({
      ...scope,
      command: "sleep 1",
      name: "fire",
      parentId: parent.id,
      fire: 1,
    });

    expect(await stores.processes.list(scope)).toHaveLength(1);
    expect(await stores.processes.listAll(scope)).toHaveLength(2);
    await expect(
      stores.processes.start({ ...scope, command: "sleep 1", name: "next" }),
    ).rejects.toThrow(/limit is 2/);
  });

  it("ends a step that cannot start, with the reason, instead of leaving it waiting", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const stores = makeStores({ maxRunningTasks: 1 });
    const scope: TaskScope = { cwd: dir.path, sessionId: "session-cap-step" };

    await stores.processes.start({ ...scope, command: "sleep 1", name: "holder" });
    const step = await stores.processes.queueStep({
      ...scope,
      command: "sleep 1",
      name: "step",
    });
    expect(step.status).toBe("waiting");

    const session = await stores.sessions.session(scope);
    const launched = await stores.processes.launch(session, step.id);

    // The launch has no caller to throw at — the chain reads the record — so the
    // refusal is written as the step's own failure.
    expect(launched?.status).toBe("failed");
    expect(launched?.error).toMatch(/already has 1 running process tasks; the limit is 1/);
    expect((await stores.processes.get(scope, step.id))?.task.status).toBe("failed");
  });

  it("ends a chain whose next step cannot start, naming the limit in the chain's reason", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const stores = makeStores({ maxRunningTasks: 1 });
    const scope: TaskScope = { cwd: dir.path, sessionId: "session-cap-chain" };

    await stores.processes.start({ ...scope, command: "sleep 1", name: "holder" });
    const step = await stores.processes.queueStep({
      ...scope,
      command: "sleep 1",
      name: "step",
    });
    // Queueing behind the waiting record adopts it as step one, which is due now.
    const queued = await stores.chainTasks.enqueue(scope, step.id, {
      command: "sleep 1",
      name: "after",
    });

    await waitFor("the chain to end failed", async () => {
      const chain = await stores.chainTasks.get(scope, queued.chain.id);
      return chain?.task.status === "failed";
    });
    const ended = await stores.chainTasks.get(scope, queued.chain.id);
    expect(ended?.task.error).toContain(`step ${step.id}`);
    expect(ended?.task.error).toMatch(/limit is 1/);
    expect(stores.chainEndings.at(-1)?.task.status).toBe("failed");
  });
});

describe("the running-task cap through the tools", () => {
  it("refuses the second bg_run with a message naming the limit", {
    timeout: 40_000,
  }, async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "sleeper.js", "setInterval(() => {}, 1000);\n");
    const harness = createHarness(
      { cwd: dir.path, sessionId: "session-cap-tool" },
      { env: { [MAX_RUNNING_TASKS_ENV]: "1" } },
    );

    const first = await harness.call("bg_run", { command, name: "holder" });
    const held = first.details as { id: string; pid?: number };
    if (held.pid !== undefined) spawned.push(held.pid);

    const refused = await harness.call("bg_run", { command, name: "second" });
    const drawn = resultText(refused);
    expect(drawn).toContain("already has 1 running process tasks; the limit is 1");
    expect(drawn).toContain(MAX_RUNNING_TASKS_ENV);
    expect(drawn).toContain("The task was not started.");

    const listed = await harness.call("bg_status", {});
    expect((listed.details as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it("records a refused fire as failed with the reason instead of leaving it pending", {
    timeout: 40_000,
  }, async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "sleeper.js", "setInterval(() => {}, 1000);\n");
    let now = Date.UTC(2026, 0, 1, 9, 0, 0);
    const harness = createHarness(
      { cwd: dir.path, sessionId: "session-cap-fire" },
      { now: () => now, env: { [MAX_RUNNING_TASKS_ENV]: "1" } },
    );

    const first = await harness.call("bg_run", { command, name: "holder" });
    const held = first.details as { id: string; pid?: number };
    if (held.pid !== undefined) spawned.push(held.pid);

    const created = await harness.call("loop_create", { schedule: "10s", command, name: "watch" });
    const loop = created.details as { id: string; nextFireAt?: number };
    now = loop.nextFireAt ?? now;
    await harness.pump(now);

    interface FireEntry {
      fire: number;
      outcome: string;
      error?: string;
    }
    let fire: FireEntry | undefined;
    await waitFor("the refused fire to be recorded", async () => {
      const listed = await harness.call("loop_list", { id: loop.id });
      fire = (listed.details as { fireHistory?: FireEntry[] }).fireHistory?.[0];
      return fire?.outcome === "failed";
    });
    expect(fire?.error).toContain("already has 1 running process tasks; the limit is 1");
  });
});
