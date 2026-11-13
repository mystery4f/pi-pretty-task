/**
 * Extension seam: the process-task tools as the model calls them. Every test
 * here drives the registered tools through a fake pi, and asserts what a user
 * or the model can observe from a later turn.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness, resultText } from "./support/extension-harness.js";
import { killTree, makeTempDir, waitFor, writeScript } from "./support/processes.js";

interface TaskDetails {
  id: string;
  name: string;
  kind: string;
  status: string;
  elapsedMs: number;
  outputBytes: number;
  pid?: number;
  exitCode?: number | null;
  outputPath: string;
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
): Promise<TaskDetails> {
  const result = await harness.call("bg_run", { name, command });
  const details = result.details as TaskDetails;
  trackPid(details);
  return details;
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
    expect(details.id).toMatch(/^[a-z0-9]{4,8}$/);
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
