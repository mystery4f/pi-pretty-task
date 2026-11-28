/**
 * The extension's configuration, read once from one explicit environment.
 *
 * Every environment-derived option lives here and nowhere else: the output byte
 * cap, the running-task cap, the shell policy, the notification toggle, and the
 * agent settings directory templates come from. `src/index.ts` builds one `Settings` before it
 * registers anything and hands the value down, so a module never reads
 * `process.env` for a key on its own and a test builds the whole configuration
 * from a plain object instead of mutating the process environment.
 *
 * A value that cannot be honoured fails the load with a message naming the key,
 * what it accepts, and what it received. A `PI_PRETTY_TASK_*` key this version
 * does not read is an error too: a misspelt name would otherwise be a setting the
 * user believes in and the extension silently ignores.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix as posixPath, win32 as windowsPath } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { MAX_TIMEOUT_MS } from "../process/limits.js";
import {
  type CommandRunner,
  defaultProbe,
  type ExecutableProbe,
  POSIX_SHELL_ENV,
  POSIX_SHELL_PATH_ENV,
  POSIX_SHELLS,
  type PosixShellName,
  resolveShellPolicy,
  SHELL_ENV,
  SHELL_PATH_ENV,
  type ShellPolicy,
  WINDOWS_SHELLS,
  type WindowsShellName,
} from "../process/shell.js";
import { type TemplateConfigPaths, templateConfigPaths } from "../process/templates.js";
import { writeAtomic } from "./atomic.js";

/** Bytes of output one process task keeps before the cap stops it. */
export const DEFAULT_OUTPUT_CAP_BYTES = 20 * 1024 * 1024;

/** Bytes of output one process task keeps; see `docs/configuration.md`. */
export const OUTPUT_CAP_ENV = "PI_PRETTY_TASK_OUTPUT_CAP_BYTES";

/** Whether an ending task may raise a terminal notification: `on` or `off`. */
export const NOTIFY_ENV = "PI_PRETTY_TASK_NOTIFY";

/** Days a finished session's records and output are kept before they are reclaimed. */
export const DEFAULT_RETENTION_DAYS = 7;

/** The retention window in whole days; see `docs/configuration.md`. */
export const RETENTION_DAYS_ENV = "PI_PRETTY_TASK_RETENTION_DAYS";

/** Process tasks one session may run at once; the promise `docs/scope-v1.md` makes. */
export const DEFAULT_MAX_RUNNING_TASKS = 20;

/** The running-task cap in whole tasks; see `docs/configuration.md`. */
export const MAX_RUNNING_TASKS_ENV = "PI_PRETTY_TASK_MAX_RUNNING_TASKS";

/** Whether the built-in shell tools and `!` commands are taken over: `on` or `off`. */
export const ADOPT_FOREGROUND_ENV = "PI_PRETTY_TASK_ADOPT_FOREGROUND";

/** Seconds a foreground run may hold the turn before it detaches; `0` keeps waiting. */
export const DEFAULT_FOREGROUND_TIMEOUT_SECONDS = 0;

/** The foreground detach timeout in whole seconds; see `docs/configuration.md`. */
export const FOREGROUND_TIMEOUT_ENV = "PI_PRETTY_TASK_FOREGROUND_TIMEOUT";

/** Longest detach delay `setTimeout` counts, in whole seconds; a longer one fires at once. */
export const MAX_FOREGROUND_TIMEOUT_SECONDS = Math.floor(MAX_TIMEOUT_MS / 1000);

/** pi's own settings directory; `pretty-task.json` is read from it. */
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Every `PI_PRETTY_TASK_*` key this version reads. Anything else is a typo. */
const KNOWN_KEYS: readonly string[] = [
  OUTPUT_CAP_ENV,
  NOTIFY_ENV,
  RETENTION_DAYS_ENV,
  MAX_RUNNING_TASKS_ENV,
  SHELL_ENV,
  SHELL_PATH_ENV,
  POSIX_SHELL_ENV,
  POSIX_SHELL_PATH_ENV,
  ADOPT_FOREGROUND_ENV,
  FOREGROUND_TIMEOUT_ENV,
];

const KEY_PREFIX = "PI_PRETTY_TASK_";

/** The four configuration layers, ordered from highest to lowest precedence (ADR-0029). */
export type SettingSource = "env" | "project" | "agent" | "default";

/** The two writable configuration file scopes. */
export type SettingScope = "project" | "agent";

/**
 * Normalized shape of the `"settings"` object inside `pretty-task.json`
 * (or the equivalent values parsed from one layer).
 */
export interface SettingsFileLayer {
  readonly outputCapBytes?: number;
  readonly maxRunningTasks?: number;
  readonly notify?: "on" | "off";
  readonly retentionDays?: number;
  readonly adoptForeground?: "on" | "off";
  readonly foregroundTimeoutSeconds?: number;
  readonly shell?: WindowsShellName;
  readonly shellPath?: string;
  readonly posixShell?: PosixShellName;
  readonly posixShellPath?: string;
}

/** The ten canonical setting keys in `"settings"` inside `pretty-task.json`. */
export type SettingKey = keyof SettingsFileLayer;

/** All ten setting keys accepted inside `"settings"` in `pretty-task.json`. */
export const KNOWN_SETTING_KEYS: readonly SettingKey[] = [
  "outputCapBytes",
  "maxRunningTasks",
  "notify",
  "retentionDays",
  "adoptForeground",
  "foregroundTimeoutSeconds",
  "shell",
  "shellPath",
  "posixShell",
  "posixShellPath",
];

/** Map from each `"settings"` JSON key to its frozen `PI_PRETTY_TASK_*` environment variable. */
export const SETTING_ENV_BY_KEY: Readonly<Record<SettingKey, string>> = {
  outputCapBytes: OUTPUT_CAP_ENV,
  maxRunningTasks: MAX_RUNNING_TASKS_ENV,
  notify: NOTIFY_ENV,
  retentionDays: RETENTION_DAYS_ENV,
  adoptForeground: ADOPT_FOREGROUND_ENV,
  foregroundTimeoutSeconds: FOREGROUND_TIMEOUT_ENV,
  shell: SHELL_ENV,
  shellPath: SHELL_PATH_ENV,
  posixShell: POSIX_SHELL_ENV,
  posixShellPath: POSIX_SHELL_PATH_ENV,
};

/** Settings whose effect happens only at extension startup and therefore require `/reload`. */
export const RELOAD_REQUIRED_SETTING_KEYS: readonly SettingKey[] = [
  "adoptForeground",
  "retentionDays",
];

/** Whether changing this setting in `pretty-task.json` requires `/reload` to take effect. */
export function isReloadRequiredSetting(key: SettingKey): boolean {
  return RELOAD_REQUIRED_SETTING_KEYS.includes(key);
}

/** Setting keys applicable to the given platform (hiding the other platform's shell pair). */
export function settingKeysForPlatform(platform: NodeJS.Platform): readonly SettingKey[] {
  return platform === "win32"
    ? [
        "outputCapBytes",
        "maxRunningTasks",
        "notify",
        "retentionDays",
        "adoptForeground",
        "foregroundTimeoutSeconds",
        "shell",
        "shellPath",
      ]
    : [
        "outputCapBytes",
        "maxRunningTasks",
        "notify",
        "retentionDays",
        "adoptForeground",
        "foregroundTimeoutSeconds",
        "posixShell",
        "posixShellPath",
      ];
}

/**
 * Whether a file edit to `key` is currently shadowed by `process.env`.
 *
 * Because `(*Shell, *ShellPath)` merges as an atomic pair from the highest layer
 * defining `*Shell`, setting `PI_PRETTY_TASK_SHELL` (or `PI_PRETTY_TASK_POSIX_SHELL`)
 * in the environment also shadows any `*ShellPath` written in `pretty-task.json`.
 */
export function isSettingShadowedByEnv(key: SettingKey, settings: Settings): boolean {
  if (settings.sources[key] === "env") return true;
  if (key === "shellPath" && settings.sources.shell === "env") return true;
  if (key === "posixShellPath" && settings.sources.posixShell === "env") return true;
  return false;
}

/** The whole configuration, as one value handed down from the entry point. */
export interface Settings {
  /** Bytes of output a process task keeps before the cap stops it. */
  readonly outputCapBytes: number;
  /** The shell a process task runs in, resolved once so a bad value fails the load. */
  readonly shellPolicy: ShellPolicy;
  /** Whether an ending task may write a terminal notification. */
  readonly notify: boolean;
  /** Days a finished session is kept before pruning reclaims it; never zero. */
  readonly retentionDays: number;
  /**
   * How many process tasks this session may run at once, children included: a
   * fire and a chain step are processes too, so they count against the same
   * ceiling (ADR-0014).
   */
  readonly maxRunningTasks: number;
  /**
   * Whether the built-in `bash`/`powershell` tools and `!` commands are taken
   * over. Only a process this extension spawned carries a handle that can be let
   * go, so without the takeover there is nothing to detach (ADR-0020).
   */
  readonly adoptForeground: boolean;
  /**
   * Milliseconds a foreground run may hold the turn before it detaches to a
   * task; `0` never detaches, which is the default. The tool's own `timeout`
   * parameter is a different thing: that one kills.
   */
  readonly foregroundTimeoutMs: number;
  /** Whole seconds corresponding to `foregroundTimeoutMs`. */
  readonly foregroundTimeoutSeconds: number;
  /** Where the named templates and file settings are read from: project first, then agent dir. */
  readonly templatePaths: TemplateConfigPaths;
  /** Target platform these settings were resolved for. */
  readonly platform: NodeJS.Platform;
  /** Which of the four layers (`env` > `project` > `agent` > `default`) supplied each setting. */
  readonly sources: Readonly<Record<SettingKey, SettingSource>>;
  /** Raw normalized values from each of the four layers before merging. */
  readonly layers: {
    readonly env: SettingsFileLayer;
    readonly project: SettingsFileLayer;
    readonly agent: SettingsFileLayer;
    readonly default: SettingsFileLayer;
  };
  /** Merged canonical values across all four layers. */
  readonly effective: SettingsFileLayer;
}

/** Where a `Settings` is built from; every field has a production default. */
export interface SettingsOptions {
  /** The environment to read; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Project root holding `.pi/pretty-task.json`; defaults to the working directory. */
  readonly projectDir?: string;
  /** Agent settings directory; defaults to `AGENT_DIR_ENV` or pi's own default. */
  readonly agentDir?: string;
  /** Test seams forwarded to the shell policy: which platform, what is executable, and what `where`/`reg` report. */
  readonly platform?: NodeJS.Platform;
  readonly probe?: ExecutableProbe;
  readonly run?: CommandRunner;
}

const SCALAR_KEYS = [
  "outputCapBytes",
  "maxRunningTasks",
  "notify",
  "retentionDays",
  "adoptForeground",
  "foregroundTimeoutSeconds",
] as const;

const TOP_LEVEL_CONFIG_KEYS: ReadonlySet<string> = new Set(["settings", "templates"]);

/**
 * Read the whole configuration across all four layers (`env` > `project` > `agent` > `default`).
 * Throws on the first value that cannot be honoured, so a bad environment or bad
 * `"settings"` block stops the extension from loading rather than every task it would start.
 */
export function readSettings(options: SettingsOptions = {}): Settings {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? defaultProbe(platform);
  rejectUnknownKeys(env);

  const agentDir = options.agentDir ?? parseAgentDir(env);
  const templatePaths = templateConfigPaths(options.projectDir ?? process.cwd(), agentDir);

  const envLayer = parseEnvSettingsLayer(env, platform, probe);
  const projectLayer = readSettingsFileLayer(templatePaths.projectFile, platform, probe);
  const agentLayer = readSettingsFileLayer(templatePaths.agentFile, platform, probe);
  const defaultLayer = defaultSettingsLayer(platform);

  const orderedLayers: ReadonlyArray<readonly [SettingSource, SettingsFileLayer]> = [
    ["env", envLayer],
    ["project", projectLayer],
    ["agent", agentLayer],
  ];

  const sources: Record<SettingKey, SettingSource> = {
    outputCapBytes: "default",
    maxRunningTasks: "default",
    notify: "default",
    retentionDays: "default",
    adoptForeground: "default",
    foregroundTimeoutSeconds: "default",
    shell: "default",
    shellPath: "default",
    posixShell: "default",
    posixShellPath: "default",
  };
  const effective: Record<string, unknown> = {};

  for (const key of SCALAR_KEYS) {
    const hit = orderedLayers.find(([, layer]) => layer[key] !== undefined);
    if (hit !== undefined) {
      sources[key] = hit[0];
      effective[key] = hit[1][key];
    } else {
      sources[key] = "default";
      effective[key] = defaultLayer[key];
    }
  }

  if (platform === "win32") {
    const hit = orderedLayers.find(([, layer]) => layer.shell !== undefined);
    if (hit !== undefined) {
      const [source, layer] = hit;
      sources.shell = source;
      effective.shell = layer.shell;
      if (layer.shellPath !== undefined) {
        sources.shellPath = source;
        effective.shellPath = layer.shellPath;
      }
    } else {
      effective.shell = defaultLayer.shell;
    }
  } else {
    const hit = orderedLayers.find(([, layer]) => layer.posixShell !== undefined);
    if (hit !== undefined) {
      const [source, layer] = hit;
      sources.posixShell = source;
      effective.posixShell = layer.posixShell;
      if (layer.posixShellPath !== undefined) {
        sources.posixShellPath = source;
        effective.posixShellPath = layer.posixShellPath;
      }
    } else {
      effective.posixShell = defaultLayer.posixShell;
    }
  }

  const typedEffective = effective as SettingsFileLayer;
  const shellEnv: NodeJS.ProcessEnv = { ...env };
  delete shellEnv[SHELL_ENV];
  delete shellEnv[SHELL_PATH_ENV];
  delete shellEnv[POSIX_SHELL_ENV];
  delete shellEnv[POSIX_SHELL_PATH_ENV];

  if (platform === "win32") {
    if (sources.shell !== "default" && typedEffective.shell !== undefined) {
      shellEnv[SHELL_ENV] = typedEffective.shell;
      if (typedEffective.shellPath !== undefined) {
        shellEnv[SHELL_PATH_ENV] = typedEffective.shellPath;
      }
    }
  } else if (sources.posixShell !== "default" && typedEffective.posixShell !== undefined) {
    shellEnv[POSIX_SHELL_ENV] = typedEffective.posixShell;
    if (typedEffective.posixShellPath !== undefined) {
      shellEnv[POSIX_SHELL_PATH_ENV] = typedEffective.posixShellPath;
    }
  }

  const shellPolicy = resolveShellPolicy({
    platform,
    env: shellEnv,
    probe: options.probe,
    run: options.run,
  });

  const outputCapBytes = typedEffective.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES;
  const maxRunningTasks = typedEffective.maxRunningTasks ?? DEFAULT_MAX_RUNNING_TASKS;
  const notify = (typedEffective.notify ?? "on") === "on";
  const retentionDays = typedEffective.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const adoptForeground = (typedEffective.adoptForeground ?? "off") === "on";
  const foregroundTimeoutSeconds =
    typedEffective.foregroundTimeoutSeconds ?? DEFAULT_FOREGROUND_TIMEOUT_SECONDS;

  return {
    outputCapBytes,
    shellPolicy,
    notify,
    retentionDays,
    maxRunningTasks,
    adoptForeground,
    foregroundTimeoutMs: foregroundTimeoutSeconds * 1000,
    foregroundTimeoutSeconds,
    templatePaths,
    platform,
    sources,
    layers: {
      env: envLayer,
      project: projectLayer,
      agent: agentLayer,
      default: defaultLayer,
    },
    effective: typedEffective,
  };
}

function defaultSettingsLayer(platform: NodeJS.Platform): SettingsFileLayer {
  return {
    outputCapBytes: DEFAULT_OUTPUT_CAP_BYTES,
    maxRunningTasks: DEFAULT_MAX_RUNNING_TASKS,
    notify: "on",
    retentionDays: DEFAULT_RETENTION_DAYS,
    adoptForeground: "off",
    foregroundTimeoutSeconds: DEFAULT_FOREGROUND_TIMEOUT_SECONDS,
    ...(platform === "win32" ? { shell: "bash" as const } : { posixShell: "bash" as const }),
  };
}

function parseEnvSettingsLayer(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  probe: ExecutableProbe,
): SettingsFileLayer {
  const layer: Record<string, unknown> = {};
  if (env[OUTPUT_CAP_ENV] !== undefined) layer.outputCapBytes = parseOutputCapBytes(env);
  if (env[MAX_RUNNING_TASKS_ENV] !== undefined) {
    layer.maxRunningTasks = parseMaxRunningTasks(env);
  }
  if (env[NOTIFY_ENV] !== undefined) layer.notify = parseNotify(env) ? "on" : "off";
  if (env[RETENTION_DAYS_ENV] !== undefined) layer.retentionDays = parseRetentionDays(env);
  if (env[ADOPT_FOREGROUND_ENV] !== undefined) {
    layer.adoptForeground = parseAdoptForeground(env) ? "on" : "off";
  }
  if (env[FOREGROUND_TIMEOUT_ENV] !== undefined) {
    layer.foregroundTimeoutSeconds = parseForegroundTimeoutMs(env) / 1000;
  }

  if (platform === "win32") {
    for (const key of [POSIX_SHELL_ENV, POSIX_SHELL_PATH_ENV]) {
      if (env[key] !== undefined) {
        throw new Error(`${key} does not apply on win32; win32 reads ${SHELL_ENV} instead`);
      }
    }
    const rawShell = env[SHELL_ENV];
    if (rawShell !== undefined) {
      if (!WINDOWS_SHELLS.includes(rawShell as WindowsShellName)) {
        throw new Error(
          `${SHELL_ENV} does not accept ${JSON.stringify(rawShell)}; on win32 it is one of: ${WINDOWS_SHELLS.join(", ")}`,
        );
      }
      layer.shell = rawShell;
    }
    const rawPath = env[SHELL_PATH_ENV];
    if (rawPath !== undefined) {
      if (rawShell === undefined) {
        throw new Error(
          `${SHELL_PATH_ENV} is set without ${SHELL_ENV}; it only supplies the path of the shell that key names`,
        );
      }
      if (!windowsPath.isAbsolute(rawPath)) {
        throw new Error(
          `${SHELL_PATH_ENV} must be an absolute path; received ${JSON.stringify(rawPath)}`,
        );
      }
      layer.shellPath = rawPath;
    }
  } else {
    for (const key of [SHELL_ENV, SHELL_PATH_ENV]) {
      if (env[key] !== undefined) {
        throw new Error(
          `${key} does not apply on ${platform}; ${platform} reads ${POSIX_SHELL_ENV} instead`,
        );
      }
    }
    const rawShell = env[POSIX_SHELL_ENV];
    if (rawShell !== undefined) {
      if (!POSIX_SHELLS.includes(rawShell as PosixShellName)) {
        throw new Error(
          `${POSIX_SHELL_ENV} does not accept ${JSON.stringify(rawShell)}; on ${platform} it is one of: ${POSIX_SHELLS.join(", ")}`,
        );
      }
      layer.posixShell = rawShell;
    }
    const rawPath = env[POSIX_SHELL_PATH_ENV];
    if (rawPath !== undefined) {
      if (rawShell === undefined) {
        throw new Error(
          `${POSIX_SHELL_PATH_ENV} is set without ${POSIX_SHELL_ENV}; it only supplies the path of the shell that key names`,
        );
      }
      if (!posixPath.isAbsolute(rawPath)) {
        throw new Error(
          `${POSIX_SHELL_PATH_ENV} must be an absolute path; received ${JSON.stringify(rawPath)}`,
        );
      }
      if (!probe(rawPath)) {
        throw new Error(
          `${POSIX_SHELL_PATH_ENV} must be an executable file; received ${JSON.stringify(rawPath)}`,
        );
      }
      layer.posixShellPath = rawPath;
    }
  }

  return layer as SettingsFileLayer;
}

function readSettingsFileLayer(
  file: string,
  platform: NodeJS.Platform,
  probe: ExecutableProbe,
): SettingsFileLayer {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${file}: ${(error as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    // A broken template-only file (`{ "templates": `) is reported by `loadTemplates`
    // into `reportProblem` so the other template file still loads; any broken JSON
    // touching `"settings"` fails `readSettings` immediately.
    if (!/"settings"/.test(text)) return {};
    throw new Error(`${file}: invalid JSON (${(error as Error).message})`);
  }

  if (!isPlainObject(raw)) {
    throw new Error(`${file}: the top level must be an object; received ${describeValue(raw)}`);
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_CONFIG_KEYS.has(key)) {
      throw new Error(
        `${file}: unsupported field ${JSON.stringify(key)}; pretty-task.json only holds "settings" and "templates"`,
      );
    }
  }
  if (!("settings" in raw) || raw.settings === undefined) return {};
  return parseSettingsObject(raw.settings, file, platform, probe);
}

/**
 * Validate the `"settings"` object from a `pretty-task.json` file.
 */
export function parseSettingsObject(
  raw: unknown,
  file: string,
  platform: NodeJS.Platform = process.platform,
  probe: ExecutableProbe = defaultProbe(platform),
): SettingsFileLayer {
  if (!isPlainObject(raw)) {
    throw new Error(`${file}: settings must be an object; received ${describeValue(raw)}`);
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_SETTING_KEYS.includes(key as SettingKey)) {
      throw new Error(
        `${file}: settings.${key} is not a key this version reads; known keys: ${KNOWN_SETTING_KEYS.join(", ")}`,
      );
    }
  }

  const layer: Record<string, unknown> = {};

  if (raw.outputCapBytes !== undefined) {
    const value = raw.outputCapBytes;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `${file}: settings.outputCapBytes must be a positive whole number of bytes; received ${JSON.stringify(value)}`,
      );
    }
    layer.outputCapBytes = value;
  }

  if (raw.maxRunningTasks !== undefined) {
    const value = raw.maxRunningTasks;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `${file}: settings.maxRunningTasks must be a positive whole number of tasks; received ${JSON.stringify(value)}`,
      );
    }
    layer.maxRunningTasks = value;
  }

  if (raw.notify !== undefined) {
    const value = raw.notify;
    if (value !== "on" && value !== "off") {
      throw new Error(
        `${file}: settings.notify does not accept ${JSON.stringify(value)}; it is one of: on, off`,
      );
    }
    layer.notify = value;
  }

  if (raw.retentionDays !== undefined) {
    const value = raw.retentionDays;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `${file}: settings.retentionDays must be a positive whole number of days; received ${JSON.stringify(value)}`,
      );
    }
    layer.retentionDays = value;
  }

  if (raw.adoptForeground !== undefined) {
    const value = raw.adoptForeground;
    if (value !== "on" && value !== "off") {
      throw new Error(
        `${file}: settings.adoptForeground does not accept ${JSON.stringify(value)}; it is one of: on, off`,
      );
    }
    layer.adoptForeground = value;
  }

  if (raw.foregroundTimeoutSeconds !== undefined) {
    const value = raw.foregroundTimeoutSeconds;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > MAX_FOREGROUND_TIMEOUT_SECONDS
    ) {
      throw new Error(
        `${file}: settings.foregroundTimeoutSeconds must be a whole number of seconds no larger than ${String(MAX_FOREGROUND_TIMEOUT_SECONDS)}, or 0 to keep a command in the foreground; received ${JSON.stringify(value)}`,
      );
    }
    layer.foregroundTimeoutSeconds = value;
  }

  if (platform === "win32") {
    if (raw.posixShell !== undefined) {
      throw new Error(
        `${file}: settings.posixShell does not apply on win32; win32 reads settings.shell instead`,
      );
    }
    if (raw.posixShellPath !== undefined) {
      throw new Error(
        `${file}: settings.posixShellPath does not apply on win32; win32 reads settings.shellPath instead`,
      );
    }
    if (raw.shell !== undefined) {
      if (
        typeof raw.shell !== "string" ||
        !WINDOWS_SHELLS.includes(raw.shell as WindowsShellName)
      ) {
        throw new Error(
          `${file}: settings.shell does not accept ${JSON.stringify(raw.shell)}; on win32 it is one of: ${WINDOWS_SHELLS.join(", ")}`,
        );
      }
      layer.shell = raw.shell;
    }
    if (raw.shellPath !== undefined) {
      if (raw.shell === undefined) {
        throw new Error(
          `${file}: settings.shellPath is set without settings.shell; it only supplies the path of the shell that key names`,
        );
      }
      if (typeof raw.shellPath !== "string" || !windowsPath.isAbsolute(raw.shellPath)) {
        throw new Error(
          `${file}: settings.shellPath must be an absolute path; received ${JSON.stringify(raw.shellPath)}`,
        );
      }
      layer.shellPath = raw.shellPath;
    }
  } else {
    if (raw.shell !== undefined) {
      throw new Error(
        `${file}: settings.shell does not apply on ${platform}; ${platform} reads settings.posixShell instead`,
      );
    }
    if (raw.shellPath !== undefined) {
      throw new Error(
        `${file}: settings.shellPath does not apply on ${platform}; ${platform} reads settings.posixShellPath instead`,
      );
    }
    if (raw.posixShell !== undefined) {
      if (
        typeof raw.posixShell !== "string" ||
        !POSIX_SHELLS.includes(raw.posixShell as PosixShellName)
      ) {
        throw new Error(
          `${file}: settings.posixShell does not accept ${JSON.stringify(raw.posixShell)}; on ${platform} it is one of: ${POSIX_SHELLS.join(", ")}`,
        );
      }
      layer.posixShell = raw.posixShell;
    }
    if (raw.posixShellPath !== undefined) {
      if (raw.posixShell === undefined) {
        throw new Error(
          `${file}: settings.posixShellPath is set without settings.posixShell; it only supplies the path of the shell that key names`,
        );
      }
      if (typeof raw.posixShellPath !== "string" || !posixPath.isAbsolute(raw.posixShellPath)) {
        throw new Error(
          `${file}: settings.posixShellPath must be an absolute path; received ${JSON.stringify(raw.posixShellPath)}`,
        );
      }
      if (!probe(raw.posixShellPath)) {
        throw new Error(
          `${file}: settings.posixShellPath must be an executable file; received ${JSON.stringify(raw.posixShellPath)}`,
        );
      }
      layer.posixShellPath = raw.posixShellPath;
    }
  }

  return layer as SettingsFileLayer;
}

/**
 * Atomically update the `"settings"` object inside one `pretty-task.json` file
 * via `writeAtomic`, preserving any `"templates"` block in the same file.
 *
 * Passing `undefined` for a key removes that key from the file's `"settings"`;
 * removing `shell` or `posixShell` also removes its paired `*ShellPath` from the
 * same file so the file never violates the same-layer pairing rule.
 */
export async function writeSettingsFile(
  filePath: string,
  patch: Partial<Record<SettingKey, SettingsFileLayer[SettingKey] | undefined>>,
  options: { readonly platform?: NodeJS.Platform; readonly probe?: ExecutableProbe } = {},
): Promise<SettingsFileLayer> {
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? defaultProbe(platform);

  let existingDoc: Record<string, unknown> = {};
  try {
    const text = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!isPlainObject(parsed)) {
      throw new Error(
        `${filePath}: the top level must be an object; received ${describeValue(parsed)}`,
      );
    }
    for (const key of Object.keys(parsed)) {
      if (!TOP_LEVEL_CONFIG_KEYS.has(key)) {
        throw new Error(
          `${filePath}: unsupported field ${JSON.stringify(key)}; pretty-task.json only holds "settings" and "templates"`,
        );
      }
    }
    existingDoc = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const currentSettings =
    existingDoc.settings === undefined
      ? {}
      : {
          ...(parseSettingsObject(existingDoc.settings, filePath, platform, probe) as Record<
            string,
            unknown
          >),
        };

  for (const key of Object.keys(patch) as SettingKey[]) {
    const value = patch[key];
    if (value === undefined) {
      delete currentSettings[key];
      if (key === "shell") delete currentSettings.shellPath;
      if (key === "posixShell") delete currentSettings.posixShellPath;
    } else {
      currentSettings[key] = value;
    }
  }

  const validated = parseSettingsObject(currentSettings, filePath, platform, probe);
  const nextDoc: Record<string, unknown> = {};
  if ("templates" in existingDoc && existingDoc.templates !== undefined) {
    nextDoc.templates = existingDoc.templates;
  }
  if (Object.keys(validated).length > 0) {
    nextDoc.settings = validated;
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeAtomic(filePath, `${JSON.stringify(nextDoc, null, 2)}\n`);
  return validated;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * The output byte cap.
 *
 * An absent key means the default, and every other value must be a positive whole
 * number of bytes: the thrown error is the user-facing report, so it names the
 * key, what is accepted and what was found — a failed extension load then says
 * exactly what to fix. `Number()` on a typo yields `NaN`, and a `NaN` cap compares
 * false against every byte count, so the first chunk of every task would look like
 * the cap and every task would die at once.
 */
export function parseOutputCapBytes(env: NodeJS.ProcessEnv): number {
  const raw = env[OUTPUT_CAP_ENV];
  if (raw === undefined) return DEFAULT_OUTPUT_CAP_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${OUTPUT_CAP_ENV} must be a positive whole number of bytes; received ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/** The notification toggle. An unset key means `on`; anything not `on`/`off` fails. */
function parseNotify(env: NodeJS.ProcessEnv): boolean {
  const raw = env[NOTIFY_ENV];
  if (raw === undefined) return true;
  if (raw === "on") return true;
  if (raw === "off") return false;
  throw new Error(`${NOTIFY_ENV} does not accept ${JSON.stringify(raw)}; it is one of: on, off`);
}

/**
 * The retention window, in whole days. An absent key means the default.
 *
 * Zero, a fraction and a typo are all refused instead of being read as a window:
 * `0` would reclaim every finished session on the next start, `1.5` would round
 * into a window nobody asked for, and `Number("week")` is `NaN`, which compares
 * false against every age — pruning would silently stop. Failing the load says
 * which key to fix, and nothing has been deleted at that point.
 */
function parseRetentionDays(env: NodeJS.ProcessEnv): number {
  const raw = env[RETENTION_DAYS_ENV];
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${RETENTION_DAYS_ENV} must be a positive whole number of days; received ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * The running-task cap, in whole tasks. An absent key means the documented 20.
 *
 * `0` is refused rather than read as "no tasks": the scope promises a ceiling,
 * and a zero would stop every `pretty_task_bg_run`, every fire and every chain step without
 * saying which key did it. A fraction and a typo are refused for the reason the
 * other limits are — `Number("many")` is `NaN`, which compares false against
 * every count, so the cap would never be reached and the 20 would silently be
 * gone. The thrown error is the user-facing report, so it names the key, what it
 * accepts and what it received.
 */
function parseMaxRunningTasks(env: NodeJS.ProcessEnv): number {
  const raw = env[MAX_RUNNING_TASKS_ENV];
  if (raw === undefined) return DEFAULT_MAX_RUNNING_TASKS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${MAX_RUNNING_TASKS_ENV} must be a positive whole number of tasks; received ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * Whether the foreground takeover is on. An absent key means off: overwriting a
 * built-in tool is a change to how every command runs, so it is opted into.
 */
function parseAdoptForeground(env: NodeJS.ProcessEnv): boolean {
  const raw = env[ADOPT_FOREGROUND_ENV];
  if (raw === undefined || raw === "off") return false;
  if (raw === "on") return true;
  throw new Error(
    `${ADOPT_FOREGROUND_ENV} does not accept ${JSON.stringify(raw)}; it is one of: on, off`,
  );
}

/**
 * The foreground detach timeout, in milliseconds. An absent key means off.
 *
 * `0` is accepted because "never detach on a timer" is the documented default
 * and the plainest way to say it again. Everything else is a whole number of
 * seconds: a fraction or a typo would otherwise become a timer nobody asked for
 * (`Number("1.5m")` is `NaN`, and a `NaN` deadline fires immediately or never,
 * depending on the comparison that reads it).
 */
function parseForegroundTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env[FOREGROUND_TIMEOUT_ENV];
  if (raw === undefined) return DEFAULT_FOREGROUND_TIMEOUT_SECONDS * 1000;
  // A blank value is a typo, not zero: `0` is how "never on a timer" is written,
  // and `Number("")` reads as `0`, which would turn an empty variable into off.
  const seconds = raw.trim().length === 0 ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_FOREGROUND_TIMEOUT_SECONDS) {
    throw new Error(
      `${FOREGROUND_TIMEOUT_ENV} must be a whole number of seconds no larger than ${String(MAX_FOREGROUND_TIMEOUT_SECONDS)}, or 0 to keep a command in the foreground; received ${JSON.stringify(raw)}`,
    );
  }
  return seconds * 1000;
}

/**
 * The agent settings directory. pi does not export its own env key, so the rule is
 * mirrored here: the key when set (with `~` expanded), pi's default otherwise.
 */
function parseAgentDir(env: NodeJS.ProcessEnv): string {
  const raw = env[AGENT_DIR_ENV];
  if (raw === undefined || raw.length === 0) return join(homedir(), CONFIG_DIR_NAME, "agent");
  return expandHome(raw);
}

/** `~` and `~/` (or `~\`) start at the home directory, as they do in pi itself. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * A misspelt key is a configuration mistake, not a default. Reported before any
 * value is read, so the message names the key the user actually typed.
 */
function rejectUnknownKeys(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (!key.startsWith(KEY_PREFIX) || KNOWN_KEYS.includes(key)) continue;
    throw new Error(`${key} is not a key this version reads; known keys: ${KNOWN_KEYS.join(", ")}`);
  }
}
