/**
 * The process supervisor: the one module that knows how a command is started,
 * how its output is captured, and how it and everything it started are stopped.
 * Every platform-specific detail lives here and nowhere else (ADR-0004):
 * nothing else in the project may spawn or signal a process.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { win32 as windowsPath } from "node:path";

import {
  resolveShellPolicy,
  type ShellChoice,
  type ShellPolicy,
  selectShell,
  shellInvocation,
} from "./shell.js";

/** How one command is handed to this platform's shell lives with the policy (ADR-0008). */
export type { ShellInvocation } from "./shell.js";

/** How a process ended. */
export interface ProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/** How a stop request ended. */
export type StopOutcome =
  /** The tree is gone; the polite signal or the forced kill took it down. */
  | "stopped"
  /** Nothing was left to signal: the command had already ended. */
  | "already-exited"
  /** The forced kill was sent but the tree is still there. */
  | "tree-survived";

export interface StopResult {
  readonly outcome: StopOutcome;
  /** Milliseconds from the stop request to this answer. */
  readonly tookMs: number;
  /** What the system said, when the tree could not be confirmed gone. */
  readonly detail?: string;
}

export interface StopProcessOptions {
  /** How long the polite signal gets before the forced kill. Defaults to 3s. */
  graceMs?: number;
  /** How long the forced kill gets to clear the tree. Defaults to 5s. */
  confirmMs?: number;
}

/** A command that is already running, with its output going to one file. */
export interface RunningProcess {
  readonly pid: number | undefined;
  /** Resolves once the process is gone and every byte it wrote is on disk. */
  readonly exit: Promise<ProcessExit>;
  /** Bytes flushed to the output file so far. */
  bytesWritten(): number;
  /**
   * Stop the command and everything it started: a polite signal, a grace
   * period, a forced kill, then polling until the whole tree is gone. A second
   * call returns the first answer instead of signalling twice.
   */
  stop(options?: StopProcessOptions): Promise<StopResult>;
  /** True once a stop signal was actually delivered to the tree. */
  signalled(): boolean;
}

export interface StartProcessOptions {
  command: string;
  /** Directory the command runs in. */
  cwd: string;
  /** Output file; created or appended to. */
  outputPath: string;
  /**
   * Bytes the output file may hold. Chunks that would cross the cap are kept up
   * to the cap and then dropped, so the file stops on the exact byte while the
   * stop travels to the tree.
   */
  maxOutputBytes?: number;
  /** Called once, when a chunk is dropped for crossing `maxOutputBytes`. */
  onOutputCap?: () => void;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Shell resolved at load time; resolved from `env` when it is not given. */
  shellPolicy?: ShellPolicy;
  /** Shell for this one command; the policy's shell unless this names another. */
  shell?: ShellChoice;
}

/**
 * Start one command and stream stdout and stderr into one output file.
 *
 * Both pipes write into the same append stream, so the file holds the two
 * streams in the order the writes arrive instead of two files the reader would
 * have to interleave by hand. The exit promise resolves only after the stream
 * has flushed, so "the task finished" always means "its output is on disk".
 */
export function startProcess(options: StartProcessOptions): RunningProcess {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  // A per-call shell is resolved before anything is spawned, so a shell this platform
  // does not have rejects the call instead of leaving a task that cannot run.
  const policy = options.shellPolicy ?? resolveShellPolicy({ platform, env });
  const invocation = shellInvocation(
    selectShell(policy, options.shell, { platform, env }),
    options.command,
  );
  const output = createWriteStream(options.outputPath, { flags: "a" });
  let bytesWritten = 0;
  // Stop state lives outside the exit promise: a stop can answer before the exit
  // bookkeeping arrives, and a second stop must not signal a second time.
  let exited = false;
  let signalled = false;
  let stopping: Promise<StopResult> | undefined;
  const child = spawn(invocation.executable, [...invocation.args], {
    cwd: options.cwd,
    env,
    // stdio: the shell inherits these pipes, so grandchildren write here too.
    stdio: ["ignore", "pipe", "pipe"],
    // POSIX: a new process group makes the whole tree addressable by one
    // negative pid when it is stopped. Windows gets its tree stop from
    // `taskkill /T` instead, and `detached` there would only risk a new console.
    detached: platform !== "win32",
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });

  // The cap has to hold while the stop travels, and a runaway command keeps
  // writing until its tree is gone. Later chunks are still read and dropped:
  // leaving them in a full pipe would block the child instead of stopping it.
  // The callback fires on the first dropped byte, so a command that ends exactly
  // on the cap is not reported as having crossed it.
  const cap = options.maxOutputBytes;
  let overCap = false;
  const capture = (chunk: Buffer): void => {
    const room = cap === undefined ? chunk.length : cap - bytesWritten;
    if (room > 0) {
      const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
      bytesWritten += kept.length;
      output.write(kept);
    }
    if (cap !== undefined && !overCap && chunk.length > room) {
      overCap = true;
      options.onOutputCap?.();
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const exit = new Promise<ProcessExit>((resolve, reject) => {
    // First settlement wins: a spawn failure and a close can both arrive.
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = (result: ProcessExit): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", fail);
    // A stream that cannot be written must not leave the task "running" forever.
    output.once("error", fail);
    // `close` (not `exit`) fires after both pipes have ended, so no chunk is
    // still in flight when the stream below is ended and the file is complete.
    child.once("close", (exitCode, signal) => {
      exited = true;
      output.end(() => {
        succeed({ exitCode, signal });
      });
    });
  });

  const stopTree = async (stopOptions: StopProcessOptions): Promise<StopResult> => {
    const startedAt = Date.now();
    const pid = child.pid;
    if (pid === undefined || exited || !isTreeAlive(platform, pid)) {
      // Nothing to signal. A command that already ended is answered, not an error.
      return { outcome: "already-exited", tookMs: Date.now() - startedAt };
    }

    const graceMs = Math.max(0, stopOptions.graceMs ?? KILL_GRACE_MS);
    const confirmMs = Math.max(0, stopOptions.confirmMs ?? KILL_CONFIRM_MS);

    signalled = true;
    const refusal = await signalTree(platform, "polite", pid, child, env);
    if (await waitForTreeGone(platform, pid, graceMs)) {
      return { outcome: "stopped", tookMs: Date.now() - startedAt };
    }

    const forcedRefusal = await signalTree(platform, "force", pid, child, env);
    if (await waitForTreeGone(platform, pid, confirmMs)) {
      return { outcome: "stopped", tookMs: Date.now() - startedAt };
    }

    return {
      outcome: "tree-survived",
      tookMs: Date.now() - startedAt,
      detail:
        firstLine(forcedRefusal) ??
        firstLine(refusal) ??
        `the tree was still present ${String(confirmMs)}ms after the forced kill`,
    };
  };

  const stop = (stopOptions: StopProcessOptions = {}): Promise<StopResult> => {
    stopping ??= stopTree(stopOptions);
    return stopping;
  };

  return {
    pid: child.pid,
    exit,
    bytesWritten: () => bytesWritten,
    stop,
    signalled: () => signalled,
  };
}

/** How long a stop lets the polite signal work before forcing. */
const KILL_GRACE_MS = 3000;
/** How long a stop waits for a forced kill to clear the tree. */
const KILL_CONFIRM_MS = 5000;
/** Distance between two liveness checks while waiting. */
const KILL_POLL_MS = 50;
/** A helper that hangs must not hold up the kill. */
const TASKKILL_TIMEOUT_MS = 5000;

/**
 * Ask the whole tree to go away, politely or by force. Returns what the system
 * said when it refused, or undefined when the request was accepted.
 */
async function signalTree(
  platform: NodeJS.Platform,
  phase: "polite" | "force",
  pid: number,
  child: ChildProcess,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (platform === "win32") {
    // Windows has no process group a pid can address, so the tree is stopped
    // through `taskkill /T`, which walks the parent links from our pid. Without
    // `/F` it asks each console program to close, which a program without a
    // window cannot honour; `/F` terminates every process in the tree. The
    // polite phase still goes first so a windowed program can close in its own
    // time instead of being terminated outright.
    const args = ["/PID", String(pid), "/T"];
    if (phase === "force") args.push("/F");
    return runTaskkill(args, env);
  }
  // POSIX: the command leads its own process group (spawn `detached`), so a
  // negative pid addresses the command and everything it started at once, for as
  // long as they stay in that group.
  const signal = phase === "polite" ? "SIGTERM" : "SIGKILL";
  try {
    process.kill(-pid, signal);
    return undefined;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return undefined;
    // The group can be gone while the shell is still signallable, for example
    // when the group leader exited first; the pid we own is still ours to signal.
    try {
      child.kill(signal);
      return undefined;
    } catch (fallbackError) {
      return `${signal} was refused: ${messageOf(fallbackError)}`;
    }
  }
}

/**
 * True while any process of the tree is still there. POSIX asks the process
 * group; Windows has no group, so the command's own pid is the only handle and
 * `taskkill /T` is what makes the children go with it.
 */
function isTreeAlive(platform: NodeJS.Platform, pid: number): boolean {
  if (platform === "win32") return isProcessAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM means the group exists but is not ours to signal: still alive.
    return errorCode(error) === "EPERM";
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/** Poll until the tree is gone, or until the timeout says it is not. */
async function waitForTreeGone(
  platform: NodeJS.Platform,
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isTreeAlive(platform, pid)) return true;
    if (Date.now() >= deadline) return false;
    await delay(KILL_POLL_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Run this platform's taskkill and report the first line it said. It is run from
 * `%SystemRoot%\System32` because a `taskkill.exe` planted earlier on PATH would
 * otherwise be the program that receives the kill arguments.
 */
function runTaskkill(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const executable = taskkillPath(env);
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      { env, timeout: TASKKILL_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(undefined);
          return;
        }
        resolve(firstLine(stderr) ?? firstLine(stdout) ?? messageOf(error));
      },
    );
  });
}

function taskkillPath(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.WINDIR;
  if (root !== undefined && root.length > 0) {
    return windowsPath.join(root, "System32", "taskkill.exe");
  }
  return "taskkill";
}

function firstLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
