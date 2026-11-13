/**
 * Command seam: `/tasks` is the only door to the panel, and what it leaves
 * behind is the part ADR 0003 actually promises — one status line, no widget.
 * The stop test drives a real process so the panel is proven to act through the
 * store rather than by signalling a pid it happens to know.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { afterEach, describe, expect, it } from "vitest";
import { STATUS_LINE_KEY, statusLineText, TASKS_COMMAND } from "../src/ui/tasks-command.js";
import { TasksPanel } from "../src/ui/tasks-panel.js";
import { createHarness, type Harness, resultText } from "./support/extension-harness.js";
import { isAlive, killTree, makeTempDir, waitFor, writeScript } from "./support/processes.js";

const cleanup: Array<() => Promise<void>> = [];
const spawned: Array<number | undefined> = [];

afterEach(async () => {
  while (spawned.length > 0) await killTree(spawned.pop());
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** The one task `bg_run` reported, as the tool's details carry it. */
interface StartedTask {
  id: string;
  pid?: number;
  status: string;
}

/** Open the panel the way `/tasks` does and hand back the live component. */
async function openPanel(harness: Harness): Promise<{ panel: TasksPanel; closed: Promise<void> }> {
  const closed = harness.runCommand(TASKS_COMMAND);
  const component = harness.lastCustom();
  if (!(component instanceof TasksPanel)) throw new Error("the tasks command opened no panel");
  await component.settle();
  return { panel: component, closed };
}

describe("status line", () => {
  it("counts running and ended tasks and always names the way back", () => {
    const running = statusLineText([
      {
        id: "a",
        kind: "process",
        name: "a",
        status: "running",
        createdAt: 1,
        command: "",
        cwd: "",
        outputPath: "",
        outputBytes: 0,
      },
      {
        id: "b",
        kind: "process",
        name: "b",
        status: "running",
        createdAt: 2,
        command: "",
        cwd: "",
        outputPath: "",
        outputBytes: 0,
      },
      {
        id: "c",
        kind: "process",
        name: "c",
        status: "failed",
        createdAt: 3,
        command: "",
        cwd: "",
        outputPath: "",
        outputBytes: 0,
      },
    ]);

    expect(running).toContain("2 running");
    expect(running).toContain("1 finished");
    expect(running).toContain("/tasks");
  });

  it("says so when the session has no tasks at all", () => {
    expect(statusLineText([])).toContain("no tasks");
    expect(statusLineText([])).toContain("/tasks");
  });
});

describe("/tasks command", () => {
  it("is registered and opens an overlay, not a widget", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-command" });

    expect(harness.commandNames).toContain(TASKS_COMMAND);

    const { panel, closed } = await openPanel(harness);
    expect(panel.render(100).join("\n")).toContain("No tasks yet");
    expect(harness.lastCustomOptions()?.overlay).toBe(true);

    panel.handleInput("x");
    await closed;

    // ADR 0003: the overlay is gone, and what remains is one line of text.
    expect(harness.widgetKeys).toEqual([]);
  });

  it("leaves exactly one status-line summary when the panel closes", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-status" });

    const { panel, closed } = await openPanel(harness);
    expect(harness.statuses).toHaveLength(0);

    panel.handleInput("x");
    await closed;

    expect(harness.statuses).toHaveLength(1);
    expect(harness.statuses[0]?.key).toBe(STATUS_LINE_KEY);
    expect(harness.statuses[0]?.text).toContain("no tasks");
    expect(harness.statuses[0]?.text).toContain("/tasks");
    expect(harness.widgetKeys).toEqual([]);
  });

  it("lists a running process, shows its output, and stops it through the store", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "sleepy.js",
      "console.log('waiting for work');\nsetTimeout(() => {}, 60000);\n",
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-stop" });

    const started = (await harness.call("bg_run", { name: "sleepy job", command }))
      .details as StartedTask;
    const pid = started.pid;
    if (pid === undefined) throw new Error("bg_run reported no pid");
    spawned.push(pid);
    await waitFor("the task to print its line", async () => {
      const logs = await harness.call("bg_logs", { id: started.id, lines: 5 });
      return resultText(logs).includes("waiting for work");
    });

    const { panel, closed } = await openPanel(harness);
    const list = panel.render(100).join("\n");
    expect(list).toContain("sleepy job");
    expect(list).toContain("running");

    panel.handleInput("\r");
    await panel.settle();
    const detail = panel.render(100).join("\n");
    expect(detail).toContain("waiting for work");
    expect(detail).toContain(command);

    // `k` in the detail view: the store kills the tree, the panel just asks.
    panel.handleInput("k");
    await panel.settle();
    await waitFor("the process to die", () => !isAlive(pid));
    const after = (await harness.call("bg_status", { id: started.id })).details as StartedTask;
    expect(after.status).toBe("killed");

    panel.handleInput("x");
    await closed;

    expect(harness.statuses).toHaveLength(1);
    expect(harness.statuses[0]?.text).toContain("1 finished");
    expect(harness.widgetKeys).toEqual([]);
  });
});
