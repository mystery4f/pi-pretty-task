/**
 * Which shell runs a command, and in what shape the command reaches it (ADR-0008).
 *
 * The choice is configuration, not guesswork: the environment names the shell, one
 * call may override it, and every value that cannot be honoured is refused with the
 * key and the value that caused it. A wrong shell silently replaced by the default
 * would run someone's POSIX script through cmd and blame the command.
 *
 * Windows uses `cmd.exe` unless told otherwise; POSIX inherits `$SHELL`. The
 * invocation shape differs by dialect, not by executable: `cmd` needs one verbatim
 * quoted argument, everything POSIX-shaped takes the command as a normal argv entry.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { statSync } from "node:fs";
import { posix as posixPath, win32 as windowsPath } from "node:path";

/** Windows: `cmd` or `bash`. */
export const SHELL_ENV = "PI_PRETTY_TASK_SHELL";

/** Windows: absolute path of the shell `SHELL_ENV` names. */
export const SHELL_PATH_ENV = "PI_PRETTY_TASK_SHELL_PATH";

/** POSIX: `inherit`, `bash` or `sh`. */
export const POSIX_SHELL_ENV = "PI_PRETTY_TASK_POSIX_SHELL";

/** POSIX: absolute path of the shell `POSIX_SHELL_ENV` names. */
export const POSIX_SHELL_PATH_ENV = "PI_PRETTY_TASK_POSIX_SHELL_PATH";

/** Shells a policy can name. `inherit` exists only on POSIX: the user's own shell. */
export type ShellName = "cmd" | "bash" | "sh" | "inherit";

/** What one call may ask for: its own shell, or whatever the environment configured. */
export type ShellChoice = "default" | "cmd" | "bash" | "sh";

/** A chosen shell and the executable it resolved to. */
export interface ShellPolicy {
  readonly name: ShellName;
  /** Absolute path, except for the bare `cmd.exe` a Windows host always finds. */
  readonly executable: string;
}

/** How one command is handed to its shell. */
export interface ShellInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

/**
 * Whether a candidate is an executable this platform would run. A seam: the policy
 * tests must not depend on which shells the machine running them happens to have.
 */
export type ExecutableProbe = (candidate: string) => boolean;

export interface ShellPolicyOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Defaults to a real filesystem check for the target platform. */
  probe?: ExecutableProbe;
}

const WINDOWS_SHELLS = ["cmd", "bash"] as const;
const POSIX_SHELLS = ["inherit", "bash", "sh"] as const;

function errorMessage(key: string, detail: string, received: string): string {
  return `${key} ${detail}; received ${JSON.stringify(received)}`;
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Windows has no execute bit; POSIX does, and a file without it would not run. */
function defaultProbe(platform: NodeJS.Platform): ExecutableProbe {
  if (platform === "win32") return isFile;
  return (candidate) => {
    try {
      const stats = statSync(candidate);
      return stats.isFile() && (stats.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  };
}

function pathDirectories(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  const separator = platform === "win32" ? ";" : ":";
  return raw.split(separator).filter((entry) => entry.length > 0);
}

function joinFor(platform: NodeJS.Platform, dir: string, name: string): string {
  return platform === "win32" ? windowsPath.join(dir, name) : posixPath.join(dir, name);
}

/**
 * Find a shell: `/bin` first on POSIX, then PATH on both. Windows bash is looked up
 * as `bash.exe`/`bash.com` only — guessing a Git for Windows install directory would
 * pick a shell the user never chose.
 */
function findShell(
  key: string,
  name: "bash" | "sh",
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  probe: ExecutableProbe,
): string {
  const files = platform === "win32" ? ["bash.exe", "bash.com"] : [name];
  const absolute = platform === "win32" ? [] : [posixPath.join("/bin", name)];
  const fromPath = pathDirectories(platform, env).flatMap((dir) =>
    files.map((file) => joinFor(platform, dir, file)),
  );
  for (const candidate of [...absolute, ...fromPath]) {
    if (probe(candidate)) return candidate;
  }

  // The message is the whole report: it names the key, what was looked for, and the
  // PATH that was searched, so the next step is a config change rather than a guess.
  const searched =
    absolute.length === 0
      ? `${files.join(" and ")} in PATH "${env.PATH ?? ""}"`
      : `${absolute.join(" and ")} and then the directories on PATH "${env.PATH ?? ""}"`;
  throw new Error(`${key}=${name} needs ${name}; searched ${searched}`);
}

function comSpec(env: NodeJS.ProcessEnv): string {
  const raw = env.ComSpec;
  return raw !== undefined && raw.length > 0 ? raw : "cmd.exe";
}

/** A selector that is present but empty is a typo, not "use the default". */
function selectorValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return env[key];
}

function knownValue<T extends string>(
  key: string,
  raw: string,
  allowed: readonly T[],
  platform: NodeJS.Platform,
): T {
  const match = allowed.find((candidate) => candidate === raw);
  if (match !== undefined) return match;
  throw new Error(
    `${key} does not accept ${JSON.stringify(raw)}; on ${platform} it is one of: ${allowed.join(", ")}`,
  );
}

/**
 * Read the paired `*_SHELL_PATH`. It only supplies the executable of a shell the
 * selector names, so one without the other is a configuration mistake.
 */
function configuredPath(
  env: NodeJS.ProcessEnv,
  pathKey: string,
  shellKey: string,
  platform: NodeJS.Platform,
): string | undefined {
  const raw = env[pathKey];
  if (raw === undefined) return undefined;
  if (env[shellKey] === undefined) {
    throw new Error(
      `${pathKey} is set without ${shellKey}; it only supplies the path of the shell that key names`,
    );
  }
  const absolute = platform === "win32" ? windowsPath.isAbsolute(raw) : posixPath.isAbsolute(raw);
  if (!absolute) {
    throw new Error(errorMessage(pathKey, "must be an absolute path", raw));
  }
  return raw;
}

/** Refuse this platform's key on the other platform instead of ignoring it. */
function rejectForeignKeys(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
  ownKey: string,
  platform: NodeJS.Platform,
): void {
  for (const key of keys) {
    if (env[key] !== undefined) {
      throw new Error(`${key} does not apply on ${platform}; ${platform} reads ${ownKey} instead`);
    }
  }
}

function resolveNamed(
  name: "cmd" | "bash" | "sh",
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  probe: ExecutableProbe,
  path: string | undefined,
): ShellPolicy {
  if (name === "cmd") return { name, executable: path ?? comSpec(env) };
  const key = platform === "win32" ? SHELL_ENV : POSIX_SHELL_ENV;
  return { name, executable: path ?? findShell(key, name, platform, env, probe) };
}

function windowsPolicy(env: NodeJS.ProcessEnv, probe: ExecutableProbe): ShellPolicy {
  rejectForeignKeys(env, [POSIX_SHELL_ENV, POSIX_SHELL_PATH_ENV], SHELL_ENV, "win32");
  const raw = selectorValue(env, SHELL_ENV);
  const name = raw === undefined ? "cmd" : knownValue(SHELL_ENV, raw, WINDOWS_SHELLS, "win32");
  const path = configuredPath(env, SHELL_PATH_ENV, SHELL_ENV, "win32");
  return resolveNamed(name, "win32", env, probe, path);
}

function posixPolicy(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  probe: ExecutableProbe,
): ShellPolicy {
  rejectForeignKeys(env, [SHELL_ENV, SHELL_PATH_ENV], POSIX_SHELL_ENV, platform);
  const raw = selectorValue(env, POSIX_SHELL_ENV);
  const name =
    raw === undefined ? "inherit" : knownValue(POSIX_SHELL_ENV, raw, POSIX_SHELLS, platform);

  const path = configuredPath(env, POSIX_SHELL_PATH_ENV, POSIX_SHELL_ENV, platform);
  if (path !== undefined) {
    // The brief asks for an executable, not merely an existing file: a path that
    // cannot run would turn every task into a spawn failure with no explanation.
    if (!probe(path)) {
      throw new Error(errorMessage(POSIX_SHELL_PATH_ENV, "must be an executable file", path));
    }
    return { name, executable: path };
  }

  if (name === "inherit") {
    const shell = env.SHELL;
    return { name, executable: shell !== undefined && shell.length > 0 ? shell : "/bin/sh" };
  }
  return resolveNamed(name, platform, env, probe, undefined);
}

/**
 * The shell this platform will use, resolved from the environment once at load time:
 * a value that cannot be honoured has to fail the load, not every task.
 */
export function resolveShellPolicy(options: ShellPolicyOptions = {}): ShellPolicy {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const probe = options.probe ?? defaultProbe(platform);
  return platform === "win32" ? windowsPolicy(env, probe) : posixPolicy(platform, env, probe);
}

/**
 * Resolve one call's shell: `default` keeps the configured policy untouched, any
 * other value has to be one this platform actually offers. A configured path is
 * reused only when the override names the same shell — it belongs to that shell.
 */
export function selectShell(
  policy: ShellPolicy,
  choice: ShellChoice | undefined,
  options: ShellPolicyOptions = {},
): ShellPolicy {
  if (choice === undefined || choice === "default") return policy;

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const probe = options.probe ?? defaultProbe(platform);
  // `inherit` is a policy, not a per-call value: a call names the shell it wants.
  const allowed: readonly ShellChoice[] =
    platform === "win32" ? ["default", "cmd", "bash"] : ["default", "bash", "sh"];
  if (!allowed.includes(choice)) {
    throw new Error(
      `shell ${JSON.stringify(choice)} is not available on ${platform}; use one of: ${allowed.join(", ")}`,
    );
  }

  if (policy.name === choice) return policy;
  return resolveNamed(choice, platform, env, probe, undefined);
}

/**
 * The argument shape for a policy.
 *
 * `cmd` gets `/d /s /c "<command>"` with verbatim arguments, exactly as a terminal
 * does, so builtins, `&&` and quoted paths behave the same: `/d` skips AutoRun
 * registry commands, `/s` makes the outer quote pair be stripped rather than
 * reinterpreted, and verbatim arguments stop Node from re-quoting anything we pass.
 *
 * Everything else — POSIX shells and a Windows bash — takes `-c` and a normally
 * escaped argv entry; no `-l`, so no login-shell startup files run and the command
 * sees the environment pi was started with.
 */
export function shellInvocation(policy: ShellPolicy, command: string): ShellInvocation {
  if (policy.name === "cmd") {
    return {
      executable: policy.executable,
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  return {
    executable: policy.executable,
    args: ["-c", command],
    windowsVerbatimArguments: false,
  };
}
