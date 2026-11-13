/**
 * Process seam: stopping a command takes its whole tree with it. These tests
 * drive the supervisor against real processes, because a fake spawn would only
 * prove that we call the fake correctly — the question here is whether an
 * orphan survives a stop.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProcessTasks } from "../src/tasks/process/process-tasks.js";
import { type RunningProcess, startProcess } from "../src/tasks/process/supervisor.js";
import { isAlive, killTree, makeTempDir, waitFor, writeScript } from "./support/processes.js";

const cleanup: Array<() => Promise<void>> = [];
const spawned: number[] = [];
let outputCounter = 0;

afterEach(async () => {
  while (spawned.length > 0) await killTree(spawned.pop());
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** Start one command through the supervisor, as the store does. */
function run(command: string, cwd: string): RunningProcess {
  outputCounter += 1;
  const running = startProcess({
    command,
    cwd,
    outputPath: join(cwd, `output-${String(outputCounter)}.log`),
  });
  if (running.pid !== undefined) spawned.push(running.pid);
  return running;
}

function pidOf(running: RunningProcess): number {
  const { pid } = running;
  if (pid === undefined) throw new Error("the supervisor returned no pid");
  return pid;
}

async function readPid(path: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(path, "utf8")).trim());
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

describe("stop", () => {
  it("leaves no process behind when the command has to be forced", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "forever.js", "setInterval(() => {}, 1000);\n");
    const running = run(command, dir.path);
    const pid = pidOf(running);

    const result = await running.stop({ graceMs: 300, confirmMs: 5000 });

    expect(result.outcome).toBe("stopped");
    expect(isAlive(pid)).toBe(false);
  });

  it("answers already-exited instead of failing when the command ended on its own", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "quick.js", "process.exit(0);\n");
    const running = run(command, dir.path);

    const exit = await running.exit;
    expect(exit.exitCode).toBe(0);

    const result = await running.stop({ graceMs: 300, confirmMs: 5000 });

    expect(result.outcome).toBe("already-exited");
  });

  it("waits out the grace period before forcing a command that ignores the polite signal", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    // On Windows a console process cannot be asked to close, so it behaves
    // exactly like this POSIX script that refuses SIGTERM: only force ends it.
    const source =
      process.platform === "win32"
        ? "setInterval(() => {}, 1000);\n"
        : "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n";
    const command = await writeScript(dir.path, "stubborn.js", source);
    const running = run(command, dir.path);
    const pid = pidOf(running);

    const result = await running.stop({ graceMs: 500, confirmMs: 5000 });

    expect(result.tookMs).toBeGreaterThanOrEqual(500);
    expect(result.outcome).toBe("stopped");
    expect(isAlive(pid)).toBe(false);
  });

  it("kills a grandchild as well as the command that started it", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    await writeScript(
      dir.path,
      "grandchild.js",
      "require('node:fs').writeFileSync(process.argv[2], String(process.pid));\nsetInterval(() => {}, 1000);\n",
    );
    const parentSource = [
      "const { spawn } = require('node:child_process');",
      "const path = require('node:path');",
      "spawn(process.execPath, [path.join(__dirname, 'grandchild.js'), process.argv[2]], {",
      "  stdio: 'ignore',",
      "});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n");
    const pidFile = join(dir.path, "grandchild.pid");
    const program = await writeScript(dir.path, "parent.js", parentSource);
    const running = run(`${program} "${pidFile}"`, dir.path);
    const pid = pidOf(running);

    await waitFor("the grandchild to start", async () => (await readPid(pidFile)) !== undefined);
    const grandchild = await readPid(pidFile);
    if (grandchild === undefined) throw new Error("the grandchild wrote no pid");
    spawned.push(grandchild);

    const result = await running.stop({ graceMs: 500, confirmMs: 5000 });

    expect(result.outcome).toBe("stopped");
    await waitFor("both processes to disappear", () => !isAlive(pid) && !isAlive(grandchild));
  });
});

describe("the store's kill reason", () => {
  it("records a timeout kill as killed, told apart from a user kill", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "forever.js", "setInterval(() => {}, 1000);\n");
    const tasks = new ProcessTasks({ killGraceMs: 300, killConfirmMs: 5000 });
    const scope = { cwd: dir.path, sessionId: "session-timeout-kill" };

    const task = await tasks.start({ ...scope, command, name: "timed out" });
    if (task.pid !== undefined) spawned.push(task.pid);

    const result = await tasks.stop(scope, task.id, { reason: "timeout" });

    expect(result?.outcome).toBe("killed");
    expect(result?.view.task.status).toBe("killed");
    expect(result?.view.task.killReason).toBe("timeout");
    expect(tasks.get(scope, task.id)?.task.status).toBe("killed");
  });
});
