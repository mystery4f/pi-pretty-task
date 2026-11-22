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
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  type ExecutableProbe,
  POSIX_SHELL_ENV,
  POSIX_SHELL_PATH_ENV,
  resolveShellPolicy,
  SHELL_ENV,
  SHELL_PATH_ENV,
  type ShellPolicy,
} from "../process/shell.js";
import { type TemplateConfigPaths, templateConfigPaths } from "../process/templates.js";

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
  /** Where the named templates are read from: the project first, then the agent dir. */
  readonly templatePaths: TemplateConfigPaths;
}

/** Where a `Settings` is built from; every field has a production default. */
export interface SettingsOptions {
  /** The environment to read; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Project root holding `.pi/pretty-task.json`; defaults to the working directory. */
  readonly projectDir?: string;
  /** Agent settings directory; defaults to `AGENT_DIR_ENV` or pi's own default. */
  readonly agentDir?: string;
  /** Test seams forwarded to the shell policy: which platform, and what is executable. */
  readonly platform?: NodeJS.Platform;
  readonly probe?: ExecutableProbe;
}

/**
 * Read the whole configuration. Throws on the first value that cannot be
 * honoured, so a bad environment stops the extension from loading rather than
 * every task it would have started.
 */
export function readSettings(options: SettingsOptions = {}): Settings {
  const env = options.env ?? process.env;
  rejectUnknownKeys(env);
  const agentDir = options.agentDir ?? parseAgentDir(env);
  return {
    outputCapBytes: parseOutputCapBytes(env),
    shellPolicy: resolveShellPolicy({
      platform: options.platform,
      env,
      probe: options.probe,
    }),
    notify: parseNotify(env),
    retentionDays: parseRetentionDays(env),
    maxRunningTasks: parseMaxRunningTasks(env),
    adoptForeground: parseAdoptForeground(env),
    foregroundTimeoutMs: parseForegroundTimeoutMs(env),
    templatePaths: templateConfigPaths(options.projectDir ?? process.cwd(), agentDir),
  };
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
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error(
      `${FOREGROUND_TIMEOUT_ENV} must be a whole number of seconds, or 0 to keep a command in the foreground; received ${JSON.stringify(raw)}`,
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
