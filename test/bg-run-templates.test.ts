/**
 * `bg_run` by name: a template fills in the command, directory and timeout, and
 * an unknown name is answered with the names that do exist. These tests drive the
 * registered tool through the harness, so they see exactly what the model sees.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionTaskDirectory, taskRecordPath } from "../src/tasks/base/runtime-state.js";
import { templateConfigPaths } from "../src/tasks/process/templates.js";
import { createHarness, type Harness, resultText } from "./support/extension-harness.js";
import { killTree, makeTempDir, waitFor, writeScript } from "./support/processes.js";

interface TaskDetails {
  id: string;
  status: string;
  cwd: string;
  killReason?: string;
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function writeConfig(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

async function waitForEnd(harness: Harness, id: string): Promise<TaskDetails> {
  await waitFor("the task to finish", async () => {
    const status = await harness.call("bg_status", { id });
    return (status.details as TaskDetails).status !== "running";
  });
  return (await harness.call("bg_status", { id })).details as TaskDetails;
}

describe("bg_run with a template", () => {
  it("runs the configured command, directory and timeout", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const work = join(dir.path, "nested", "work");
    await mkdir(work, { recursive: true });
    const command = await writeScript(
      dir.path,
      "slow.js",
      "require('node:fs').writeFileSync('cwd.txt', process.cwd());\nsetTimeout(() => {}, 60000);\n",
    );
    const paths = templateConfigPaths(dir.path, join(dir.path, "agent"));
    await writeConfig(paths.projectFile, {
      templates: { slow: { command, cwd: join("nested", "work"), timeoutSeconds: 0.3 } },
    });
    const harness = createHarness({ cwd: dir.path, sessionId: "session-template-run" });

    const started = await harness.call("bg_run", { template: "slow", name: "templated build" });
    const task = started.details as TaskDetails;
    trackPid(task);

    expect(task.status).toBe("running");
    expect(task.cwd).toBe(resolve(work));

    const done = await waitForEnd(harness, task.id);
    expect(done.killReason).toBe("timeout");
    // The command ran in the template's directory, not the session's.
    expect((await readFile(join(work, "cwd.txt"), "utf8")).trim()).toBe(await realpathOrSelf(work));
  });

  it("prefers the project file's name and keeps an agent-only name working", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const project = await writeScript(
      dir.path,
      "project.js",
      "require('node:fs').writeFileSync('which.txt', 'project');\n",
    );
    const agent = await writeScript(
      dir.path,
      "agent.js",
      "require('node:fs').writeFileSync('which.txt', 'agent');\n",
    );
    const lint = await writeScript(
      dir.path,
      "lint.js",
      "require('node:fs').writeFileSync('lint.txt', 'agent lint');\n",
    );
    const paths = templateConfigPaths(dir.path, join(dir.path, "agent"));
    await writeConfig(paths.projectFile, { templates: { test: { command: project } } });
    await writeConfig(paths.agentFile, {
      templates: { test: { command: agent }, lint: { command: lint } },
    });
    const harness = createHarness(
      { cwd: dir.path, sessionId: "session-template-precedence" },
      { agentDir: join(dir.path, "agent") },
    );

    const first = (await harness.call("bg_run", { template: "test" })).details as TaskDetails;
    trackPid(first);
    expect((await waitForEnd(harness, first.id)).status).toBe("completed");
    expect((await readFile(join(dir.path, "which.txt"), "utf8")).trim()).toBe("project");

    const second = (await harness.call("bg_run", { template: "lint" })).details as TaskDetails;
    trackPid(second);
    expect((await waitForEnd(harness, second.id)).status).toBe("completed");
    expect((await readFile(join(dir.path, "lint.txt"), "utf8")).trim()).toBe("agent lint");
  });

  it("names the configured templates in the tool description the model reads", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "noop.js", "process.exit(0);\n");
    const paths = templateConfigPaths(dir.path, join(dir.path, "agent"));
    await writeConfig(paths.projectFile, {
      templates: { test: { command }, lint: { command: `${command} --lint` } },
    });
    const harness = createHarness({ cwd: dir.path, sessionId: "session-template-described" });

    const description = harness.toolDescription("bg_run");

    expect(description).toContain("Command templates available here:");
    expect(description).toContain("lint (");
    expect(description).toContain("test (");
    expect(description.indexOf("lint (")).toBeLessThan(description.indexOf("test ("));
    expect(description).not.toContain("No command templates are configured");
  });

  it("says so when no template is configured at all", () => {
    const harness = createHarness({ cwd: process.cwd(), sessionId: "session-template-none" });

    expect(harness.toolDescription("bg_run")).toContain(
      "No command templates are configured, so `template` is rejected.",
    );
  });

  it("rejects an unknown name before a task exists and lists the known names", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "noop.js", "process.exit(0);\n");
    const paths = templateConfigPaths(dir.path, join(dir.path, "agent"));
    await writeConfig(paths.projectFile, {
      templates: { build: { command }, test: { command } },
    });
    const harness = createHarness({ cwd: dir.path, sessionId: "session-template-unknown" });

    const result = await harness.call("bg_run", { template: "nope" });

    const text = resultText(result);
    expect(text).toContain('Unknown template "nope"');
    expect(text).toContain('"build"');
    expect(text).toContain('"test"');
    expect(text).toContain("The task was not started.");
    expect(resultText(await harness.call("bg_status", {}))).toContain("No background tasks");
    await expect(
      readFile(taskRecordPath(sessionTaskDirectory(dir.path, "session-template-unknown")), "utf8"),
    ).rejects.toThrow();
  });

  it("does not let a template override an explicit command, cwd or timeout", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const templated = join(dir.path, "templated");
    const explicit = join(dir.path, "explicit");
    await mkdir(templated, { recursive: true });
    await mkdir(explicit, { recursive: true });
    const templateCommand = await writeScript(
      dir.path,
      "template.js",
      "require('node:fs').writeFileSync('template-ran.txt', 'yes');\n",
    );
    const explicitCommand = await writeScript(
      dir.path,
      "explicit.js",
      "require('node:fs').writeFileSync('explicit-ran.txt', process.cwd());\nsetTimeout(() => {}, 500);\n",
    );
    const paths = templateConfigPaths(dir.path, join(dir.path, "agent"));
    await writeConfig(paths.projectFile, {
      templates: {
        test: { command: templateCommand, cwd: "templated", timeoutSeconds: 0.1 },
      },
    });
    const harness = createHarness({ cwd: dir.path, sessionId: "session-template-explicit" });

    const started = await harness.call("bg_run", {
      template: "test",
      command: explicitCommand,
      cwd: "explicit",
      timeoutSeconds: 5,
    });
    const task = started.details as TaskDetails;
    trackPid(task);

    expect(task.cwd).toBe(resolve(explicit));
    expect((await waitForEnd(harness, task.id)).status).toBe("completed");
    expect((await readFile(join(explicit, "explicit-ran.txt"), "utf8")).trim()).toBe(
      await realpathOrSelf(explicit),
    );
    await expect(readFile(join(templated, "template-ran.txt"), "utf8")).rejects.toThrow();
  });

  it("reports a malformed file and still loads the extension and the other file", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "agent-lint.js",
      "require('node:fs').writeFileSync('agent-lint.txt', 'ran');\n",
    );
    const paths = templateConfigPaths(dir.path, join(dir.path, "agent"));
    await mkdir(join(dir.path, ".pi"), { recursive: true });
    await writeFile(paths.projectFile, '{ "templates": ', "utf8");
    await writeConfig(paths.agentFile, { templates: { lint: { command } } });

    const harness = createHarness(
      { cwd: dir.path, sessionId: "session-template-broken" },
      { agentDir: join(dir.path, "agent") },
    );

    expect(harness.toolNames).toContain("bg_run");
    expect(harness.problems).toHaveLength(1);
    expect(harness.problems[0]).toContain(paths.projectFile);
    expect(harness.problems[0]).toContain("invalid JSON");

    const started = await harness.call("bg_run", { template: "lint" });
    const task = started.details as TaskDetails;
    trackPid(task);
    expect((await waitForEnd(harness, task.id)).status).toBe("completed");
    expect((await readFile(join(dir.path, "agent-lint.txt"), "utf8")).trim()).toBe("ran");
  });
});

/** Track a child process so a failing assertion cannot leave it running. */
function trackPid(task: TaskDetails): void {
  const pid = (task as TaskDetails & { pid?: number }).pid;
  if (pid === undefined) return;
  cleanup.push(() => killTree(pid));
}

/** Compare paths after the operating system's own casing and link resolution. */
async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
