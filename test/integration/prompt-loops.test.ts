/**
 * Prompt loops: the text a fire delivers is read from the loop's prompt file,
 * written at creation and read again on every fire (ADR-0024). These tests drive
 * the file seam through the extension the way a user reaches it: create through
 * the tool, edit the file, and watch the next wake carry the new text.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, resultText } from "../support/extension-harness.js";
import { makeTempDir } from "../support/processes.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function setup() {
  const directory = await makeTempDir();
  cleanup.push(directory.dispose);
  let now = Date.UTC(2026, 0, 1, 9, 0, 0);
  const turn = { cwd: directory.path, sessionId: "session-prompt-file" };
  const harness = createHarness(turn, { now: () => now });
  return {
    harness,
    turn,
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

interface LoopDetails {
  id: string;
  fires: number;
  promptFile?: string;
}

function detailsOf<T>(result: { details: unknown }): T {
  return result.details as T;
}

async function createLoop(harness: Awaited<ReturnType<typeof setup>>["harness"]) {
  return detailsOf<LoopDetails>(
    await harness.call("pretty_task_loop_create", {
      schedule: "10s",
      prompt: "review the diff",
    }),
  );
}

describe("prompt file", () => {
  it("delivers the text in the file, so an edited file changes the next wake", async () => {
    const task = await setup();
    const created = await createLoop(task.harness);
    const path = created.promptFile;
    if (path === undefined) throw new Error("the created loop has no prompt file");
    expect(await readFile(path, "utf8")).toBe("review the diff");

    // Editing the file is how the user changes what the loop says; no tool and
    // no session message stands between the file and the wake.
    await writeFile(path, "review only the parser module\n", "utf8");

    task.advance(10_000);
    await task.harness.pump(task.now);

    expect(task.harness.messages.map((message) => message.content)).toEqual([
      "review only the parser module\n",
    ]);
    // Reading is not writing: the file stays exactly what the user saved.
    expect(await readFile(path, "utf8")).toBe("review only the parser module\n");
    expect(
      detailsOf<LoopDetails>(await task.harness.call("pretty_task_loop_list", { id: created.id })),
    ).toMatchObject({ fires: 1, promptFile: path });
  });

  it("deletes the file with the loop, so no prompt is left behind", async () => {
    const task = await setup();
    const created = await createLoop(task.harness);
    const path = created.promptFile;
    if (path === undefined) throw new Error("the created loop has no prompt file");

    const deleted = await task.harness.call("pretty_task_loop_delete", { id: created.id });

    expect(resultText(deleted)).toContain(`Deleted loop ${created.id}`);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
