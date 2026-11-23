/**
 * Which shell runs a command, and in what shape the command reaches it (ADR-0008; the
 * defaults and the Windows search in ADR-0022).
 *
 * The choice is configuration, not guesswork: the environment names the shell, one
 * call may override it, and every value that cannot be honoured is refused with the
 * key and the value that caused it. A wrong shell silently replaced by the default
 * would run someone's POSIX script through cmd and blame the command.
 *
 * Both platforms default to bash — on Windows the one beside the user's git, or the
 * Git Bash pi was started from — because one pen writes the commands on every host;
 * `cmd.exe`, the user's `$SHELL` and `sh` are explicit choices. The invocation shape
 * differs by dialect, not by executable: `cmd` needs one verbatim quoted argument,
 * everything POSIX-shaped takes the command as a normal argv entry.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { execFileSync } from "node:child_process";
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

/**
 * Runs a discovery command such as `where` and returns its stdout; undefined when the
 * command fails. A seam like the probe: the policy tests must not depend on the machine.
 */
export type CommandRunner = (file: string, args: readonly string[]) => string | undefined;

export interface ShellPolicyOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Defaults to a real filesystem check for the target platform. */
  probe?: ExecutableProbe;
  /** Defaults to a real child process; Windows discovery asks `where` and `reg` through it. */
  run?: CommandRunner;
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

const GIT_FOR_WINDOWS_KEYS = [
  "HKLM\\SOFTWARE\\GitForWindows",
  "HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows",
  "HKCU\\SOFTWARE\\GitForWindows",
] as const;

/** `where.exe` and `reg.exe` live beside `cmd.exe`, whatever PATH says. */
function systemTool(env: NodeJS.ProcessEnv, name: string): string {
  return windowsPath.join(env.SystemRoot ?? "C:\\Windows", "System32", name);
}

const defaultRunner: CommandRunner = (file, args) => {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
};

/** `where` prints one path per line; nothing found is a non-zero exit, i.e. undefined. */
function whereLines(stdout: string | undefined): string[] {
  return (stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && windowsPath.isAbsolute(line));
}

/** `reg query` prints `    InstallPath    REG_SZ    D:\Soft\Git`; a missing key exits non-zero. */
function registryInstallPath(stdout: string | undefined): string | undefined {
  return stdout?.match(/^\s*InstallPath\s+REG_SZ\s+(.+?)\s*$/m)?.[1];
}

/**
 * Git for Windows keeps `bash.exe` beside its `git.exe`: `<root>\cmd\git.exe` and
 * `<root>\mingw64\bin\git.exe` both mean `<root>\bin\bash.exe`. Every ancestor of git's
 * directory gets `\bin\bash.exe` appended, nearest first, so a shim on PATH or a Cygwin
 * layout only costs a failed probe before the next line of `where` is read.
 */
function bashBeside(gitPath: string): string[] {
  const candidates: string[] = [];
  let dir = windowsPath.dirname(gitPath);
  for (let level = 0; level < 3; level += 1) {
    candidates.push(windowsPath.join(dir, "bin", "bash.exe"));
    const parent = windowsPath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

/**
 * Started from Git Bash, the process carries `EXEPATH` — the directory holding the bash
 * the user is typing in — and often an absolute `$SHELL`; neither is set under cmd or
 * PowerShell. That bash wins over anything found later.
 */
function gitBashLaunchCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  if (env.EXEPATH !== undefined && windowsPath.isAbsolute(env.EXEPATH)) {
    candidates.push(windowsPath.join(env.EXEPATH, "bash.exe"));
    candidates.push(windowsPath.join(env.EXEPATH, "bin", "bash.exe"));
  }
  if (env.SHELL !== undefined && windowsPath.isAbsolute(env.SHELL)) candidates.push(env.SHELL);
  return candidates;
}

function usualInstallDirs(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"]];
  if (env.LOCALAPPDATA !== undefined) roots.push(windowsPath.join(env.LOCALAPPDATA, "Programs"));
  return roots
    .filter((root): root is string => root !== undefined && windowsPath.isAbsolute(root))
    .map((root) => windowsPath.join(root, "Git", "bin", "bash.exe"));
}

/** One place a Windows bash may come from, kept for the report when none of them has it. */
interface BashSource {
  readonly label: string;
  /** The candidates this source offers, computed only once the sources before it came up empty. */
  readonly offer: () => readonly string[];
  /** The report line for a source whose candidates would be noise, such as a PATH dump. */
  readonly report?: (offered: readonly string[]) => string;
}

const PATH_BASH_FILES = ["bash.exe", "bash.com"] as const;

/** Every Git for Windows the registry names, 64-bit view first, as its `bin\bash.exe`. */
function registeredBash(env: NodeJS.ProcessEnv, run: CommandRunner): string[] {
  return GIT_FOR_WINDOWS_KEYS.flatMap((hive) => {
    const root = registryInstallPath(
      run(systemTool(env, "reg.exe"), ["query", hive, "/v", "InstallPath"]),
    );
    return root === undefined ? [] : [windowsPath.join(root, "bin", "bash.exe")];
  });
}

/** The candidates of one source as the failure report lists them. */
function listed(candidates: readonly string[]): string {
  return candidates.length === 0 ? "nothing" : candidates.join(", ");
}

/**
 * Where a Windows bash comes from, in order: the Git Bash pi was started from, the git
 * on PATH (its bash sits beside it), the registry's Git for Windows, the usual install
 * directories, and finally a `bash.exe`/`bash.com` on PATH. A source is consulted only
 * once every source before it came up empty — started from Git Bash, no `where` or `reg`
 * ever runs — and the probe decides, so a shim or an empty `where` costs nothing.
 */
function findWindowsBash(
  key: string,
  env: NodeJS.ProcessEnv,
  probe: ExecutableProbe,
  run: CommandRunner,
  explicit: boolean,
): string {
  const sources: BashSource[] = [
    { label: "the Git Bash pi was started from", offer: () => gitBashLaunchCandidates(env) },
    {
      label: "bash beside the git on PATH",
      offer: () => whereLines(run(systemTool(env, "where.exe"), ["git.exe"])).flatMap(bashBeside),
    },
    { label: "Git for Windows as registered", offer: () => registeredBash(env, run) },
    { label: "the usual install directories", offer: () => usualInstallDirs(env) },
    {
      label: "PATH",
      offer: () =>
        pathDirectories("win32", env).flatMap((dir) =>
          PATH_BASH_FILES.map((file) => joinFor("win32", dir, file)),
        ),
      report: () => `${PATH_BASH_FILES.join(" and ")} in PATH "${env.PATH ?? ""}"`,
    },
  ];
  // Every source and what it offered, in order, so the failure is a whole report.
  const report: string[] = [];
  for (const source of sources) {
    const candidates = source.offer();
    report.push(`${source.label} [${source.report?.(candidates) ?? listed(candidates)}]`);
    for (const candidate of candidates) {
      if (probe(candidate)) return candidate;
    }
  }

  // The report ends with the two ways out, so the next step is a config change rather
  // than a guess.
  const searched = report.join("; ");
  throw new Error(
    `${key}=bash${explicit ? "" : " (the default on Windows)"} needs bash.exe; searched ${searched}; ` +
      `set ${key}=cmd to keep cmd.exe, or ${SHELL_PATH_ENV} to the bash.exe to use`,
  );
}

/** `/bin` first, then PATH — the order every POSIX distribution satisfies. */
function findPosixShell(
  key: string,
  name: "bash" | "sh",
  env: NodeJS.ProcessEnv,
  probe: ExecutableProbe,
  explicit: boolean,
): string {
  const absolute = posixPath.join("/bin", name);
  if (probe(absolute)) return absolute;
  const fromPath = pathDirectories("linux", env).map((dir) => posixPath.join(dir, name));
  for (const candidate of fromPath) {
    if (probe(candidate)) return candidate;
  }

  // The message is the whole report: it names the key, what was looked for, and the
  // PATH that was searched, so the next step is a config change rather than a guess.
  throw new Error(
    `${key}=${name}${explicit ? "" : " (the default)"} needs ${name}; searched ${absolute} and then the directories on PATH "${env.PATH ?? ""}"; ` +
      `set ${key}=${name === "bash" ? "sh or inherit" : "bash or inherit"} to name another shell, or ${POSIX_SHELL_PATH_ENV} to the ${name} to use`,
  );
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
  run: CommandRunner,
  path: string | undefined,
  explicit: boolean,
): ShellPolicy {
  if (name === "cmd") return { name, executable: path ?? comSpec(env) };
  if (platform === "win32") {
    return {
      name: "bash",
      executable: path ?? findWindowsBash(SHELL_ENV, env, probe, run, explicit),
    };
  }
  return { name, executable: path ?? findPosixShell(POSIX_SHELL_ENV, name, env, probe, explicit) };
}
function windowsPolicy(
  env: NodeJS.ProcessEnv,
  probe: ExecutableProbe,
  run: CommandRunner,
): ShellPolicy {
  rejectForeignKeys(env, [POSIX_SHELL_ENV, POSIX_SHELL_PATH_ENV], SHELL_ENV, "win32");
  const raw = selectorValue(env, SHELL_ENV);
  const name = raw === undefined ? "bash" : knownValue(SHELL_ENV, raw, WINDOWS_SHELLS, "win32");
  const path = configuredPath(env, SHELL_PATH_ENV, SHELL_ENV, "win32");
  return resolveNamed(name, "win32", env, probe, run, path, raw !== undefined);
}

function posixPolicy(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  probe: ExecutableProbe,
  run: CommandRunner,
): ShellPolicy {
  rejectForeignKeys(env, [SHELL_ENV, SHELL_PATH_ENV], POSIX_SHELL_ENV, platform);
  const raw = selectorValue(env, POSIX_SHELL_ENV);
  const name =
    raw === undefined ? "bash" : knownValue(POSIX_SHELL_ENV, raw, POSIX_SHELLS, platform);

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
  return resolveNamed(name, platform, env, probe, run, undefined, raw !== undefined);
}

/**
 * The shell this platform will use, resolved from the environment once at load time:
 * a value that cannot be honoured has to fail the load, not every task.
 */
export function resolveShellPolicy(options: ShellPolicyOptions = {}): ShellPolicy {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const probe = options.probe ?? defaultProbe(platform);
  const run = options.run ?? defaultRunner;
  return platform === "win32"
    ? windowsPolicy(env, probe, run)
    : posixPolicy(platform, env, probe, run);
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
  const run = options.run ?? defaultRunner;
  // `inherit` is a policy, not a per-call value: a call names the shell it wants.
  const allowed: readonly ShellChoice[] =
    platform === "win32" ? ["default", "cmd", "bash"] : ["default", "bash", "sh"];
  if (!allowed.includes(choice)) {
    throw new Error(
      `shell ${JSON.stringify(choice)} is not available on ${platform}; use one of: ${allowed.join(", ")}`,
    );
  }

  if (policy.name === choice) return policy;
  return resolveNamed(choice, platform, env, probe, run, undefined, true);
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
