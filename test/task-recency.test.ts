/**
 * Recency seam: `updatedAt` is what the panel sorts by, so only transitions a
 * reader would call news may move it. A command that keeps writing output is
 * still the same task at the same state, and must not climb the list every
 * time it prints (ADR-0010).
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { afterEach, describe, expect, it } from "vitest";

import { ProcessTasks } from "../src/tasks/process/process-tasks.js";
import { killTree, makeTempDir, waitFor, writeScript } from "./support/processes.js";

const cleanup: Array<{ dispose(): Promise<void> }> = [];
const spawned: number[] = [];

afterEach(async () => {
  while (spawned.length > 0) await killTree(spawned.pop());
  await Promise.all(cleanup.splice(0).map((directory) => directory.dispose()));
});

describe("task recency", () => {
  it("moves updatedAt when a process finishes, and not while its output grows", async () => {
    const directory = await makeTempDir();
    cleanup.push(directory);
    const command = await writeScript(
      directory.path,
      "ticker.js",
      [
        "let tick = 0;",
        "const timer = setInterval(() => {",
        "  tick += 1;",
        '  process.stdout.write("tick " + String(tick) + "\\n");',
        "}, 25);",
        "setTimeout(() => {",
        "  clearInterval(timer);",
        "  process.exit(0);",
        "}, 1200);",
      ].join("\n"),
    );

    const start = 1_000_000;
    let now = start;
    const tasks = new ProcessTasks({ now: () => now });
    const scope = { cwd: directory.path, sessionId: "session-recency" };

    const record = await tasks.start({ ...scope, command, name: "ticker" });
    if (record.pid !== undefined) spawned.push(record.pid);
    expect(record.createdAt).toBe(start);
    expect(record.updatedAt).toBe(start);

    await waitFor(
      "the command to write some output",
      async () => ((await tasks.get(scope, record.id))?.outputBytes ?? 0) > 0,
    );
    const running = await tasks.get(scope, record.id);
    expect(running?.task.status).toBe("running");
    // Bytes are not news: the clock has not moved, so neither has updatedAt.
    expect(running?.task.updatedAt).toBe(start);

    now = start + 10_000;
    await waitFor(
      "the command to finish",
      async () => (await tasks.get(scope, record.id))?.task.status !== "running",
    );

    const ended = await tasks.get(scope, record.id);
    expect(ended?.task.updatedAt).toBe(start + 10_000);
    expect(ended?.task.updatedAt).toBeGreaterThan(ended?.task.createdAt ?? 0);
  });
});
