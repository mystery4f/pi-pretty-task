/**
 * Settings is the only place the extension reads its environment: these tests
 * build the whole configuration from a plain object, and fail the way a load does.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADOPT_FOREGROUND_ENV,
  AGENT_DIR_ENV,
  DEFAULT_FOREGROUND_TIMEOUT_SECONDS,
  DEFAULT_MAX_RUNNING_TASKS,
  DEFAULT_OUTPUT_CAP_BYTES,
  DEFAULT_RETENTION_DAYS,
  FOREGROUND_TIMEOUT_ENV,
  MAX_FOREGROUND_TIMEOUT_SECONDS,
  MAX_RUNNING_TASKS_ENV,
  NOTIFY_ENV,
  OUTPUT_CAP_ENV,
  RETENTION_DAYS_ENV,
  readSettings,
} from "../../src/tasks/base/settings.js";
import { MAX_TIMEOUT_MS } from "../../src/tasks/process/limits.js";
import { POSIX_SHELL_ENV, SHELL_ENV, SHELL_PATH_ENV } from "../../src/tasks/process/shell.js";
import { createHarness } from "../support/extension-harness.js";

/** Every `.ts` file under `src/`, as paths relative to the repository root. */
async function sourceFiles(): Promise<readonly string[]> {
  const root = fileURLToPath(new URL("../../src", import.meta.url));
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1));
}

describe("settings", () => {
  it("builds the whole configuration from a plain object", () => {
    const settings = readSettings({
      env: {
        [OUTPUT_CAP_ENV]: "65536",
        [NOTIFY_ENV]: "off",
        [RETENTION_DAYS_ENV]: "30",
        [MAX_RUNNING_TASKS_ENV]: "4",
        [AGENT_DIR_ENV]: "/work/agent",
        [SHELL_ENV]: "bash",
        [SHELL_PATH_ENV]: "C:\\Program Files\\Git\\bin\\bash.exe",
      },
      projectDir: "/work/project",
      platform: "win32",
      probe: () => true,
    });
    expect(settings.outputCapBytes).toBe(65_536);
    expect(settings.notify).toBe(false);
    expect(settings.retentionDays).toBe(30);
    expect(settings.maxRunningTasks).toBe(4);
    expect(settings.shellPolicy).toEqual({
      name: "bash",
      executable: "C:\\Program Files\\Git\\bin\\bash.exe",
    });
    expect(settings.templatePaths).toEqual({
      projectFile: join("/work/project", ".pi", "pretty-task.json"),
      agentFile: join("/work/agent", "pretty-task.json"),
    });
  });

  it("falls back to the documented defaults for an environment that says nothing", () => {
    const settings = readSettings({
      env: {},
      projectDir: "/work/project",
      platform: "linux",
      probe: () => true,
    });
    expect(settings.outputCapBytes).toBe(DEFAULT_OUTPUT_CAP_BYTES);
    expect(settings.notify).toBe(true);
    expect(settings.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(settings.maxRunningTasks).toBe(DEFAULT_MAX_RUNNING_TASKS);
    expect(settings.shellPolicy).toEqual({ name: "bash", executable: "/bin/bash" });
    expect(settings.templatePaths.agentFile).toBe(
      join(homedir(), ".pi", "agent", "pretty-task.json"),
    );
  });

  it("expands a home-relative agent directory", () => {
    const settings = readSettings({
      env: { [AGENT_DIR_ENV]: "~/settings" },
      projectDir: "/work/project",
      platform: "linux",
      probe: () => true,
    });
    expect(settings.templatePaths.agentFile).toBe(join(homedir(), "settings", "pretty-task.json"));
  });

  it("accepts on and off for the notification toggle", () => {
    expect(
      readSettings({ env: { [NOTIFY_ENV]: "on" }, platform: "linux", probe: () => true }).notify,
    ).toBe(true);
    expect(
      readSettings({ env: { [NOTIFY_ENV]: "off" }, platform: "linux", probe: () => true }).notify,
    ).toBe(false);
  });

  it("names the key and what it received for a notification value it cannot honour", () => {
    let message = "";
    try {
      readSettings({ env: { [NOTIFY_ENV]: "yes" }, platform: "linux", probe: () => true });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(NOTIFY_ENV);
    expect(message).toContain("on, off");
    expect(message).toContain('does not accept "yes"');
  });

  it("refuses an empty notification value instead of reading it as the default", () => {
    expect(() =>
      readSettings({ env: { [NOTIFY_ENV]: "" }, platform: "linux", probe: () => true }),
    ).toThrow(/PI_PRETTY_TASK_NOTIFY does not accept ""/);
  });

  it("refuses a PI_PRETTY_TASK_ key this version does not read", () => {
    expect(() =>
      readSettings({ env: { PI_PRETTY_TASK_NOTIFYY: "on" }, platform: "linux", probe: () => true }),
    ).toThrow(/PI_PRETTY_TASK_NOTIFYY is not a key this version reads/);
  });

  it("leaves the other platform's shell keys refused, not silently dropped", () => {
    expect(() =>
      readSettings({ env: { [POSIX_SHELL_ENV]: "bash" }, platform: "win32", probe: () => true }),
    ).toThrow(/PI_PRETTY_TASK_POSIX_SHELL does not apply on win32/);
  });

  it("keeps process.env to Settings, so a caller can pass any environment", async () => {
    // Reading a key straight from `process.env` anywhere else is how a test ends up
    // mutating the real environment; `process.env` as a value is fine, a key is not.
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (file === join("tasks", "base", "settings.ts")) continue;
      const text = await readFile(
        fileURLToPath(new URL(`../../src/${file}`, import.meta.url)),
        "utf8",
      );
      if (/process\.env[.[]/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("fails the extension load, not the first task, when a key cannot be honoured", () => {
    expect(() =>
      createHarness(
        { cwd: ".", sessionId: "session-bad-setting" },
        { env: { [NOTIFY_ENV]: "yes" } },
      ),
    ).toThrow(/PI_PRETTY_TASK_NOTIFY does not accept "yes"; it is one of: on, off/);
    expect(() =>
      createHarness({ cwd: ".", sessionId: "session-typo" }, { env: { [OUTPUT_CAP_ENV]: "lots" } }),
    ).toThrow(
      /PI_PRETTY_TASK_OUTPUT_CAP_BYTES must be a positive whole number of bytes; received "lots"/,
    );
  });

  it("caps running process tasks at twenty unless the environment says otherwise", () => {
    // `docs/scope-v1.md` promises at most 20 running tasks; the number lives in
    // one place and the key can move it, the way the other limits do.
    expect(DEFAULT_MAX_RUNNING_TASKS).toBe(20);
    expect(readSettings({ env: {}, platform: "linux", probe: () => true }).maxRunningTasks).toBe(
      20,
    );
    expect(
      readSettings({ env: { [MAX_RUNNING_TASKS_ENV]: "3" }, platform: "linux", probe: () => true })
        .maxRunningTasks,
    ).toBe(3);
  });

  it("refuses a running-task cap that is not a positive whole number of tasks", () => {
    // `0` would refuse every start, `1.5` would round into a cap nobody asked
    // for, and `lots` is `NaN`, which compares false against every count: the
    // limit would never be reached and the promised 20 would silently be gone.
    for (const raw of ["0", "-2", "1.5", "lots", ""]) {
      expect(() =>
        readSettings({
          env: { [MAX_RUNNING_TASKS_ENV]: raw },
          platform: "linux",
          probe: () => true,
        }),
      ).toThrow(
        /PI_PRETTY_TASK_MAX_RUNNING_TASKS must be a positive whole number of tasks; received/,
      );
    }
    expect(() =>
      readSettings({
        env: { [MAX_RUNNING_TASKS_ENV]: "lots" },
        platform: "linux",
        probe: () => true,
      }),
    ).toThrow(/received "lots"/);
  });

  it("keeps the retention window at seven days for an environment that says nothing", () => {
    const settings = readSettings({ env: {}, platform: "linux", probe: () => true });
    expect(settings.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(DEFAULT_RETENTION_DAYS).toBe(7);
  });

  it("refuses a retention window that is not a positive whole number of days", () => {
    // `0` is not "off" and a fraction is not a window: either would turn a typo
    // into a sweep that deletes yesterday's sessions or into no cap at all.
    for (const raw of ["0", "-3", "1.5", "week", ""]) {
      expect(() =>
        readSettings({ env: { [RETENTION_DAYS_ENV]: raw }, platform: "linux", probe: () => true }),
      ).toThrow(/PI_PRETTY_TASK_RETENTION_DAYS must be a positive whole number of days; received/);
    }
    expect(() =>
      readSettings({ env: { [RETENTION_DAYS_ENV]: "1.5" }, platform: "linux", probe: () => true }),
    ).toThrow(/received "1.5"/);
  });
});

describe("foreground takeover", () => {
  it("stays off until the environment turns it on", () => {
    const settings = readSettings({ env: {}, platform: "linux", probe: () => true });
    expect(settings.adoptForeground).toBe(false);
    expect(settings.foregroundTimeoutMs).toBe(DEFAULT_FOREGROUND_TIMEOUT_SECONDS * 1_000);
    expect(DEFAULT_FOREGROUND_TIMEOUT_SECONDS).toBe(0);
  });

  it("reads both values from the environment", () => {
    const settings = readSettings({
      env: { [ADOPT_FOREGROUND_ENV]: "on", [FOREGROUND_TIMEOUT_ENV]: "90" },
      platform: "linux",
      probe: () => true,
    });
    expect(settings.adoptForeground).toBe(true);
    expect(settings.foregroundTimeoutMs).toBe(90_000);
  });

  it("refuses a takeover value that is not one of the two words", () => {
    // A typo such as `true` must not quietly take over pi's shell tools: the
    // takeover changes how every command runs, so it has to be asked for.
    for (const raw of ["true", "ON ", "1", "yes", ""]) {
      expect(() =>
        readSettings({
          env: { [ADOPT_FOREGROUND_ENV]: raw },
          platform: "linux",
          probe: () => true,
        }),
      ).toThrow(/PI_PRETTY_TASK_ADOPT_FOREGROUND does not accept/);
    }
  });

  it("refuses a timeout that is not whole seconds, and keeps 0 for off", () => {
    expect(
      readSettings({ env: { [FOREGROUND_TIMEOUT_ENV]: "0" }, platform: "linux", probe: () => true })
        .foregroundTimeoutMs,
    ).toBe(0);
    for (const raw of ["-5", "1.5", "minute", ""]) {
      expect(() =>
        readSettings({
          env: { [FOREGROUND_TIMEOUT_ENV]: raw },
          platform: "linux",
          probe: () => true,
        }),
      ).toThrow(/PI_PRETTY_TASK_FOREGROUND_TIMEOUT must be a whole number of seconds/);
    }
  });

  it("refuses a timeout longer than setTimeout can count", () => {
    // Past the engine's ceiling the timer fires at once, which would turn "detach
    // after N minutes" into "detach every command immediately".
    expect(MAX_FOREGROUND_TIMEOUT_SECONDS).toBe(Math.floor(MAX_TIMEOUT_MS / 1000));
    expect(
      readSettings({
        env: { [FOREGROUND_TIMEOUT_ENV]: String(MAX_FOREGROUND_TIMEOUT_SECONDS) },
        platform: "linux",
        probe: () => true,
      }).foregroundTimeoutMs,
    ).toBe(MAX_FOREGROUND_TIMEOUT_SECONDS * 1000);
    expect(() =>
      readSettings({
        env: { [FOREGROUND_TIMEOUT_ENV]: String(MAX_FOREGROUND_TIMEOUT_SECONDS + 1) },
        platform: "linux",
        probe: () => true,
      }),
    ).toThrow(/no larger than/);
  });
});
