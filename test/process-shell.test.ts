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
  type ExecutableProbe,
  POSIX_SHELL_ENV,
  POSIX_SHELL_PATH_ENV,
  resolveShellPolicy,
  SHELL_ENV,
  SHELL_PATH_ENV,
  selectShell,
  shellInvocation,
} from "../src/tasks/process/shell.js";
import { createHarness, resultText } from "./support/extension-harness.js";
import { killTree, makeTempDir, waitFor, writeScript } from "./support/processes.js";

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
  const started = await harness.call("bg_run", { name: "shell", command });
  const details = started.details as TaskDetails;
  if (details.pid !== undefined) spawned.push(details.pid);

  await waitFor("completion", async () => {
    const status = await harness.call("bg_status", { id: details.id });
    return (status.details as TaskDetails).status !== "running";
  });

  const settled = (await harness.call("bg_status", { id: details.id })).details as TaskDetails;
  const logged = await harness.call("bg_logs", { id: details.id, full: true });
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

    // The pipe target differs by platform because the pipe itself must be real.
    const pipe = process.platform === "win32" ? "findstr piped" : "grep piped";
    const read = process.platform === "win32" ? "type result.txt" : "cat result.txt";
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
  it("hands a Windows command to one cmd.exe with verbatim arguments", () => {
    const policy = resolveShellPolicy({
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      probe: nothing,
    });

    expect(policy).toEqual({ name: "cmd", executable: "C:\\Windows\\system32\\cmd.exe" });
    const invocation = shellInvocation(policy, 'echo "a b" && echo done');
    expect(invocation.args).toEqual(["/d", "/s", "/c", '"echo "a b" && echo done"']);
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });

  it("falls back to cmd.exe when ComSpec is unset", () => {
    expect(resolveShellPolicy({ platform: "win32", env: {}, probe: nothing })).toEqual({
      name: "cmd",
      executable: "cmd.exe",
    });
  });

  it("runs bash with -c and Node's own escaping when configured", () => {
    const policy = resolveShellPolicy({
      platform: "win32",
      env: { [SHELL_ENV]: "bash", PATH: "C:\\tools;C:\\Windows\\system32" },
      probe: finds("C:\\tools\\bash.exe"),
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
    });
    expect(policy.executable).toBe("C:\\tools\\bash.com");
  });

  it("says which key and which places it searched when bash is missing", () => {
    const message = thrownMessage(() =>
      resolveShellPolicy({
        platform: "win32",
        env: { [SHELL_ENV]: "bash", PATH: "C:\\nowhere" },
        probe: nothing,
      }),
    );

    expect(message).toContain(SHELL_ENV);
    expect(message).toContain("bash.exe");
    expect(message).toContain("bash.com");
    expect(message).toContain("C:\\nowhere");
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
  it("runs a POSIX command in the user's shell without a login shell", () => {
    const policy = resolveShellPolicy({
      platform: "linux",
      env: { SHELL: "/bin/bash" },
      probe: nothing,
    });

    expect(policy).toEqual({ name: "inherit", executable: "/bin/bash" });
    const invocation = shellInvocation(policy, "ls | wc -l");
    expect(invocation.args).toEqual(["-c", "ls | wc -l"]);
    expect(invocation.args).not.toContain("-l");
    expect(invocation.windowsVerbatimArguments).toBe(false);
  });

  it("defaults to /bin/sh when SHELL is unset", () => {
    expect(resolveShellPolicy({ platform: "darwin", env: {}, probe: nothing }).executable).toBe(
      "/bin/sh",
    );
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
  const windows = { platform: "win32" as const, env: { PATH: "C:\\tools" }, probe: nothing };

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
    const posix = { platform: "linux" as const, env: {}, probe: nothing };
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
 * The same choice, one level up: a `bg_run` call must fail in the turn that asked
 * for an impossible shell, rather than leaving a task nobody can run.
 */
describe("bg_run's shell override", () => {
  const onWindows = process.platform === "win32";

  it("rejects a shell this platform does not have and names the ones it does", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness(
      { cwd: dir.path, sessionId: `session-reject-${String(Date.now())}` },
      { env: {} },
    );
    const refused = onWindows ? "sh" : "cmd";

    const started = await harness.call("bg_run", { command: "echo hi", shell: refused });
    const message = resultText(started);

    expect(message).toContain(`"${refused}"`);
    expect(message).toContain(onWindows ? "bash" : "inherit");
    expect(message).toContain("The task was not started.");
    const listed = await harness.call("bg_status", {});
    expect(resultText(listed)).not.toContain("echo hi");
  });

  it.skipIf(!hasBash())("runs one call in bash when the platform has one", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness({
      cwd: dir.path,
      sessionId: `session-bash-${String(Date.now())}`,
    });

    const started = await harness.call("bg_run", {
      name: "bash call",
      command: "echo from-bash",
      shell: "bash",
    });
    const details = started.details as TaskDetails;
    if (details.pid !== undefined) spawned.push(details.pid);
    await waitFor("completion", async () => {
      const status = await harness.call("bg_status", { id: details.id });
      return (status.details as TaskDetails).status !== "running";
    });

    const settled = (await harness.call("bg_status", { id: details.id })).details as TaskDetails;
    const logged = resultText(await harness.call("bg_logs", { id: details.id, full: true }));
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
