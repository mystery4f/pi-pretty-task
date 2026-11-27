/**
 * The foreground takeover as the model and the user see it: pi's own shell tool
 * runs a command, the extension holds the handle, and the key press ends the wait
 * without the command restarting.
 *
 * These tests spawn real processes on purpose. What they prove is a race — the
 * natural exit against a detach against the ceiling — and a race against a fake
 * process would only prove the fake.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { sessionTaskDirectory, taskRecordPath } from "../../src/tasks/base/runtime-state.js";
import {
  ADOPT_FOREGROUND_ENV,
  FOREGROUND_TIMEOUT_ENV,
  MAX_RUNNING_TASKS_ENV,
} from "../../src/tasks/base/settings.js";
import type { Task } from "../../src/tasks/base/task.js";
import { TASK_DETACHED_ENTRY_TYPE } from "../../src/ui/notification.js";
import { createHarness, type Harness, resultText } from "../support/extension-harness.js";
import { makeTempDir, waitFor, writeScript } from "../support/processes.js";

const SESSION = "session-foreground";

interface TempDir {
  readonly path: string;
  dispose(): Promise<void>;
}

/** A session in its own directory, with the takeover on or off as asked. */
function takeoverHarness(dir: TempDir, env: NodeJS.ProcessEnv = {}): Harness {
  return createHarness(
    { cwd: dir.path, sessionId: SESSION },
    { env: { ...process.env, [ADOPT_FOREGROUND_ENV]: "on", ...env } },
  );
}

/** The task records on disk, which is what a later turn would read. */
async function records(dir: TempDir): Promise<readonly Task[]> {
  const path = taskRecordPath(sessionTaskDirectory(dir.path, SESSION));
  const document = JSON.parse(await readFile(path, "utf8")) as { tasks: Task[] };
  return document.tasks;
}

/** A command that prints one line and then stays alive until it is killed. */
async function longCommand(dir: TempDir): Promise<string> {
  return writeScript(
    dir.path,
    "long.mjs",
    ["console.log('building the site');", "setInterval(() => {}, 1000);", ""].join("\n"),
  );
}

const cleanups: Array<() => Promise<void>> = [];

async function setup(env: NodeJS.ProcessEnv = {}): Promise<{ harness: Harness; dir: TempDir }> {
  const dir = await makeTempDir();
  cleanups.push(dir.dispose.bind(dir));

  const harness = takeoverHarness(dir, env);
  await harness.startSession();
  return { harness, dir };
}

describe("foreground takeover", () => {
  it("moves the running command to the background on the shortcut", async () => {
    const { harness, dir } = await setup();
    const command = await longCommand(dir);
    const pending = harness.call("bash", { command });
    await waitFor(
      "the command to reach the foreground",
      () => harness.controller.foreground.live().length === 1,
    );
    // A user reads the first line before deciding to move the command away: wait
    // until that line is on disk, or the detached call has nothing to hand back.
    await waitFor("the command's first line to reach the output file", async () => {
      const path = harness.controller.foreground.live()[0]?.outputPath;
      if (path === undefined) return false;
      return (await readFile(path, "utf8").catch(() => "")).includes("building the site");
    });

    expect(harness.shortcutKeys).toContain("ctrl+shift+b");
    await harness.runShortcut("ctrl+shift+b");
    const result = await pending;

    // The call ended without the command: the output it captured so far, then the
    // line that says where it went.
    const text = resultText(result);
    expect(text).toContain("building the site");
    expect(text).toContain("↪ moved to");
    expect(text).toContain("ctrl+shift+b");
    expect(text).toContain("Still running in the background");
    expect((result.structuredContent as { exit_code: number }).exit_code).toBe(0);

    const id = /↪ moved to (\S+)/.exec(text)?.[1];
    expect(id).toBeDefined();
    expect(harness.controller.foreground.live()).toEqual([]);

    // The user gets one card at the moment of the move: it names the record and the
    // key press, the session persists it, and it stays out of the model's context —
    // the tool result above already carried the same facts.
    expect(harness.entries).toHaveLength(1);
    expect(harness.entries[0]?.customType).toBe(TASK_DETACHED_ENTRY_TYPE);
    const card = harness.entries[0]?.data as {
      readonly id?: string;
      readonly trigger?: string;
      readonly afterSeconds?: number;
    };
    expect(card.id).toBe(id);
    expect(card.trigger).toBe("shortcut");
    expect(card.afterSeconds).toBeGreaterThanOrEqual(0);
    // One surface, not two: no toast repeats it and no message enters the session.
    expect(harness.notifications).toEqual([]);
    expect(harness.messages).toEqual([]);
    // It is a task now, reachable the way any task is.
    await waitFor("the detached task to be recorded as running", async () => {
      const task = (await records(dir)).find((record) => record.id === id);
      return task?.kind === "process" && task.status === "running" && task.origin === "foreground";
    });
    const status = await harness.call("pretty_task_bg_status", { id });
    expect(resultText(status)).toContain(id as string);
    await harness.call("pretty_task_bg_kill", { id });
  });

  it("reports the exit code of a command that ends on its own", async () => {
    const { harness, dir } = await setup();
    const command = await writeScript(dir.path, "quick.mjs", "process.exit(7);");
    const result = await harness.call("bash", { command });
    expect((result.structuredContent as { exit_code: number }).exit_code).toBe(7);
    expect(resultText(result)).not.toContain("↪ moved to");
    // Nothing was moved and nothing ended early, so the user hears nothing.
    expect(harness.notifications).toEqual([]);
  });

  it("announces the ending of a command it let go", async () => {
    const { harness, dir } = await setup();
    const command = await writeScript(
      dir.path,
      "brief.mjs",
      ["console.log('compiling');", "setTimeout(() => console.log('all done'), 600);", ""].join(
        "\n",
      ),
    );
    const pending = harness.call("bash", { command });
    await waitFor(
      "the command to reach the foreground",
      () => harness.controller.foreground.live().length === 1,
    );
    await harness.runShortcut("ctrl+shift+b");
    const id = /↪ moved to (\S+)/.exec(resultText(await pending))?.[1];
    expect(id).toBeDefined();
    expect(harness.entries.map((entry) => entry.customType)).toContain(TASK_DETACHED_ENTRY_TYPE);

    // The wait ended; the command did not. Its ending is a task ending like any
    // other, and a session that never hears about it has a model that believes a
    // detached command is still running.
    await waitFor("the detached task to end", async () => {
      const task = (await records(dir)).find((record) => record.id === id);
      return task?.status === "completed";
    });
    await waitFor("the completion notice", () => harness.messages.length > 0);
    const [notice] = harness.messages;
    expect((notice?.details as { id?: string } | undefined)?.id).toBe(id);
    expect(notice?.content).toContain("all done");
  });

  it("still kills a command whose own timeout runs out", async () => {
    const { harness, dir } = await setup();
    const command = await longCommand(dir);
    // The call's own `timeout` keeps its meaning: it stops the tree, it does not
    // hand it to the store (ADR-0020).
    await expect(harness.call("bash", { command, timeout: 1 })).rejects.toThrow(
      /timed out after 1 seconds/,
    );
    expect(harness.controller.foreground.live()).toEqual([]);
  });

  it("does nothing while more than one command is in front", async () => {
    const { harness, dir } = await setup();
    const command = await writeScript(
      dir.path,
      "short.mjs",
      ["setTimeout(() => process.exit(0), 700);", ""].join("\n"),
    );
    const first = harness.call("bash", { command });
    const second = harness.call("bash", { command });
    await waitFor(
      "both commands to reach the foreground",
      () => harness.controller.foreground.live().length === 2,
    );
    await harness.runShortcut("ctrl+shift+b");
    expect(harness.controller.foreground.live().length).toBe(2);
    // The user hears why nothing moved; the two calls above stay silent about it.
    expect(harness.notifications.at(-1)?.message).toContain("2 commands are running");
    for (const result of [await first, await second]) {
      expect((result.structuredContent as { exit_code: number }).exit_code).toBe(0);
      expect(resultText(result)).not.toContain("↪ moved to");
    }
  });

  it("keeps the command in the foreground when the task ceiling refuses it", async () => {
    const { harness, dir } = await setup({ [MAX_RUNNING_TASKS_ENV]: "1" });
    const sleeping = await longCommand(dir);
    const filler = await harness.call("pretty_task_bg_run", { name: "filler", command: sleeping });
    const fillerId = (filler.details as { id: string }).id;

    // A command that ends by itself, so a refused detach has something to show.
    const command = await writeScript(
      dir.path,
      "short.mjs",
      ["setTimeout(() => process.exit(0), 700);", ""].join("\n"),
    );
    const pending = harness.call("bash", { command });
    await waitFor(
      "the command to reach the foreground",
      () => harness.controller.foreground.live().length === 1,
    );
    await harness.runShortcut("ctrl+shift+b");
    expect(harness.controller.foreground.live().length).toBe(1);
    expect(harness.notifications.at(-1)?.message).toContain("Cannot move it");

    const result = await pending;
    expect((result.structuredContent as { exit_code: number }).exit_code).toBe(0);
    expect(resultText(result)).not.toContain("↪ moved to");
    await harness.call("pretty_task_bg_kill", { id: fillerId });
  });

  it("moves the command on the deadline and says the clock did it", async () => {
    const { harness, dir } = await setup({ [FOREGROUND_TIMEOUT_ENV]: "1" });
    const command = await longCommand(dir);

    const started = Date.now();
    const result = await harness.call("bash", { command });
    const text = resultText(result);

    // No key was pressed: the deadline is what ended the wait, and the line has to
    // say so — otherwise a model cannot tell this from a user's ctrl+shift+b.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(text).toContain("building the site");
    expect(text).toContain("↪ moved to");
    expect(text).toContain("held the front for 1s");
    expect(text).not.toContain("ctrl+shift+b");
    expect((result.structuredContent as { exit_code: number }).exit_code).toBe(0);

    const id = /↪ moved to (\S+)/.exec(text)?.[1];
    expect(id).toBeDefined();
    // The user learns about it without opening the panel: one card, and it says the
    // deadline did this — never the key press, which nobody made.
    expect(harness.entries).toHaveLength(1);
    const card = harness.entries[0]?.data as {
      readonly id?: string;
      readonly trigger?: string;
      readonly afterSeconds?: number;
    };
    expect(card.id).toBe(id);
    expect(card.trigger).toBe("timeout");
    expect(card.afterSeconds).toBeGreaterThanOrEqual(1);
    const drawn = harness.renderEntry(TASK_DETACHED_ENTRY_TYPE, harness.entries[0]?.data);
    expect(drawn).toContain("held the front for");
    expect(drawn).not.toContain("ctrl+shift+b");
    // The command is still running, so no ending has been announced yet.
    expect(harness.messages).toEqual([]);

    await waitFor("the deadline's task to be recorded as running", async () => {
      const task = (await records(dir)).find((record) => record.id === id);
      return task?.kind === "process" && task.status === "running" && task.origin === "foreground";
    });
    await harness.call("pretty_task_bg_kill", { id });
  });

  it("hands the command over in silence when the session shuts down", async () => {
    const { harness, dir } = await setup();
    const command = await writeScript(
      dir.path,
      "brief.mjs",
      ["console.log('compiling');", "setTimeout(() => console.log('all done'), 1500);", ""].join(
        "\n",
      ),
    );
    const pending = harness.call("bash", { command });
    await waitFor(
      "the command to reach the foreground",
      () => harness.controller.foreground.live().length === 1,
    );

    await harness.shutdownSession();
    const text = resultText(await pending);
    expect(text).toContain("↪ moved to");
    expect(text).toContain("shutting down");

    // The record outlives the instance, so the next session follows the id…
    const id = /↪ moved to (\S+)/.exec(text)?.[1];
    expect(id).toBeDefined();
    await waitFor("the record to outlive the session", async () => {
      const task = (await records(dir)).find((record) => record.id === id);
      return task?.kind === "process" && task.status === "running";
    });
    // …and its ending stays unannounced: the session that would have heard it is
    // gone, and a notice sent now would be dropped after being built. Silence here
    // is deliberate — the reload path is what tells the next session (ADR-0020).
    await waitFor("the command to end", async () => {
      const task = (await records(dir)).find((record) => record.id === id);
      return task?.status === "completed";
    });
    expect(harness.messages).toEqual([]);
  });

  it("leaves pi's shell tool alone when the takeover is off", () => {
    const dir = { path: process.cwd(), dispose: async () => undefined };
    const off = createHarness(
      { cwd: dir.path, sessionId: SESSION },
      { env: { ...process.env, [ADOPT_FOREGROUND_ENV]: "off" } },
    );
    expect(off.toolNames).not.toContain("bash");
    // The panel keeps its own "shift+down"; what must be absent is this takeover's key.
    expect(off.shortcutKeys).not.toContain("ctrl+shift+b");
  });
});

afterAll(async () => {
  while (cleanups.length > 0) {
    // A process that was just killed can hold its cwd for a moment on Windows, and
    // a temp directory that outlives the run costs nothing.
    await cleanups
      .pop()?.()
      .catch(() => undefined);
  }
});
