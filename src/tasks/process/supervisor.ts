/**
 * The process supervisor: the one module that knows how a command is started
 * and how its output is captured. Every platform-specific detail lives here
 * and nowhere else (ADR-0004). Termination joins this module with the kill
 * ticket; nothing else in the project may spawn a process.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

/** How one command is handed to this platform's shell. */
export interface ShellInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

/**
 * Pick the shell for a command.
 *
 * Windows runs the command through `cmd.exe /d /s /c "<command>"` with verbatim
 * arguments, exactly as a terminal does, so builtins, `&&` and quoted paths
 * behave the same. `/d` skips AutoRun registry commands, `/s` makes the outer
 * quote pair be stripped rather than reinterpreted, and verbatim arguments stop
 * Node from re-quoting anything we pass — without them a command containing
 * quotes reaches cmd mangled.
 *
 * POSIX runs the user's own shell with `-c`: no `-l`, so no login-shell startup
 * files run and the command sees the environment pi was started with.
 */
export function resolveShellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellInvocation {
  if (platform === "win32") {
    const comSpec = env.ComSpec;
    return {
      executable: comSpec !== undefined && comSpec.length > 0 ? comSpec : "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  const shell = env.SHELL;
  return {
    executable: shell !== undefined && shell.length > 0 ? shell : "/bin/sh",
    args: ["-c", command],
    windowsVerbatimArguments: false,
  };
}

/** How a process ended. */
export interface ProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/** A command that is already running, with its output going to one file. */
export interface RunningProcess {
  readonly pid: number | undefined;
  /** Resolves once the process is gone and every byte it wrote is on disk. */
  readonly exit: Promise<ProcessExit>;
  /** Bytes flushed to the output file so far. */
  bytesWritten(): number;
}

export interface StartProcessOptions {
  command: string;
  /** Directory the command runs in. */
  cwd: string;
  /** Output file; created or appended to. */
  outputPath: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
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
  const invocation = resolveShellInvocation(options.command, platform, options.env);

  const output = createWriteStream(options.outputPath, { flags: "a" });
  let bytesWritten = 0;

  const child = spawn(invocation.executable, [...invocation.args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    // stdio: the shell inherits these pipes, so grandchildren write here too.
    stdio: ["ignore", "pipe", "pipe"],
    // POSIX: a new process group makes the whole tree addressable by one
    // negative pid when it is stopped. Windows gets its tree stop from
    // `taskkill /T` instead, and `detached` there would only risk a new console.
    detached: platform !== "win32",
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    bytesWritten += chunk.length;
    output.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    bytesWritten += chunk.length;
    output.write(chunk);
  });

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
      output.end(() => {
        succeed({ exitCode, signal });
      });
    });
  });

  return {
    pid: child.pid,
    exit,
    bytesWritten: () => bytesWritten,
  };
}
