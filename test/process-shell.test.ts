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

import { resolveShellInvocation } from "../src/tasks/process/supervisor.js";
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

describe("resolveShellInvocation", () => {
  it("hands a Windows command to one cmd.exe with verbatim arguments", () => {
    const invocation = resolveShellInvocation('echo "a b" && echo done', "win32", {
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
    });

    expect(invocation.executable).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(invocation.args).toEqual(["/d", "/s", "/c", '"echo "a b" && echo done"']);
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });

  it("falls back to cmd.exe when ComSpec is unset", () => {
    expect(resolveShellInvocation("dir", "win32", {}).executable).toBe("cmd.exe");
  });

  it("runs a POSIX command in the user's shell without a login shell", () => {
    const invocation = resolveShellInvocation("ls | wc -l", "linux", { SHELL: "/bin/bash" });

    expect(invocation.executable).toBe("/bin/bash");
    expect(invocation.args).toEqual(["-c", "ls | wc -l"]);
    expect(invocation.args).not.toContain("-l");
    expect(invocation.windowsVerbatimArguments).toBe(false);
  });

  it("defaults to /bin/sh when SHELL is unset", () => {
    expect(resolveShellInvocation("true", "darwin", {}).executable).toBe("/bin/sh");
  });
});
