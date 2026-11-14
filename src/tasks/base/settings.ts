/**
 * The extension's configuration, read once from one explicit environment.
 *
 * Every environment-derived option lives here and nowhere else: the output byte
 * cap, the shell policy, the notification toggle, and the agent settings
 * directory templates come from. `src/index.ts` builds one `Settings` before it
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

/** pi's own settings directory; `pretty-task.json` is read from it. */
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Every `PI_PRETTY_TASK_*` key this version reads. Anything else is a typo. */
const KNOWN_KEYS: readonly string[] = [
  OUTPUT_CAP_ENV,
  NOTIFY_ENV,
  RETENTION_DAYS_ENV,
  SHELL_ENV,
  SHELL_PATH_ENV,
  POSIX_SHELL_ENV,
  POSIX_SHELL_PATH_ENV,
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
