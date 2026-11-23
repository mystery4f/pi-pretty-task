/**
 * Platform seam: one command in, one shell invocation out. These tests pin the
 * shell contract that makes builtins, `&&`, pipes, redirection and quoted paths
 * behave as they do in a terminal — on this host, and for both platforms.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  type CommandRunner,
  type ExecutableProbe,
  POSIX_SHELL_ENV,
  POSIX_SHELL_PATH_ENV,
  resolveShellPolicy,
  SHELL_ENV,
  SHELL_PATH_ENV,
  selectShell,
  shellInvocation,
} from "../../src/tasks/process/shell.js";
import { createHarness, resultText } from "../support/extension-harness.js";
import { killTree, makeTempDir, waitFor, writeScript } from "../support/processes.js";

interface TaskDetails {
  id: string;
  status: string;
  pid?: number;
  exitCode?: number | null;
}

const cleanup: Array<() => Promise<void>> = [];
const spawned: number[] = [];

afterEach(async () => {
  while (spawned.length > 0) await killTree(spawned.pop());
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function runAndWait(
  cwd: string,
  command: string,
): Promise<{ id: string; details: TaskDetails; text: string }> {
  const harness = createHarness({ cwd, sessionId: `session-${String(Date.now())}` });
  const started = await harness.call("pretty_task_bg_run", { name: "shell", command });
  const details = started.details as TaskDetails;
  if (details.pid !== undefined) spawned.push(details.pid);

  await waitFor("completion", async () => {
    const status = await harness.call("pretty_task_bg_status", { id: details.id });
    return (status.details as TaskDetails).status !== "running";
  });

  const settled = (await harness.call("pretty_task_bg_status", { id: details.id }))
    .details as TaskDetails;
  const logged = await harness.call("pretty_task_bg_logs", { id: details.id, full: true });
  return { id: details.id, details: settled, text: resultText(logged) };
}
describe("the shell a command runs in", () => {
  it("runs builtins, &&, a pipe and redirection as a terminal does", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const script = await writeScript(
      dir.path,
      "line.js",
      "process.stdout.write('from script\\n');\n",
    );

    // The pipe target differs by shell because the pipe itself must be real.
    const cmd = resolveShellPolicy({ env: inheritedEnv() }).name === "cmd";
    const pipe = cmd ? "findstr piped" : "grep piped";
    const read = cmd ? "type result.txt" : "cat result.txt";
    const command = `echo start && ${script} && echo done > result.txt && ${read} && echo piped | ${pipe}`;

    const { details, text } = await runAndWait(dir.path, command);
    expect(text).toContain("start");
    expect(text).toContain("from script");
    expect(text).toContain("done");
    expect(text).toContain("piped");
    expect(details.status).toBe("completed");
    expect(details.exitCode).toBe(0);

    const redirected = await readFile(join(dir.path, "result.txt"), "utf8");
    expect(redirected).toContain("done");
  });

  it("runs a quoted path that contains spaces", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const spaced = join(dir.path, "a folder");
    await mkdir(spaced, { recursive: true });
    const command = await writeScript(
      spaced,
      "hello.js",
      "process.stdout.write('hello spaced\\n');\n",
    );
    expect(command).toContain('"');

    const { text } = await runAndWait(dir.path, command);
    expect(text).toContain("hello spaced");
  });
});

/** A probe that finds nothing: the policy tests own what "installed" means. */
const nothing: ExecutableProbe = () => false;

/** No `where` or `reg` on this host: a test that must not touch either says so. */
const nowhere: CommandRunner = () => undefined;

/** A `where`/`reg` that answers with the same output, whatever it is asked. */
function reports(stdout: string): CommandRunner {
  return () => stdout;
}

/** `process.env` without the policy keys: the environment the harness hands the extension. */
function inheritedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PI_PRETTY_TASK_")),
  );
}

function finds(...candidates: readonly string[]): ExecutableProbe {
  return (candidate) => candidates.includes(candidate);
}

/** The message of the error `run` throws: a report has to be checked piece by piece. */
function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
}

describe("the shell policy of a Windows command", () => {
  it("hands a cmd command to one cmd.exe with verbatim arguments", () => {
    const policy = resolveShellPolicy({
      platform: "win32",
      env: { [SHELL_ENV]: "cmd", ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      probe: nothing,
    });

    expect(policy).toEqual({ name: "cmd", executable: "C:\\Windows\\system32\\cmd.exe" });
    const invocation = shellInvocation(policy, 'echo "a b" && echo done');
    expect(invocation.args).toEqual(["/d", "/s", "/c", '"echo "a b" && echo done"']);
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });

  it("falls back to cmd.exe when ComSpec is unset", () => {
    const policy = resolveShellPolicy({
      platform: "win32",
      env: { [SHELL_ENV]: "cmd" },
      probe: nothing,
    });
    expect(policy).toEqual({ name: "cmd", executable: "cmd.exe" });
  });

  it("defaults to the bash beside the git on PATH", () => {
    const policy = resolveShellPolicy({
      platform: "win32",
      env: {},
      probe: finds("D:\\Soft\\Git\\bin\\bash.exe"),
      run: reports("D:\\Soft\\Git\\mingw64\\bin\\git.exe\r\nD:\\Soft\\Git\\cmd\\git.exe\r\n"),
    });
    expect(policy).toEqual({ name: "bash", executable: "D:\\Soft\\Git\\bin\\bash.exe" });
  });

  it("prefers the Git Bash pi was started from and asks nothing else", () => {
    const asked: string[] = [];
    const run: CommandRunner = (file) => {
      asked.push(file);
      return undefined;
    };
    const policy = resolveShellPolicy({
      platform: "win32",
      env: { EXEPATH: "D:\\Soft\\Git\\bin", SHELL: "D:\\Soft\\Git\\usr\\bin\\bash.exe" },
      probe: finds("D:\\Soft\\Git\\bin\\bash.exe"),
      run,
    });
    expect(policy).toEqual({ name: "bash", executable: "D:\\Soft\\Git\\bin\\bash.exe" });
    expect(asked).toEqual([]);
  });

  it("reads Git for Windows from the registry when neither launch nor PATH names one", () => {
    const run: CommandRunner = (_file, args) =>
      args[0] === "query" && args[1] === "HKLM\\SOFTWARE\\GitForWindows"
        ? "\nHKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows\n    InstallPath    REG_SZ    D:\\Soft\\Git\n\n"
        : undefined;
    const policy = resolveShellPolicy({
      platform: "win32",
      env: { PATH: "C:\\Windows\\system32" },
      probe: finds("D:\\Soft\\Git\\bin\\bash.exe"),
      run,
    });
    expect(policy).toEqual({ name: "bash", executable: "D:\\Soft\\Git\\bin\\bash.exe" });
  });

  it("finds bash in the usual install directories", () => {
    const policy = resolveShellPolicy({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      probe: finds("C:\\Program Files\\Git\\bin\\bash.exe"),
      run: nowhere,
    });
    expect(policy.executable).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("falls back to a bash on PATH, bash.com included", () => {
    const policy = resolveShellPolicy({
      platform: "win32",
      env: { PATH: "C:\\tools" },
      probe: finds("C:\\tools\\bash.com"),
      run: nowhere,
    });
    expect(policy).toEqual({ name: "bash", executable: "C:\\tools\\bash.com" });
  });

  it("blames the default and names cmd as the way out when no bash exists", () => {
    const message = thrownMessage(() =>
      resolveShellPolicy({
        platform: "win32",
        env: { PATH: "C:\\nowhere" },
        probe: nothing,
        run: nowhere,
      }),
    );
    expect(message).toContain("(the default on Windows)");
    expect(message).toContain("set PI_PRETTY_TASK_SHELL=cmd");
    expect(message).toContain('bash.exe and bash.com in PATH "C:\\nowhere"');
  });

  it("runs bash with -c and Node's own escaping when configured", () => {
    const policy = resolveShellPolicy({
      platform: "win32",
      env: { [SHELL_ENV]: "bash", PATH: "C:\\tools;C:\\Windows\\system32" },
      probe: finds("C:\\tools\\bash.exe"),
      run: nowhere,
    });

    expect(policy).toEqual({ name: "bash", executable: "C:\\tools\\bash.exe" });
    const invocation = shellInvocation(policy, "echo 'a b'");
    expect(invocation.args).toEqual(["-c", "echo 'a b'"]);
    // Verbatim arguments are a cmd trick; bash takes a normally escaped argv.
    expect(invocation.windowsVerbatimArguments).toBe(false);
  });

  it("finds bash.com where a bash.exe is not installed", () => {
    const policy = resolveShellPolicy({
      platform: "win32",
      env: { [SHELL_ENV]: "bash", PATH: "C:\\tools" },
      probe: finds("C:\\tools\\bash.com"),
      run: nowhere,
    });
    expect(policy.executable).toBe("C:\\tools\\bash.com");
  });

  it("says which key and which places it searched when bash is missing", () => {
    const message = thrownMessage(() =>
      resolveShellPolicy({
        platform: "win32",
        env: { [SHELL_ENV]: "bash", PATH: "C:\\nowhere" },
        probe: nothing,
        run: nowhere,
      }),
    );

    expect(message).toContain(SHELL_ENV);
    expect(message).toContain("bash.exe");
    expect(message).toContain("bash.com");
    expect(message).toContain("C:\\nowhere");
    expect(message).toContain(`or ${SHELL_PATH_ENV} to the bash.exe to use`);
  });

  it("rejects a selector value it does not know", () => {
    expect(() =>
      resolveShellPolicy({ platform: "win32", env: { [SHELL_ENV]: "zsh" }, probe: nothing }),
    ).toThrow(/PI_PRETTY_TASK_SHELL.*"zsh".*cmd, bash/);
  });

  it("rejects the POSIX key on Windows", () => {
    expect(() =>
      resolveShellPolicy({ platform: "win32", env: { [POSIX_SHELL_ENV]: "bash" }, probe: nothing }),
    ).toThrow(/PI_PRETTY_TASK_POSIX_SHELL/);
  });

  it("uses an absolute shell path when it is configured", () => {
    const policy = resolveShellPolicy({
      platform: "win32",
      env: { [SHELL_ENV]: "bash", [SHELL_PATH_ENV]: "D:\\Git\\bin\\bash.exe" },
      probe: nothing,
    });
    expect(policy).toEqual({ name: "bash", executable: "D:\\Git\\bin\\bash.exe" });
  });

  it("rejects a shell path without its shell key", () => {
    expect(() =>
      resolveShellPolicy({
        platform: "win32",
        env: { [SHELL_PATH_ENV]: "D:\\Git\\bin\\bash.exe" },
        probe: nothing,
      }),
    ).toThrow(/PI_PRETTY_TASK_SHELL_PATH.*PI_PRETTY_TASK_SHELL/);
  });

  it("rejects a shell path that is not absolute", () => {
    expect(() =>
      resolveShellPolicy({
        platform: "win32",
        env: { [SHELL_ENV]: "bash", [SHELL_PATH_ENV]: "bin\\bash.exe" },
        probe: nothing,
      }),
    ).toThrow(/PI_PRETTY_TASK_SHELL_PATH.*absolute.*"bin\\\\bash\.exe"/);
  });
});

describe("the shell policy of a POSIX command", () => {
  it("runs a POSIX command in the user's shell when told to inherit it, without a login shell", () => {
    const policy = resolveShellPolicy({
      platform: "linux",
      env: { [POSIX_SHELL_ENV]: "inherit", SHELL: "/bin/bash" },
      probe: nothing,
    });

    expect(policy).toEqual({ name: "inherit", executable: "/bin/bash" });
    const invocation = shellInvocation(policy, "ls | wc -l");
    expect(invocation.args).toEqual(["-c", "ls | wc -l"]);
    expect(invocation.args).not.toContain("-l");
    expect(invocation.windowsVerbatimArguments).toBe(false);
  });

  it("defaults to bash from /bin", () => {
    expect(resolveShellPolicy({ platform: "linux", env: {}, probe: finds("/bin/bash") })).toEqual({
      name: "bash",
      executable: "/bin/bash",
    });
  });

  it("inherit falls back to /bin/sh when SHELL is unset", () => {
    const policy = resolveShellPolicy({
      platform: "darwin",
      env: { [POSIX_SHELL_ENV]: "inherit" },
      probe: nothing,
    });
    expect(policy).toEqual({ name: "inherit", executable: "/bin/sh" });
  });

  it("resolves bash and sh from /bin first", () => {
    const bash = resolveShellPolicy({
      platform: "linux",
      env: { [POSIX_SHELL_ENV]: "bash" },
      probe: finds("/bin/bash"),
    });
    expect(bash).toEqual({ name: "bash", executable: "/bin/bash" });

    const sh = resolveShellPolicy({
      platform: "linux",
      env: { [POSIX_SHELL_ENV]: "sh" },
      probe: finds("/bin/sh"),
    });
    expect(sh).toEqual({ name: "sh", executable: "/bin/sh" });
  });

  it("falls back to PATH when /bin has no bash", () => {
    const policy = resolveShellPolicy({
      platform: "darwin",
      env: { [POSIX_SHELL_ENV]: "bash", PATH: "/opt/homebrew/bin:/usr/local/bin" },
      probe: finds("/opt/homebrew/bin/bash"),
    });
    expect(policy.executable).toBe("/opt/homebrew/bin/bash");
  });

  it("says which key and which places it searched when bash is missing", () => {
    expect(() =>
      resolveShellPolicy({
        platform: "linux",
        env: { [POSIX_SHELL_ENV]: "bash", PATH: "/nowhere" },
        probe: nothing,
      }),
    ).toThrow(/PI_PRETTY_TASK_POSIX_SHELL.*bash.*\/bin\/bash.*\/nowhere/s);
    const message = thrownMessage(() =>
      resolveShellPolicy({ platform: "linux", env: {}, probe: nothing }),
    );
    expect(message).toContain("(the default)");
    expect(message).toContain("sh or inherit");
  });

  it("rejects a selector value it does not know", () => {
    expect(() =>
      resolveShellPolicy({
        platform: "linux",
        env: { [POSIX_SHELL_ENV]: "pwsh" },
        probe: nothing,
      }),
    ).toThrow(/PI_PRETTY_TASK_POSIX_SHELL.*"pwsh".*inherit, bash, sh/);
  });

  it("rejects the Windows key on POSIX", () => {
    expect(() =>
      resolveShellPolicy({ platform: "linux", env: { [SHELL_ENV]: "bash" }, probe: nothing }),
    ).toThrow(/PI_PRETTY_TASK_SHELL/);
  });

  it("rejects a shell path that is not executable", () => {
    expect(() =>
      resolveShellPolicy({
        platform: "linux",
        env: { [POSIX_SHELL_ENV]: "bash", [POSIX_SHELL_PATH_ENV]: "/opt/bash" },
        probe: nothing,
      }),
    ).toThrow(/PI_PRETTY_TASK_POSIX_SHELL_PATH.*executable.*"\/opt\/bash"/);
  });

  it("rejects a shell path without its shell key", () => {
    expect(() =>
      resolveShellPolicy({
        platform: "linux",
        env: { [POSIX_SHELL_PATH_ENV]: "/opt/bash" },
        probe: nothing,
      }),
    ).toThrow(/PI_PRETTY_TASK_POSIX_SHELL_PATH.*PI_PRETTY_TASK_POSIX_SHELL/);
  });

  it("uses an executable shell path when it is configured", () => {
    const policy = resolveShellPolicy({
      platform: "linux",
      env: { [POSIX_SHELL_ENV]: "bash", [POSIX_SHELL_PATH_ENV]: "/opt/bash" },
      probe: finds("/opt/bash"),
    });
    expect(policy).toEqual({ name: "bash", executable: "/opt/bash" });
  });
});

describe("one call's shell override", () => {
  const windows = {
    platform: "win32" as const,
    env: { [SHELL_ENV]: "cmd", PATH: "C:\\tools" },
    probe: nothing,
    run: nowhere,
  };

  it("leaves the configured policy alone for default", () => {
    const policy = resolveShellPolicy(windows);
    expect(selectShell(policy, "default", windows)).toBe(policy);
    expect(selectShell(policy, undefined, windows)).toBe(policy);
  });

  it("refuses a shell the platform does not have, listing the ones it has", () => {
    expect(() => selectShell(resolveShellPolicy(windows), "sh", windows)).toThrow(
      /"sh".*win32.*default, cmd, bash/,
    );
  });

  it("refuses cmd on POSIX the same way", () => {
    const posix = {
      platform: "linux" as const,
      env: { [POSIX_SHELL_ENV]: "inherit" },
      probe: nothing,
    };
    expect(() => selectShell(resolveShellPolicy(posix), "cmd", posix)).toThrow(
      /"cmd".*linux.*default, bash, sh/,
    );
  });

  it("switches one call to bash without touching the default", () => {
    const policy = resolveShellPolicy(windows);
    const override = selectShell(policy, "bash", {
      ...windows,
      probe: finds("C:\\tools\\bash.exe"),
    });

    expect(policy.name).toBe("cmd");
    expect(override).toEqual({ name: "bash", executable: "C:\\tools\\bash.exe" });
  });

  it("reuses the configured path when the override names the same shell", () => {
    const env = { [SHELL_ENV]: "bash", [SHELL_PATH_ENV]: "D:\\Git\\bin\\bash.exe" };
    const configured = resolveShellPolicy({ platform: "win32", env, probe: nothing });
    const override = selectShell(configured, "bash", { platform: "win32", env, probe: nothing });
    expect(override.executable).toBe("D:\\Git\\bin\\bash.exe");
  });

  it("ignores the configured path when the override names another shell", () => {
    const env = {
      [SHELL_ENV]: "bash",
      [SHELL_PATH_ENV]: "D:\\Git\\bin\\bash.exe",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
    };
    const configured = resolveShellPolicy({ platform: "win32", env, probe: nothing });
    const override = selectShell(configured, "cmd", { platform: "win32", env, probe: nothing });
    expect(override.executable).toBe("C:\\Windows\\system32\\cmd.exe");
  });
});

/**
 * The same choice, one level up: a `pretty_task_bg_run` call must fail in the turn that asked
 * for an impossible shell, rather than leaving a task nobody can run.
 */
describe("pretty_task_bg_run's shell override", () => {
  const onWindows = process.platform === "win32";

  it("rejects a shell this platform does not have and names the ones it does", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness(
      { cwd: dir.path, sessionId: `session-reject-${String(Date.now())}` },
      { env: onWindows ? { [SHELL_ENV]: "cmd" } : { [POSIX_SHELL_ENV]: "inherit" } },
    );
    const refused = onWindows ? "sh" : "cmd";

    const started = await harness.call("pretty_task_bg_run", {
      command: "echo hi",
      shell: refused,
    });
    const message = resultText(started);

    expect(message).toContain(`"${refused}"`);
    // The per-call override names the shells this platform accepts; the POSIX
    // variable's `inherit` belongs to the environment-key error, not this one.
    expect(message).toContain("use one of: default");
    expect(message).toContain(onWindows ? "cmd" : "bash");
    expect(message).toContain("The task was not started.");
    const listed = await harness.call("pretty_task_bg_status", {});
    expect(resultText(listed)).not.toContain("echo hi");
  });

  it.skipIf(!hasBash())("runs one call in bash when the platform has one", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness({
      cwd: dir.path,
      sessionId: `session-bash-${String(Date.now())}`,
    });

    const started = await harness.call("pretty_task_bg_run", {
      name: "bash call",
      command: "echo from-bash",
      shell: "bash",
    });
    const details = started.details as TaskDetails;
    if (details.pid !== undefined) spawned.push(details.pid);
    await waitFor("completion", async () => {
      const status = await harness.call("pretty_task_bg_status", { id: details.id });
      return (status.details as TaskDetails).status !== "running";
    });

    const settled = (await harness.call("pretty_task_bg_status", { id: details.id }))
      .details as TaskDetails;
    const logged = resultText(
      await harness.call("pretty_task_bg_logs", { id: details.id, full: true }),
    );
    expect(settled.status).toBe("completed");
    expect(logged).toContain("from-bash");
  });
});

/** Whether this host has a bash the policy can find; a missing one skips, not fails. */
function hasBash(): boolean {
  try {
    selectShell(resolveShellPolicy(), "bash");
    return true;
  } catch {
    return false;
  }
}
