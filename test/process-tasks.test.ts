/**
 * Extension seam: the process-task tools as the model calls them. Every test
 * here drives the registered tools through a fake pi, and asserts what a user
 * or the model can observe from a later turn.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { sessionTaskDirectory, taskRecordPath } from "../src/tasks/base/runtime-state.js";
import { TaskSessions } from "../src/tasks/base/task-sessions.js";
import { ChainTasks } from "../src/tasks/chain/chain-tasks.js";
import { ProcessTasks } from "../src/tasks/process/process-tasks.js";
import { processTaskTools } from "../src/tasks/process/tools.js";
import { createHarness, type Harness, resultText } from "./support/extension-harness.js";
import { isAlive, killTree, makeTempDir, waitFor, writeScript } from "./support/processes.js";

interface TaskDetails {
  id: string;
  name: string;
  kind: string;
  status: string;
  elapsedMs: number;
  outputBytes: number;
  pid?: number;
  exitCode?: number | null;
  cwd: string;
  outputPath: string;
  killReason?: string;
}

const cleanup: Array<() => Promise<void>> = [];
const spawned: number[] = [];

afterEach(async () => {
  while (spawned.length > 0) await killTree(spawned.pop());
  while (cleanup.length > 0) await cleanup.pop()?.();
});

function trackPid(details: TaskDetails): number {
  const { pid } = details;
  if (pid === undefined) throw new Error("bg_run returned no pid");
  spawned.push(pid);
  return pid;
}

async function startRunning(
  harness: Harness,
  command: string,
  name = "slow build",
  extra: Record<string, unknown> = {},
): Promise<TaskDetails> {
  const result = await harness.call("bg_run", { name, command, ...extra });
  const details = result.details as TaskDetails;
  trackPid(details);
  return details;
}

/** Ask for one task's status until it is no longer running. */
async function waitForEnd(harness: Harness, id: string): Promise<TaskDetails> {
  await waitFor("the task to finish", async () => {
    const status = await harness.call("bg_status", { id });
    return (status.details as TaskDetails).status !== "running";
  });
  return (await harness.call("bg_status", { id })).details as TaskDetails;
}

describe("bg_run", () => {
  it("returns a short task id without waiting for the command to finish", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "sleeper.js", "setTimeout(() => {}, 30000);\n");
    const harness = createHarness({ cwd: dir.path, sessionId: "session-run" });

    const started = Date.now();
    const result = await harness.call("bg_run", { name: "slow build", command });
    const elapsed = Date.now() - started;

    const details = result.details as TaskDetails;
    trackPid(details);

    expect(elapsed).toBeLessThan(1000);
    expect(details.id).toMatch(/^bg-[a-z0-9]{5}$/);
    expect(details.kind).toBe("process");
    expect(details.status).toBe("running");
    expect(details.outputPath.endsWith(".output")).toBe(true);

    const text = resultText(result);
    expect(text).toContain(details.id);
    expect(text).toContain("slow build");
    expect(text).toContain(details.outputPath);
  });
});

describe("bg_run output", () => {
  it("captures stdout and stderr in one file, in emission order and without loss", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "interleave.js",
      [
        "const lines = 100;",
        "for (let i = 0; i < lines; i += 1) {",
        "  const stream = i % 2 === 0 ? process.stdout : process.stderr;",
        '  stream.write("line " + i + " " + (i % 2 === 0 ? "out" : "err") + "\\n");',
        "}",
        "",
      ].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-output" });

    const task = await startRunning(harness, command, "interleaved");
    await waitFor("the task to finish", async () => {
      const status = await harness.call("bg_status", { id: task.id });
      return (status.details as TaskDetails).status === "completed";
    });

    const logged = await harness.call("bg_logs", { id: task.id, lines: 1000 });
    const text = resultText(logged);
    const captured = text.slice(text.indexOf("\n\n") + 2).split("\n");

    expect(captured).toHaveLength(100);
    for (const line of captured) {
      expect(line).toMatch(/^line \d+ (out|err)$/);
    }
    // Cross-stream order is the kernel's per-pipe read order, not a shared
    // clock: what one file owes is every line, and each stream in its own order.
    const sequence = (kind: string): number[] =>
      captured
        .filter((line) => line.endsWith(` ${kind}`))
        .map((line) => Number(line.split(" ")[1]));
    expect(sequence("out")).toEqual(Array.from({ length: 50 }, (_, index) => index * 2));
    expect(sequence("err")).toEqual(Array.from({ length: 50 }, (_, index) => index * 2 + 1));
  });
});

describe("bg_run's directory and environment", () => {
  it("resolves a relative cwd from the session directory and runs the child there", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const work = join(dir.path, "nested", "work");
    await mkdir(work, { recursive: true });
    const command = await writeScript(
      dir.path,
      "where.js",
      "require('node:fs').writeFileSync('cwd.txt', process.cwd());\n",
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-cwd" });

    const task = await startRunning(harness, command, "relative cwd", {
      cwd: join("nested", "work"),
    });

    // The record keeps the absolute path, resolved once against the session.
    expect(task.cwd).toBe(resolve(dir.path, "nested", "work"));
    expect(resultText(await harness.call("bg_status", { id: task.id }))).toContain(task.cwd);

    const done = await waitForEnd(harness, task.id);
    expect(done.status).toBe("completed");

    // The script wrote into its own cwd, so the file exists only inside `work`.
    const reported = (await readFile(join(work, "cwd.txt"), "utf8")).trim();
    expect(await realpath(reported)).toBe(await realpath(work));
  });

  it("rejects a cwd that is missing or not a directory, leaving no task record", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const file = join(dir.path, "not-a-directory.txt");
    await writeFile(file, "file\n", "utf8");
    const harness = createHarness({ cwd: dir.path, sessionId: "session-cwd-invalid" });

    const missing = await harness.call("bg_run", { command: "echo hi", cwd: "no-such-dir" });
    expect(resultText(missing)).toContain(resolve(dir.path, "no-such-dir"));
    expect(resultText(missing)).toContain("The task was not started.");

    const notDirectory = await harness.call("bg_run", {
      command: "echo hi",
      cwd: "not-a-directory.txt",
    });
    expect(resultText(notDirectory)).toContain(resolve(dir.path, "not-a-directory.txt"));
    expect(resultText(notDirectory)).toContain("is not a directory");
    expect(resultText(notDirectory)).toContain("The task was not started.");

    expect(resultText(await harness.call("bg_status", {}))).toContain("No background tasks");
    // Not even a half-written record: the rejection happens before the first save.
    await expect(
      readFile(taskRecordPath(sessionTaskDirectory(dir.path, "session-cwd-invalid")), "utf8"),
    ).rejects.toThrow();
  });

  it("merges env over the extension's environment for the child only, never onto disk", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "env.js",
      [
        "const value = process.env.PI_PRETTY_TASK_TEST;",
        "process.stdout.write('value=' + (value === undefined ? 'undefined' : value) + '\\n');",
        "",
      ].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-env" });
    const secret = "s3cret-token";

    const withEnv = await startRunning(harness, command, "with env", {
      env: { PI_PRETTY_TASK_TEST: secret },
    });
    await waitForEnd(harness, withEnv.id);
    expect(resultText(await harness.call("bg_logs", { id: withEnv.id }))).toContain(
      `value=${secret}`,
    );

    // An empty string is a value too: it blanks the variable for this child.
    const blanked = await startRunning(harness, command, "blank env", {
      env: { PI_PRETTY_TASK_TEST: "" },
    });
    await waitForEnd(harness, blanked.id);
    const blankedText = resultText(await harness.call("bg_logs", { id: blanked.id }));
    expect(blankedText.split("\n").filter((line) => line.startsWith("value="))).toEqual(["value="]);

    // The next call does not inherit the previous call's variables.
    const without = await startRunning(harness, command, "without env");
    await waitForEnd(harness, without.id);
    expect(resultText(await harness.call("bg_logs", { id: without.id }))).toContain(
      "value=undefined",
    );

    // A record in a file is not a safe place for a token: neither the value nor
    // its name is written, and no tool prints it.
    const recordPath = taskRecordPath(sessionTaskDirectory(dir.path, "session-env"));
    type SavedRecord = { tasks: Array<{ id: string; status: string }> };
    const readRecord = async (): Promise<SavedRecord | undefined> => {
      try {
        return JSON.parse(await readFile(recordPath, "utf8")) as SavedRecord;
      } catch {
        return undefined;
      }
    };
    await waitFor("the final record to reach the disk", async () => {
      const record = await readRecord();
      return (
        record?.tasks.some((task) => task.id === without.id && task.status === "completed") ?? false
      );
    });
    const record = await readFile(recordPath, "utf8");
    expect(record).not.toContain(secret);
    expect(record).not.toContain("PI_PRETTY_TASK_TEST");
    expect(resultText(await harness.call("bg_status", { id: withEnv.id }))).not.toContain(secret);
  });

  it("accepts env only as string values, at the schema seam", () => {
    const processes = new ProcessTasks();
    const run = processTaskTools(processes, new ChainTasks({ processes: () => processes })).find(
      (tool) => tool.name === "bg_run",
    );
    if (run === undefined) throw new Error("bg_run is not registered");
    const accepts = (env: unknown): boolean =>
      Value.Check(run.parameters, { command: "echo hi", env });

    expect(accepts({ PI_PRETTY_TASK_TEST: "yes" })).toBe(true);
    // An empty string is a value and blanks the variable.
    expect(accepts({ PI_PRETTY_TASK_TEST: "" })).toBe(true);
    expect(accepts({ PI_PRETTY_TASK_TEST: undefined })).toBe(false);
    expect(accepts({ PI_PRETTY_TASK_TEST: 1 })).toBe(false);
  });
});

describe("bg_status", () => {
  it("reports name, id, kind, status, elapsed time and output size for every task", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "sleeper.js", "setTimeout(() => {}, 30000);\n");
    const harness = createHarness({ cwd: dir.path, sessionId: "session-status" });

    const first = await startRunning(harness, command, "first task");
    const second = await startRunning(harness, command, "second task");

    const started = Date.now();
    const listed = await harness.call("bg_status", {});
    const elapsed = Date.now() - started;
    const text = resultText(listed);

    for (const task of [first, second]) {
      expect(text).toContain(task.id);
      expect(text).toContain(task.name);
      expect(text).toContain("kind");
      expect(text).toContain("status");
      expect(text).toContain("elapsed");
      expect(text).toContain("output");
    }
    expect(elapsed).toBeLessThan(1000);

    // A single task can be asked about on its own.
    const one = await harness.call("bg_status", { id: second.id });
    const oneText = resultText(one);
    expect(oneText).toContain(second.id);
    expect(oneText).not.toContain(first.id);
  });

  it("grows the output size while the command keeps writing", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "ticker.js",
      [
        "let count = 0;",
        "const tick = setInterval(() => {",
        '  process.stdout.write("tick " + count + "\\n");',
        "  count += 1;",
        "}, 20);",
        "setTimeout(() => { clearInterval(tick); }, 30000);",
        "",
      ].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-size" });

    const task = await startRunning(harness, command, "ticker");
    const first = (await harness.call("bg_status", { id: task.id })).details as TaskDetails;

    await waitFor("more output to arrive", async () => {
      const later = (await harness.call("bg_status", { id: task.id })).details as TaskDetails;
      return later.outputBytes > first.outputBytes + 40;
    });
    const later = (await harness.call("bg_status", { id: task.id })).details as TaskDetails;
    expect(later.outputBytes).toBeGreaterThan(first.outputBytes + 40);
  });
});

describe("bg_logs", () => {
  it("grows the tail while the task runs", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "slow-writer.js",
      [
        "let count = 0;",
        "const tick = setInterval(() => {",
        '  process.stdout.write("line " + count + "\\n");',
        "  count += 1;",
        "}, 25);",
        "setTimeout(() => { clearInterval(tick); }, 30000);",
        "",
      ].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-logs" });

    const task = await startRunning(harness, command, "slow writer");
    await waitFor("three lines", async () => {
      const text = resultText(await harness.call("bg_logs", { id: task.id, lines: 40 }));
      return text.split("\n").filter((line) => line.startsWith("line ")).length >= 3;
    });

    const early = resultText(await harness.call("bg_logs", { id: task.id, lines: 40 }));
    await waitFor("five more lines", async () => {
      const text = resultText(await harness.call("bg_logs", { id: task.id, lines: 40 }));
      return text.split("\n").filter((line) => line.startsWith("line ")).length >= 6;
    });
    const later = resultText(await harness.call("bg_logs", { id: task.id, lines: 40 }));

    const counted = (text: string): number =>
      text.split("\n").filter((line) => line.startsWith("line ")).length;
    expect(counted(later)).toBeGreaterThan(counted(early));
  });

  it("returns a bounded window of a long output", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "many-lines.js",
      [
        "for (let i = 0; i < 400; i += 1) {",
        '  process.stdout.write("line " + i + "\\n");',
        "}",
        "",
      ].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-tail" });

    const task = await startRunning(harness, command, "many lines");
    await waitFor("the task to finish", async () => {
      const status = await harness.call("bg_status", { id: task.id });
      return (status.details as TaskDetails).status === "completed";
    });

    const logged = await harness.call("bg_logs", { id: task.id, lines: 10 });
    const text = resultText(logged);
    const tail = text.slice(text.indexOf("\n\n") + 2).split("\n");
    expect(tail).toHaveLength(10);
    expect(tail[0]).toBe("line 390");
    expect(tail[9]).toBe("line 399");
  });
});

describe("bg_run lifetime", () => {
  it("keeps running across turns, then reports completion with an exit code", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "sleep-then-exit.js",
      [
        "process.stdout.write('working\\n');",
        "setTimeout(() => { process.exit(0); }, 400);",
        "",
      ].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-lifetime" });
    const task = await startRunning(harness, command, "short job");

    // A later turn, simulated by asking again from the same session.
    const stillRunning = (await harness.call("bg_status", { id: task.id })).details as TaskDetails;
    expect(stillRunning.status).toBe("running");

    await waitFor("completion", async () => {
      const status = await harness.call("bg_status", { id: task.id });
      return (status.details as TaskDetails).status === "completed";
    });
    const done = (await harness.call("bg_status", { id: task.id })).details as TaskDetails;

    expect(done.status).toBe("completed");
    expect(done.exitCode).toBe(0);
    expect(done.elapsedMs).toBeGreaterThanOrEqual(300);
    expect(resultText(await harness.call("bg_logs", { id: task.id }))).toContain("working");
  });

  it("does not leak one session's tasks into another's list", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "sleeper.js", "setTimeout(() => {}, 30000);\n");
    const mine = createHarness({ cwd: dir.path, sessionId: "session-a" });
    const other = createHarness({ cwd: dir.path, sessionId: "session-b" });
    const task = await startRunning(mine, command, "only mine");

    const listed = (await other.call("bg_status", {})).details as { tasks: TaskDetails[] };
    expect(listed.tasks).toHaveLength(0);
    const text = resultText(await other.call("bg_status", { id: task.id }));
    expect(text).toContain("No background task");
  });

  it("still shows a finished task in full, long after it ended", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const program = await writeScript(
      dir.path,
      "hundred.js",
      [
        "for (let i = 0; i < 100; i += 1) {",
        '  process.stdout.write("line " + i + "\\n");',
        "}",
        "",
      ].join("\n"),
    );
    const padding = "x".repeat(120);
    const command = `${program} && echo ${padding}`;
    const harness = createHarness({ cwd: dir.path, sessionId: "session-full" });
    const task = await startRunning(harness, command, "full record");

    await waitFor("completion", async () => {
      const status = await harness.call("bg_status", { id: task.id });
      return (status.details as TaskDetails).status === "completed";
    });

    // `full` is how a finished task is read: nothing is abbreviated, nothing is cut.
    const prompt = resultText(await harness.call("bg_status", { id: task.id }));
    expect(prompt).toContain("…");
    expect(prompt).not.toContain(padding);

    const complete = await harness.call("bg_status", { id: task.id, full: true });
    const completeText = resultText(complete);
    expect(completeText).toContain(padding);
    expect(completeText).not.toContain("…");
    expect(completeText).toContain("exit code: 0");

    const logged = await harness.call("bg_logs", { id: task.id, full: true });
    const lines = resultText(logged)
      .slice(resultText(logged).indexOf("\n\n") + 2)
      .split("\n");
    expect(lines).toHaveLength(101);
    expect(lines[0]).toBe("line 0");
    expect(lines[99]).toBe("line 99");
    expect(lines[100]).toBe(padding);
    expect((logged.details as { truncated: boolean }).truncated).toBe(false);
  });

  it("marks a non-zero exit as failed and keeps the exit code", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "fails.js",
      ["process.stderr.write('boom\\n');", "process.exit(3);", ""].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-failure" });
    const task = await startRunning(harness, command, "bad job");

    await waitFor("failure", async () => {
      const status = await harness.call("bg_status", { id: task.id });
      return (status.details as TaskDetails).status !== "running";
    });
    const failed = (await harness.call("bg_status", { id: task.id })).details as TaskDetails;
    const text = resultText(await harness.call("bg_status", { id: task.id }));

    expect(failed.status).toBe("failed");
    expect(failed.exitCode).toBe(3);
    expect(text).toContain("exit code: 3");
    expect(resultText(await harness.call("bg_logs", { id: task.id }))).toContain("boom");
  });
});

describe("bg_wait", () => {
  it("returns the final view as soon as the task ends", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "short-job.js",
      ["process.stdout.write('done\\n');", "setTimeout(() => { process.exit(0); }, 400);", ""].join(
        "\n",
      ),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-wait" });
    const task = await startRunning(harness, command, "short wait job");

    const started = Date.now();
    const result = await harness.call("bg_wait", { id: task.id, timeoutSeconds: 15 });
    const elapsed = Date.now() - started;
    const details = result.details as TaskDetails & { waited: boolean };

    // The answer is the record after the end, not whatever was true at the start.
    expect(details.status).toBe("completed");
    expect(details.exitCode).toBe(0);
    expect(details.waited).toBe(true);
    expect(elapsed).toBeLessThan(3000);
    expect(resultText(result)).toContain("completed");
  });

  it("wakes every wait on the same end", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "shared-job.js",
      ["setTimeout(() => { process.exit(0); }, 300);", ""].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-wait-shared" });
    const task = await startRunning(harness, command, "shared wait job");

    const results = await Promise.all([
      harness.call("bg_wait", { id: task.id, timeoutSeconds: 15 }),
      harness.call("bg_wait", { id: task.id, timeoutSeconds: 15 }),
    ]);

    for (const result of results) {
      const details = result.details as TaskDetails & { waited: boolean };
      expect(details.status).toBe("completed");
      expect(details.exitCode).toBe(0);
      expect(details.waited).toBe(true);
    }
  });

  it("returns the running view, not an error, when the timeout passes", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "sleeper.js", "setTimeout(() => {}, 30000);\n");
    const harness = createHarness({ cwd: dir.path, sessionId: "session-wait-timeout" });
    const task = await startRunning(harness, command, "long wait job");

    const started = Date.now();
    const result = await harness.call("bg_wait", { id: task.id, timeoutSeconds: 0.3 });
    const elapsed = Date.now() - started;
    const details = result.details as TaskDetails & { waited: boolean };

    // A deadline is an answer: the same view bg_status gives, plus `waited`.
    expect(details.status).toBe("running");
    expect(details.waited).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(10_000);
    expect(resultText(result)).toContain("did not finish");
  });

  it("returns at once for a task that already finished", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "already-done.js",
      ["process.stdout.write('gone\\n');", "process.exit(4);", ""].join("\n"),
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-wait-done" });
    const task = await startRunning(harness, command, "finished job");
    await waitForEnd(harness, task.id);

    const started = Date.now();
    const result = await harness.call("bg_wait", { id: task.id, timeoutSeconds: 600 });
    const elapsed = Date.now() - started;
    const details = result.details as TaskDetails & { waited: boolean };

    expect(details.status).toBe("failed");
    expect(details.exitCode).toBe(4);
    expect(details.waited).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  it("reports an unusable timeout and an unknown id as text, not by throwing", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-wait-bad" });

    const tooLong = resultText(
      await harness.call("bg_wait", { id: "b-whatever", timeoutSeconds: 601 }),
    );
    expect(tooLong).toContain("no larger than 600");
    expect(tooLong).toContain("Nothing was waited for");

    const unknown = resultText(await harness.call("bg_wait", { id: "b-unknown" }));
    expect(unknown).toContain("No background task with id b-unknown in this session.");
  });
});

describe("bg_kill", () => {
  it("stops the command, records it as killed by the user, and keeps the record readable", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "sleeper.js",
      "process.stdout.write('waiting\\n');\nsetInterval(() => {}, 1000);\n",
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-kill" });
    const task = await startRunning(harness, command, "long job");
    const pid = trackPid(task);

    const killed = await harness.call("bg_kill", { id: task.id });
    const details = killed.details as TaskDetails & { stopOutcome: string };

    expect(details.stopOutcome).toBe("killed");
    expect(details.status).toBe("killed");
    expect(details.killReason).toBe("user");
    expect(isAlive(pid)).toBe(false);

    const text = resultText(killed);
    expect(text).toContain(`Stopped background task ${task.id}`);
    expect(text).toContain("kill reason: user");

    // The record survives the kill: status and captured output are still readable.
    const status = (await harness.call("bg_status", { id: task.id })).details as TaskDetails;
    expect(status.status).toBe("killed");
    expect(status.killReason).toBe("user");
    expect(resultText(await harness.call("bg_logs", { id: task.id }))).toContain("waiting");
  });

  it("stops a grandchild as well as the command that started it", async () => {
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
    const harness = createHarness({ cwd: dir.path, sessionId: "session-kill-tree" });
    const task = await startRunning(harness, `${program} "${pidFile}"`, "with a child");
    const pid = trackPid(task);

    await waitFor("the grandchild to start", async () => {
      try {
        return (await readFile(pidFile, "utf8")).trim().length > 0;
      } catch {
        return false;
      }
    });
    const grandchild = Number((await readFile(pidFile, "utf8")).trim());
    spawned.push(grandchild);

    const killed = await harness.call("bg_kill", { id: task.id });

    expect((killed.details as TaskDetails).status).toBe("killed");
    await waitFor("both processes to disappear", () => !isAlive(pid) && !isAlive(grandchild));
  });

  it("answers that a finished task was already finished instead of failing", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "quick.js", "process.stdout.write('done\\n');\n");
    const harness = createHarness({ cwd: dir.path, sessionId: "session-kill-done" });
    const task = await startRunning(harness, command, "quick job");

    await waitFor("completion", async () => {
      const status = await harness.call("bg_status", { id: task.id });
      return (status.details as TaskDetails).status === "completed";
    });

    const answer = await harness.call("bg_kill", { id: task.id });
    const details = answer.details as TaskDetails & { stopOutcome: string };

    expect(details.stopOutcome).toBe("already-finished");
    expect(details.status).toBe("completed");
    expect(details.killReason).toBeUndefined();
    expect(resultText(answer)).toContain("had already finished");
  });

  it("names an unknown id instead of failing", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-kill-unknown" });

    const answer = await harness.call("bg_kill", { id: "nope00" });

    expect(resultText(answer)).toContain("No background task with id nope00");
  });
});

describe("queued steps", () => {
  it("queues a step as a waiting record that belongs to its chain and to no row", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const marker = join(dir.path, "ran.txt");
    const command = await writeScript(
      dir.path,
      "queued.js",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
    );
    const tasks = new ProcessTasks();
    const scope = { cwd: dir.path, sessionId: "session-queue" };

    const step = await tasks.queueStep({
      ...scope,
      command,
      name: "step one",
      parentId: "ch00001",
    });

    expect(step.id).toMatch(/^bg-[a-z0-9]{5}$/);
    expect(step.kind).toBe("process");
    expect(step.status).toBe("waiting");
    expect(step.parentId).toBe("ch00001");
    expect(step.pid).toBeUndefined();
    expect(step.endedAt).toBeUndefined();
    // Nothing was spawned: queuing is a promise about the future, not a start.
    await expect(stat(marker)).rejects.toThrow();
    // A step is a record, not a row: the processes list holds roots only (ADR-0014).
    expect(await tasks.list(scope)).toHaveLength(0);
    // It is still a task in its own right: its id answers, with its status.
    expect((await tasks.get(scope, step.id))?.task.status).toBe("waiting");

    const saved = JSON.parse(
      await readFile(taskRecordPath(sessionTaskDirectory(scope.cwd, scope.sessionId)), "utf8"),
    ) as { tasks: Array<Record<string, unknown>> };
    expect(saved.tasks.find((task) => task.id === step.id)).toMatchObject({
      status: "waiting",
      parentId: "ch00001",
      command,
    });
  });

  it("launches a queued step once, booking its end like a task the user started", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "step.js", "console.log('step ran');\n");
    const sessions = new TaskSessions();
    const finished: string[] = [];
    const tasks = new ProcessTasks({
      sessions,
      onFinish: (view) => finished.push(`${view.task.status}:${view.task.exitCode ?? "none"}`),
    });
    const scope = { cwd: dir.path, sessionId: "session-launch" };
    const shared = await sessions.session(scope);
    const step = await tasks.queueStep({
      ...scope,
      command,
      name: "step two",
      parentId: "ch00001",
    });

    const launched = await tasks.launch(shared, step.id);
    expect(launched?.status).toBe("running");
    expect(launched?.pid).toBeGreaterThan(0);
    // The second launch finds a step that is no longer waiting, so it does nothing.
    expect(await tasks.launch(shared, step.id)).toBeUndefined();

    const ended = await tasks.wait(scope, step.id, 15_000);
    expect(ended?.waited).toBe(true);
    expect(ended?.view.task.status).toBe("completed");
    expect(ended?.view.task.exitCode).toBe(0);
    // The notice follows the disk write, so it lands a tick after the end.
    await waitFor("the completion notice", () => finished.length === 1);
    expect(finished).toEqual(["completed:0"]);

    const logs = await tasks.logs(scope, step.id, { lines: 10 });
    expect(logs?.tail.text).toContain("step ran");
  });

  it("ends a step failed when its process cannot start, so nothing waits forever", async () => {
    const dir = await makeTempDir();
    const work = await makeTempDir();
    cleanup.push(dir.dispose, work.dispose);
    const command = await writeScript(dir.path, "noop.js", "");
    const sessions = new TaskSessions();
    const tasks = new ProcessTasks({ sessions });
    const scope = { cwd: dir.path, sessionId: "session-launch-fail" };
    const shared = await sessions.session(scope);
    const step = await tasks.queueStep({
      ...scope,
      command,
      workingDirectory: work.path,
      parentId: "ch00001",
    });
    // The directory a step was queued in may be gone by the time its turn comes.
    await work.dispose();

    // The launch itself may already know: a spawn that cannot even start ends the
    // record before this promise settles, and either way the step ends.
    expect(await tasks.launch(shared, step.id)).toBeDefined();

    const ended = await tasks.wait(scope, step.id, 15_000);
    expect(ended?.view.task.status).toBe("failed");
    expect(ended?.view.task.error).toBeTruthy();
  });

  it("rejects a step whose working directory cannot be used, before any record exists", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const tasks = new ProcessTasks();
    const scope = { cwd: dir.path, sessionId: "session-queue-bad-cwd" };

    await expect(
      tasks.queueStep({
        ...scope,
        command: "node --version",
        workingDirectory: join(dir.path, "missing"),
        parentId: "ch00001",
      }),
    ).rejects.toThrow(/does not exist/);
    expect(await tasks.list(scope)).toHaveLength(0);
  });
});
