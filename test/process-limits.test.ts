/**
 * Extension seam: a process task runs under limits. Output is capped, runtime is
 * capped when the caller asks for it, and crossing either limit has to be visible
 * as a kill reason instead of a silent truncation or a bare `failed`.
 *
 * The processes here are real: whether the file stops at the cap and whether the
 * tree is gone cannot be answered by a fake spawn.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { stat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_OUTPUT_CAP_BYTES,
  OUTPUT_CAP_ENV,
  parseOutputCapBytes,
} from "../src/tasks/base/settings.js";
import {
  DEFAULT_FOLLOW_SECONDS,
  DEFAULT_WAIT_SECONDS,
  MAX_FOLLOW_SECONDS,
  MAX_WAIT_SECONDS,
  parseFollowSeconds,
  parseWaitSeconds,
} from "../src/tasks/process/limits.js";
import { createHarness, type Harness, resultText } from "./support/extension-harness.js";
import { isAlive, killTree, makeTempDir, waitFor, writeScript } from "./support/processes.js";

interface TaskDetails {
  id: string;
  name: string;
  status: string;
  elapsedMs: number;
  outputBytes: number;
  outputPath: string;
  pid?: number;
  killReason?: string;
}

const cleanup: Array<() => Promise<void>> = [];
const spawned: number[] = [];

afterEach(async () => {
  while (spawned.length > 0) await killTree(spawned.pop());
  while (cleanup.length > 0) await cleanup.pop()?.();
});

function trackPid(details: TaskDetails): void {
  if (details.pid !== undefined) spawned.push(details.pid);
}

async function status(harness: Harness, id: string): Promise<TaskDetails> {
  const result = await harness.call("bg_status", { id });
  return result.details as TaskDetails;
}

async function waitForStatus(harness: Harness, id: string, wanted: string): Promise<TaskDetails> {
  await waitFor(`the task to become ${wanted}`, async () => {
    const view = await status(harness, id);
    return view.status === wanted;
  });
  return status(harness, id);
}

describe("the output cap configuration", () => {
  it("defaults to 20 MiB when the environment says nothing", () => {
    expect(DEFAULT_OUTPUT_CAP_BYTES).toBe(20 * 1024 * 1024);
    expect(parseOutputCapBytes({})).toBe(DEFAULT_OUTPUT_CAP_BYTES);
  });

  it("reads a byte count from the documented key", () => {
    expect(parseOutputCapBytes({ [OUTPUT_CAP_ENV]: "65536" })).toBe(65_536);
  });

  it("names the key and the received value when it is not a positive whole number", () => {
    for (const raw of ["lots", "0", "-1", "1.5", "", "NaN", "Infinity", "9007199254740993"]) {
      let message = "";
      try {
        parseOutputCapBytes({ [OUTPUT_CAP_ENV]: raw });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(OUTPUT_CAP_ENV);
      expect(message).toContain("positive whole number of bytes");
      expect(message).toContain(`received ${JSON.stringify(raw)}`);
    }
  });

  it("fails the extension load instead of turning an invalid value into NaN", () => {
    expect(() =>
      createHarness(
        { cwd: ".", sessionId: "session-bad-cap" },
        { env: { [OUTPUT_CAP_ENV]: "lots" } },
      ),
    ).toThrow(/PI_PRETTY_TASK_OUTPUT_CAP_BYTES.*received "lots"/);
  });
});

describe("the output cap", () => {
  it("stops the task at the cap and both status and logs name the limit", {
    timeout: 40_000,
  }, async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "flood.js",
      [
        "const line = 'x'.repeat(1023) + '\\n';",
        "setInterval(() => {",
        "  for (let i = 0; i < 64; i += 1) process.stdout.write(line);",
        "}, 5);",
        "",
      ].join("\n"),
    );
    const cap = 64 * 1024;
    const harness = createHarness(
      { cwd: dir.path, sessionId: "session-output-cap" },
      { env: { [OUTPUT_CAP_ENV]: String(cap) } },
    );

    const started = await harness.call("bg_run", { command, name: "flood" });
    const task = started.details as TaskDetails;
    trackPid(task);

    const ended = await waitForStatus(harness, task.id, "killed");

    expect(ended.killReason).toBe("output_cap");
    expect(ended.outputBytes).toBe(cap);
    // The file stops on the byte, so a runaway command cannot fill the disk
    // while the stop is travelling.
    await waitFor("the output file to stop at the cap", async () => {
      const info = await stat(ended.outputPath);
      return info.size === cap;
    });
    if (task.pid !== undefined) expect(isAlive(task.pid)).toBe(false);

    const drawn = resultText(await harness.call("bg_status", { id: task.id }));
    expect(drawn).toContain("kill reason: output_cap");
    const logged = resultText(await harness.call("bg_logs", { id: task.id }));
    expect(logged).toContain("kill reason: output_cap");
  });

  it("does not treat output exactly at the cap as exceeding it", { timeout: 40_000 }, async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const cap = 4096;
    const command = await writeScript(
      dir.path,
      "exact.js",
      "process.stdout.write('y'.repeat(4096));\n",
    );
    const harness = createHarness(
      { cwd: dir.path, sessionId: "session-output-at-cap" },
      { env: { [OUTPUT_CAP_ENV]: String(cap) } },
    );

    const started = await harness.call("bg_run", { command, name: "exact" });
    const task = started.details as TaskDetails;
    trackPid(task);

    const ended = await waitForStatus(harness, task.id, "completed");

    expect(ended.outputBytes).toBe(cap);
    expect(ended.killReason).toBeUndefined();
  });
});

describe("the runtime cap", () => {
  it("stops the task when the configured runtime passes and both status and logs name the limit", {
    timeout: 40_000,
  }, async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "sleeper.js", "setInterval(() => {}, 1000);\n");
    const harness = createHarness({ cwd: dir.path, sessionId: "session-runtime-cap" }, {});

    const started = await harness.call("bg_run", {
      command,
      name: "slow build",
      timeoutSeconds: 0.3,
    });
    const task = started.details as TaskDetails;
    trackPid(task);

    const ended = await waitForStatus(harness, task.id, "killed");

    expect(ended.killReason).toBe("timeout");
    expect(ended.elapsedMs).toBeGreaterThanOrEqual(300);
    if (task.pid !== undefined) expect(isAlive(task.pid)).toBe(false);

    const drawn = resultText(await harness.call("bg_status", { id: task.id }));
    expect(drawn).toContain("kill reason: timeout");
    const logged = resultText(await harness.call("bg_logs", { id: task.id }));
    expect(logged).toContain("kill reason: timeout");
  });

  it("reports an invalid runtime instead of starting a task", { timeout: 40_000 }, async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-bad-runtime" }, {});

    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await harness.call("bg_run", { command: "echo hi", timeoutSeconds: bad });
      const drawn = resultText(result);
      expect(drawn).toContain("timeoutSeconds");
      expect(drawn).toContain("positive number of seconds");
      expect(drawn).toContain(`received ${String(bad)}`);
      expect(drawn).toContain("not started");
    }

    const listed = await harness.call("bg_status", {});
    expect((listed.details as { tasks: TaskDetails[] }).tasks).toHaveLength(0);
  });
});

describe("the wait bound", () => {
  it("defaults to a minute and caps an explicit timeout at ten minutes", () => {
    expect(DEFAULT_WAIT_SECONDS).toBe(60);
    expect(MAX_WAIT_SECONDS).toBe(600);
    expect(parseWaitSeconds(undefined)).toBe(60_000);
    expect(parseWaitSeconds(0.3)).toBe(300);
    expect(parseWaitSeconds(MAX_WAIT_SECONDS)).toBe(600_000);
  });

  it("rejects a wait outside the bound", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_WAIT_SECONDS + 1]) {
      expect(() => parseWaitSeconds(bad)).toThrow(/no larger than 600/);
    }
  });
});

describe("the follow window", () => {
  it("defaults to ten seconds and caps an explicit window at one minute", () => {
    expect(DEFAULT_FOLLOW_SECONDS).toBe(10);
    expect(MAX_FOLLOW_SECONDS).toBe(60);
    expect(parseFollowSeconds(undefined)).toBe(10_000);
    expect(parseFollowSeconds(0.4)).toBe(400);
    expect(parseFollowSeconds(MAX_FOLLOW_SECONDS)).toBe(60_000);
  });

  it("rejects a follow window outside the bound", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_FOLLOW_SECONDS + 1]) {
      expect(() => parseFollowSeconds(bad)).toThrow(/no larger than 60/);
    }
  });
});
