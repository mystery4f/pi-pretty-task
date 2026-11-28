/**
 * Settings is the only place the extension reads its environment: these tests
 * build the whole configuration from a plain object, and fail the way a load does.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADOPT_FOREGROUND_ENV,
  AGENT_DIR_ENV,
  DEFAULT_FOREGROUND_TIMEOUT_SECONDS,
  DEFAULT_MAX_RUNNING_TASKS,
  DEFAULT_OUTPUT_CAP_BYTES,
  DEFAULT_RETENTION_DAYS,
  FOREGROUND_TIMEOUT_ENV,
  isReloadRequiredSetting,
  isSettingShadowedByEnv,
  MAX_FOREGROUND_TIMEOUT_SECONDS,
  MAX_RUNNING_TASKS_ENV,
  NOTIFY_ENV,
  OUTPUT_CAP_ENV,
  RETENTION_DAYS_ENV,
  readSettings,
  writeSettingsFile,
} from "../../src/tasks/base/settings.js";
import { MAX_TIMEOUT_MS } from "../../src/tasks/process/limits.js";
import {
  POSIX_SHELL_ENV,
  POSIX_SHELL_PATH_ENV,
  SHELL_ENV,
  SHELL_PATH_ENV,
} from "../../src/tasks/process/shell.js";
import { templateConfigPaths } from "../../src/tasks/process/templates.js";
import { TasksPanel } from "../../src/ui/panel/tasks-panel.js";
import { createHarness } from "../support/extension-harness.js";
import { makeTempDir } from "../support/processes.js";

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

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("four-layer settings precedence and file validation (ADR-0029)", () => {
  it("merges all 10 settings across env > project > agent > default with exact provenance", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const projectDir = join(dir.path, "project");
    const agentDir = join(dir.path, "agent");
    const paths = templateConfigPaths(projectDir, agentDir);

    // Layer 4: default (no files, no env)
    const winDefault = readSettings({
      env: {},
      projectDir,
      agentDir,
      platform: "win32",
      probe: () => true,
    });
    expect(winDefault.outputCapBytes).toBe(DEFAULT_OUTPUT_CAP_BYTES);
    expect(winDefault.maxRunningTasks).toBe(DEFAULT_MAX_RUNNING_TASKS);
    expect(winDefault.notify).toBe(true);
    expect(winDefault.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(winDefault.adoptForeground).toBe(false);
    expect(winDefault.foregroundTimeoutSeconds).toBe(DEFAULT_FOREGROUND_TIMEOUT_SECONDS);
    expect(winDefault.shellPolicy.name).toBe("bash");
    expect(winDefault.sources.outputCapBytes).toBe("default");
    expect(winDefault.sources.shell).toBe("default");
    expect(winDefault.sources.shellPath).toBe("default");

    // Layer 3: agent pretty-task.json sets all 8 Windows keys
    await writeJson(paths.agentFile, {
      settings: {
        outputCapBytes: 1024,
        maxRunningTasks: 5,
        notify: "off",
        retentionDays: 14,
        adoptForeground: "on",
        foregroundTimeoutSeconds: 30,
        shell: "cmd",
        shellPath: "C:\\Windows\\System32\\cmd.exe",
      },
    });
    const fromAgent = readSettings({
      env: {},
      projectDir,
      agentDir,
      platform: "win32",
      probe: () => true,
    });
    expect(fromAgent.outputCapBytes).toBe(1024);
    expect(fromAgent.maxRunningTasks).toBe(5);
    expect(fromAgent.notify).toBe(false);
    expect(fromAgent.retentionDays).toBe(14);
    expect(fromAgent.adoptForeground).toBe(true);
    expect(fromAgent.foregroundTimeoutSeconds).toBe(30);
    expect(fromAgent.shellPolicy).toEqual({
      name: "cmd",
      executable: "C:\\Windows\\System32\\cmd.exe",
    });
    for (const key of [
      "outputCapBytes",
      "maxRunningTasks",
      "notify",
      "retentionDays",
      "adoptForeground",
      "foregroundTimeoutSeconds",
      "shell",
      "shellPath",
    ] as const) {
      expect(fromAgent.sources[key]).toBe("agent");
    }

    // Layer 2: project .pi/pretty-task.json overrides a subset and the shell pair
    await writeJson(paths.projectFile, {
      settings: {
        outputCapBytes: 2048,
        maxRunningTasks: 8,
        notify: "on",
        retentionDays: 21,
        adoptForeground: "off",
        foregroundTimeoutSeconds: 60,
        shell: "bash",
        shellPath: "C:\\Git\\bin\\bash.exe",
      },
    });
    const fromProject = readSettings({
      env: {},
      projectDir,
      agentDir,
      platform: "win32",
      probe: () => true,
    });
    expect(fromProject.outputCapBytes).toBe(2048);
    expect(fromProject.maxRunningTasks).toBe(8);
    expect(fromProject.notify).toBe(true);
    expect(fromProject.retentionDays).toBe(21);
    expect(fromProject.adoptForeground).toBe(false);
    expect(fromProject.foregroundTimeoutSeconds).toBe(60);
    expect(fromProject.shellPolicy).toEqual({
      name: "bash",
      executable: "C:\\Git\\bin\\bash.exe",
    });
    for (const key of [
      "outputCapBytes",
      "maxRunningTasks",
      "notify",
      "retentionDays",
      "adoptForeground",
      "foregroundTimeoutSeconds",
      "shell",
      "shellPath",
    ] as const) {
      expect(fromProject.sources[key]).toBe("project");
    }

    // Layer 1: process.env overrides everything above it
    const fromEnv = readSettings({
      env: {
        [OUTPUT_CAP_ENV]: "4096",
        [MAX_RUNNING_TASKS_ENV]: "12",
        [NOTIFY_ENV]: "off",
        [RETENTION_DAYS_ENV]: "30",
        [ADOPT_FOREGROUND_ENV]: "on",
        [FOREGROUND_TIMEOUT_ENV]: "120",
        [SHELL_ENV]: "cmd",
        [SHELL_PATH_ENV]: "D:\\Tools\\cmd.exe",
      },
      projectDir,
      agentDir,
      platform: "win32",
      probe: () => true,
    });
    expect(fromEnv.outputCapBytes).toBe(4096);
    expect(fromEnv.maxRunningTasks).toBe(12);
    expect(fromEnv.notify).toBe(false);
    expect(fromEnv.retentionDays).toBe(30);
    expect(fromEnv.adoptForeground).toBe(true);
    expect(fromEnv.foregroundTimeoutSeconds).toBe(120);
    expect(fromEnv.shellPolicy).toEqual({ name: "cmd", executable: "D:\\Tools\\cmd.exe" });
    for (const key of [
      "outputCapBytes",
      "maxRunningTasks",
      "notify",
      "retentionDays",
      "adoptForeground",
      "foregroundTimeoutSeconds",
      "shell",
      "shellPath",
    ] as const) {
      expect(fromEnv.sources[key]).toBe("env");
      expect(isSettingShadowedByEnv(key, fromEnv)).toBe(true);
    }

    // POSIX shell pair (posixShell + posixShellPath) across all 4 layers
    const posixDir = await makeTempDir();
    cleanup.push(posixDir.dispose);
    const posixProject = join(posixDir.path, "project");
    const posixAgent = join(posixDir.path, "agent");
    const posixPaths = templateConfigPaths(posixProject, posixAgent);

    const posixDefault = readSettings({
      env: {},
      projectDir: posixProject,
      agentDir: posixAgent,
      platform: "linux",
      probe: () => true,
    });
    expect(posixDefault.shellPolicy.name).toBe("bash");
    expect(posixDefault.sources.posixShell).toBe("default");
    expect(posixDefault.sources.posixShellPath).toBe("default");

    await writeJson(posixPaths.agentFile, {
      settings: {
        posixShell: "sh",
        posixShellPath: "/bin/sh",
      },
    });
    const posixFromAgent = readSettings({
      env: {},
      projectDir: posixProject,
      agentDir: posixAgent,
      platform: "linux",
      probe: () => true,
    });
    expect(posixFromAgent.shellPolicy).toEqual({ name: "sh", executable: "/bin/sh" });
    expect(posixFromAgent.sources.posixShell).toBe("agent");
    expect(posixFromAgent.sources.posixShellPath).toBe("agent");

    await writeJson(posixPaths.projectFile, {
      settings: {
        posixShell: "bash",
        posixShellPath: "/usr/local/bin/bash",
      },
    });
    const posixFromProject = readSettings({
      env: {},
      projectDir: posixProject,
      agentDir: posixAgent,
      platform: "linux",
      probe: () => true,
    });
    expect(posixFromProject.shellPolicy).toEqual({
      name: "bash",
      executable: "/usr/local/bin/bash",
    });
    expect(posixFromProject.sources.posixShell).toBe("project");
    expect(posixFromProject.sources.posixShellPath).toBe("project");

    const posixFromEnv = readSettings({
      env: {
        [POSIX_SHELL_ENV]: "sh",
        [POSIX_SHELL_PATH_ENV]: "/custom/sh",
      },
      projectDir: posixProject,
      agentDir: posixAgent,
      platform: "linux",
      probe: () => true,
    });
    expect(posixFromEnv.shellPolicy).toEqual({ name: "sh", executable: "/custom/sh" });
    expect(posixFromEnv.sources.posixShell).toBe("env");
    expect(posixFromEnv.sources.posixShellPath).toBe("env");
  });

  it("treats (shell, shellPath) as an atomic per-layer pair and refuses cross-layer unpaired paths", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const projectDir = join(dir.path, "project");
    const agentDir = join(dir.path, "agent");
    const paths = templateConfigPaths(projectDir, agentDir);

    // Agent sets shell + shellPath; project sets ONLY shell: "cmd" (no shellPath).
    // Project wins the whole pair, so agent's bash.exe path is NOT inherited into cmd!
    await writeJson(paths.agentFile, {
      settings: {
        shell: "bash",
        shellPath: "C:\\Git\\bin\\bash.exe",
      },
    });
    await writeJson(paths.projectFile, {
      settings: {
        shell: "cmd",
      },
    });
    const resolved = readSettings({
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      projectDir,
      agentDir,
      platform: "win32",
      probe: () => true,
    });
    expect(resolved.shellPolicy).toEqual({
      name: "cmd",
      executable: "C:\\Windows\\System32\\cmd.exe",
    });
    expect(resolved.sources.shell).toBe("project");
    expect(resolved.sources.shellPath).toBe("default");
    expect(resolved.effective.shellPath).toBeUndefined();

    // When env sets PI_PRETTY_TASK_SHELL without PI_PRETTY_TASK_SHELL_PATH, env wins the
    // whole pair and shadows shellPath in files as well.
    const envWinsPair = readSettings({
      env: {
        [SHELL_ENV]: "bash",
        EXEPATH: "C:\\Program Files\\Git\\bin",
      },
      projectDir,
      agentDir,
      platform: "win32",
      probe: () => true,
    });
    expect(envWinsPair.sources.shell).toBe("env");
    expect(envWinsPair.sources.shellPath).toBe("default");
    expect(isSettingShadowedByEnv("shellPath", envWinsPair)).toBe(true);

    // Project sets shellPath WITHOUT shell in project file (even though agent has shell): refused!
    await writeJson(paths.projectFile, {
      settings: {
        shellPath: "C:\\Git\\bin\\bash.exe",
      },
    });
    expect(() =>
      readSettings({
        env: {},
        projectDir,
        agentDir,
        platform: "win32",
        probe: () => true,
      }),
    ).toThrow(/settings\.shellPath is set without settings\.shell/);

    // Env sets PI_PRETTY_TASK_SHELL_PATH without PI_PRETTY_TASK_SHELL (even though agent has shell): refused!
    await writeJson(paths.projectFile, {});
    expect(() =>
      readSettings({
        env: { [SHELL_PATH_ENV]: "C:\\Git\\bin\\bash.exe" },
        projectDir,
        agentDir,
        platform: "win32",
        probe: () => true,
      }),
    ).toThrow(/PI_PRETTY_TASK_SHELL_PATH is set without PI_PRETTY_TASK_SHELL/);
  });

  it("refuses unknown keys, invalid types, out-of-range values, and foreign-platform shell keys in pretty-task.json", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const projectDir = join(dir.path, "project");
    const agentDir = join(dir.path, "agent");
    const paths = templateConfigPaths(projectDir, agentDir);

    // Unknown top-level key
    await writeJson(paths.projectFile, { unknownTop: {} });
    expect(() =>
      readSettings({ env: {}, projectDir, agentDir, platform: "linux", probe: () => true }),
    ).toThrow(/unsupported field "unknownTop"/);

    // Non-object settings
    await writeJson(paths.projectFile, { settings: [] });
    expect(() =>
      readSettings({ env: {}, projectDir, agentDir, platform: "linux", probe: () => true }),
    ).toThrow(/settings must be an object/);

    // Unknown key inside settings
    await writeJson(paths.projectFile, { settings: { notifyy: "on" } });
    expect(() =>
      readSettings({ env: {}, projectDir, agentDir, platform: "linux", probe: () => true }),
    ).toThrow(/settings\.notifyy is not a key this version reads/);

    // Invalid scalar values
    const badCases: ReadonlyArray<readonly [Record<string, unknown>, RegExp]> = [
      [{ outputCapBytes: 0 }, /settings\.outputCapBytes must be a positive whole number/],
      [{ outputCapBytes: "1024" }, /settings\.outputCapBytes must be a positive whole number/],
      [{ maxRunningTasks: -1 }, /settings\.maxRunningTasks must be a positive whole number/],
      [{ notify: true }, /settings\.notify does not accept true/],
      [{ retentionDays: 1.5 }, /settings\.retentionDays must be a positive whole number/],
      [{ adoptForeground: "yes" }, /settings\.adoptForeground does not accept "yes"/],
      [
        { foregroundTimeoutSeconds: -1 },
        /settings\.foregroundTimeoutSeconds must be a whole number of seconds/,
      ],
      [
        { foregroundTimeoutSeconds: MAX_FOREGROUND_TIMEOUT_SECONDS + 1 },
        /settings\.foregroundTimeoutSeconds must be a whole number of seconds/,
      ],
      [{ posixShell: "zsh" }, /settings\.posixShell does not accept "zsh"/],
      [
        { posixShell: "bash", posixShellPath: "relative/bash" },
        /settings\.posixShellPath must be an absolute path/,
      ],
    ];
    for (const [badSettings, pattern] of badCases) {
      await writeJson(paths.projectFile, { settings: badSettings });
      expect(() =>
        readSettings({ env: {}, projectDir, agentDir, platform: "linux", probe: () => true }),
      ).toThrow(pattern);
    }

    // Foreign-platform shell keys in JSON
    await writeJson(paths.projectFile, { settings: { shell: "bash" } });
    expect(() =>
      readSettings({ env: {}, projectDir, agentDir, platform: "linux", probe: () => true }),
    ).toThrow(/settings\.shell does not apply on linux/);

    await writeJson(paths.projectFile, { settings: { posixShell: "bash" } });
    expect(() =>
      readSettings({ env: {}, projectDir, agentDir, platform: "win32", probe: () => true }),
    ).toThrow(/settings\.posixShell does not apply on win32/);
  });

  it("preserves templates via writeAtomic and reflects provenance and reload boundaries in the TUI", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const projectDir = join(dir.path, "project");
    const agentDir = join(dir.path, "agent");
    const paths = templateConfigPaths(projectDir, agentDir);

    const existingTemplates = {
      test: { command: "npm test", cwd: "packages/app", timeoutSeconds: 180 },
      lint: { command: "npm run lint" },
    };
    await writeJson(paths.projectFile, {
      templates: existingTemplates,
      settings: {
        maxRunningTasks: 10,
      },
    });
    await writeJson(paths.agentFile, {
      settings: {
        retentionDays: 14,
      },
    });

    let current = readSettings({
      env: { [NOTIFY_ENV]: "off" },
      projectDir,
      agentDir,
      platform: "win32",
      probe: () => true,
    });

    const panel = new TasksPanel({
      tui: { requestRender: () => undefined, terminal: { rows: 45 } },
      theme: {
        fg: (_c: string, t: string) => t,
        bg: (_c: string, t: string) => t,
        bold: (t: string) => t,
        italic: (t: string) => t,
        underline: (t: string) => t,
        inverse: (t: string) => t,
        strikethrough: (t: string) => t,
      } as never,
      done: () => undefined,
      refreshMs: 0,
      source: {
        list: async () => [],
        tail: async () => undefined,
        stop: async () => undefined,
        settings: () => current,
        updateSettings: async (scope, patch) => {
          const target = scope === "project" ? paths.projectFile : paths.agentFile;
          await writeSettingsFile(target, patch, { platform: "win32", probe: () => true });
          current = readSettings({
            env: { [NOTIFY_ENV]: "off" },
            projectDir,
            agentDir,
            platform: "win32",
            probe: () => true,
          });
          return current;
        },
      },
    });
    await panel.settle();

    // Press `s` from the list to enter settings mode
    panel.handleInput("s");
    await panel.settle();
    expect(panel.mode).toBe("settings");

    const initialScreen = panel.render(130).join("\n");
    // Provenance badges for all four sources are rendered
    expect(initialScreen).toContain("[env]");
    expect(initialScreen).toContain("[project]");
    expect(initialScreen).toContain("[agent]");
    expect(initialScreen).toContain("[default]");
    // Live vs requires /reload boundaries are rendered
    expect(initialScreen).toContain("requires /reload");
    expect(initialScreen).toContain("live");
    expect(isReloadRequiredSetting("adoptForeground")).toBe(true);
    expect(isReloadRequiredSetting("retentionDays")).toBe(true);
    expect(isReloadRequiredSetting("maxRunningTasks")).toBe(false);
    // Env shadow badge is shown on notify
    expect(initialScreen).toContain("shadowed by PI_PRETTY_TASK_NOTIFY");

    // Move down to `adoptForeground` (index 4: outputCapBytes=0, maxRunningTasks=1, notify=2, retentionDays=3, adoptForeground=4)
    for (let i = 0; i < 4; i += 1) panel.handleInput("\u001b[B");
    // Press Enter to toggle adoptForeground from "off" to "on" in project scope
    panel.handleInput("\r");
    await panel.settle();

    expect(current.adoptForeground).toBe(true);
    expect(current.sources.adoptForeground).toBe("project");
    expect(panel.notice).toContain("requires /reload");

    // Verify project file on disk still contains the exact `templates` object alongside updated `settings`
    const savedProjectJson = JSON.parse(await readFile(paths.projectFile, "utf8")) as {
      templates: unknown;
      settings: Record<string, unknown>;
    };
    expect(savedProjectJson.templates).toEqual(existingTemplates);
    expect(savedProjectJson.settings).toEqual({
      maxRunningTasks: 10,
      adoptForeground: "on",
    });

    // Move up to `maxRunningTasks` (index 1) and press `d` to clear it from project file;
    // it falls back to default (20) while `templates` remains intact
    for (let i = 0; i < 3; i += 1) panel.handleInput("\u001b[A");
    panel.handleInput("d");
    await panel.settle();

    expect(current.maxRunningTasks).toBe(DEFAULT_MAX_RUNNING_TASKS);
    expect(current.sources.maxRunningTasks).toBe("default");
    expect(panel.notice).toContain("active immediately");

    const afterClearJson = JSON.parse(await readFile(paths.projectFile, "utf8")) as {
      templates: unknown;
      settings: Record<string, unknown>;
    };
    expect(afterClearJson.templates).toEqual(existingTemplates);
    expect(afterClearJson.settings).toEqual({
      adoptForeground: "on",
    });

    // Press `←` to return to the list
    panel.handleInput("\u001b[D");
    expect(panel.mode).toBe("list");
    panel.dispose();
  });
});
