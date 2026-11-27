/**
 * The runner around the runs: the table it keeps, where a detached record lands,
 * and what a shutdown does to the commands still in front.
 *
 * The processes here are fakes. What is under test is which directory a record is
 * written to, when a wait leaves the table, and which commands a session shutdown
 * hands over — never a spawn.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  sessionTaskDirectory,
  type TaskScope,
  taskRecordPath,
} from "../../src/tasks/base/runtime-state.js";
import type { ProcessTask } from "../../src/tasks/base/task.js";
import { TaskSessions } from "../../src/tasks/base/task-sessions.js";
import { type DetachedResult, ForegroundRunner } from "../../src/tasks/process/foreground.js";
import { ProcessTasks } from "../../src/tasks/process/process-tasks.js";
import { fakeSupervisor } from "../support/fake-supervisor.js";
import { makeTempDir, waitFor } from "../support/processes.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** A runner over one session in its own directory, with the processes faked. */
async function makeRunner(onDetached?: (detached: DetachedResult) => void) {
  const dir = await makeTempDir();
  cleanup.push(dir.dispose);
  const sessions = new TaskSessions();
  const supervisor = fakeSupervisor();
  const tasks = new ProcessTasks({ sessions, supervise: supervisor.supervise });
  const runner = new ForegroundRunner({ tasks, detachAfterMs: 0, onDetached });
  const scope: TaskScope = { cwd: dir.path, sessionId: "session-runner" };
  runner.setScope(scope);
  return { dir, runner, supervisor, scope };
}

/** The task records on disk, which is what a later turn would read. */
async function records(dir: string, sessionId: string): Promise<readonly ProcessTask[]> {
  const path = taskRecordPath(sessionTaskDirectory(dir, sessionId));
  const document = JSON.parse(await readFile(path, "utf8")) as { tasks: ProcessTask[] };
  return document.tasks;
}

describe("the foreground runner", () => {
  it("forgets a run once it ended", async () => {
    const { runner, supervisor, scope } = await makeRunner();
    await runner.start({ ...scope, command: "node build.js" });
    expect(runner.held).toBe(1);

    supervisor.processes[0]?.end(0);
    // Leaving the table is not the same instant as ending: the record stays until
    // the outcome has been handed to whoever was waiting.
    await waitFor("the run to leave the table", () => runner.held === 0);
    expect(runner.live()).toHaveLength(0);
  });

  it("writes a detached record into the session, not into the command's directory", async () => {
    const { dir, runner, scope } = await makeRunner();
    const sub = join(dir.path, "packages", "site");
    await mkdir(sub, { recursive: true });

    const run = await runner.start({
      ...scope,
      command: "node build.js",
      workingDirectory: sub,
    });
    const result = await runner.detach(run, "shortcut");

    expect(result.kind).toBe("detached");
    // The record is read from the session's directory, and its own cwd is the one the
    // command ran in. Before the detach carried the session's cwd these were the same
    // value, so a command in a subdirectory wrote its record where nothing looks.
    const [task] = await records(dir.path, scope.sessionId);
    expect(task?.cwd).toBe(sub);
    expect(task?.origin).toBe("foreground");
    await expect(
      readFile(taskRecordPath(sessionTaskDirectory(sub, scope.sessionId)), "utf8"),
    ).rejects.toThrow();
  });

  it("lets no run be adopted twice, so the table is the only place a wait lives", async () => {
    const { dir, runner, scope } = await makeRunner();
    const run = await runner.start({ ...scope, command: "node build.js" });

    expect(await runner.detach(run, "shortcut")).toMatchObject({ kind: "detached" });
    expect(await runner.detach(run, "shortcut")).toEqual({ kind: "nothing" });
    expect(await records(dir.path, scope.sessionId)).toHaveLength(1);
  });

  it("carries the trigger into the result and the caller's hook", async () => {
    const seen: DetachedResult[] = [];
    const { runner, scope } = await makeRunner((detached) => seen.push(detached));
    const run = await runner.start({ ...scope, command: "node build.js" });

    const result = await runner.detach(run, "timeout");

    // One value carries both: the trigger is how a deadline is told apart from a key
    // press, and afterSeconds is the number the notice quotes back to the reader.
    expect(result).toMatchObject({ kind: "detached", trigger: "timeout" });
    expect(seen).toEqual([result]);
    expect(result.kind === "detached" && result.afterSeconds).toBeGreaterThanOrEqual(0);
  });

  it("lets every command in front go when the session shuts down", async () => {
    const { dir, runner, scope } = await makeRunner();
    await runner.start({ ...scope, command: "node build.js" });
    await runner.start({ ...scope, command: "node test.js" });
    expect(runner.live()).toHaveLength(2);

    await runner.releaseAll();

    expect(runner.live()).toHaveLength(0);
    expect(await records(dir.path, scope.sessionId)).toHaveLength(2);
  });

  it("adopts nothing when the process already ended", async () => {
    const { dir, runner, supervisor, scope } = await makeRunner();
    const run = await runner.start({ ...scope, command: "node build.js" });
    supervisor.processes[0]?.end(7);

    expect(await runner.detach(run, "shortcut")).toEqual({ kind: "nothing" });
    // A command that already ended keeps its exit code in front of the reader: no
    // record is written, so the file a later turn would read does not exist.
    await expect(
      readFile(taskRecordPath(sessionTaskDirectory(dir.path, scope.sessionId)), "utf8"),
    ).rejects.toThrow();
  });
});
