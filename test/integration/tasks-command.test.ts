/**
 * Command seam: `/tasks` is the only door to the panel, and what it leaves
 * behind is the part ADR 0003 actually promises — one status line, no widget.
 * The stop test drives a real process so the panel is proven to act through the
 * store rather than by signalling a pid it happens to know.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { afterEach, describe, expect, it } from "vitest";
import { sessionTaskDirectory } from "../../src/tasks/base/runtime-state.js";
import { TaskSessions } from "../../src/tasks/base/task-sessions.js";
import { TaskStore } from "../../src/tasks/base/task-store.js";
import { LoopTasks } from "../../src/tasks/loop/loop-tasks.js";
import { TasksPanel } from "../../src/ui/panel/tasks-panel.js";
import {
  SUMMARY_KEY,
  statusLineText,
  TASKS_COMMAND,
  TASKS_SHORTCUT,
} from "../../src/ui/tasks-command.js";
import {
  createHarness,
  type Harness,
  resultText,
  type Turn,
} from "../support/extension-harness.js";
import { isAlive, killTree, makeTempDir, waitFor, writeScript } from "../support/processes.js";

const cleanup: Array<() => Promise<void>> = [];
const spawned: Array<number | undefined> = [];

const DOWN = "\u001b[B";
const LEFT = "\u001b[D";
afterEach(async () => {
  while (spawned.length > 0) await killTree(spawned.pop());
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** The one task `pretty_task_bg_run` reported, as the tool's details carry it. */
interface StartedTask {
  id: string;
  pid?: number;
  status: string;
}

/** The one loop `pretty_task_loop_create` reported, as its details carry it. */
interface LoopStarted {
  id: string;
  status: string;
  fires: number;
}
/** Open the panel the way `/tasks` does and hand back the live component. */
async function openPanel(
  harness: Harness,
  turn?: Turn,
): Promise<{ panel: TasksPanel; closed: Promise<void> }> {
  const closed = harness.runCommand(TASKS_COMMAND, undefined, turn);
  const component = harness.lastCustom();
  if (!(component instanceof TasksPanel)) throw new Error("the tasks command opened no panel");
  await component.settle();
  return { panel: component, closed };
}

/** Move the fake clock, fire the loop, and run one shell call in the turn it woke. */
async function fireLoop(harness: Harness, clock: { now: number }, fire: number): Promise<void> {
  clock.now += 10_000;
  await harness.pump(clock.now);
  const toolCallId = `call-${String(fire)}`;
  await harness.emit({
    type: "tool_execution_start",
    toolCallId,
    toolName: "bash",
    args: { command: `echo fire ${String(fire)}` },
  });
  await harness.emit({
    type: "tool_execution_end",
    toolCallId,
    toolName: "bash",
    result: { ok: true },
    isError: false,
    durationMs: 5,
  });
  await harness.emit({ type: "agent_settled", aborted: false });
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
        updatedAt: 1,
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
        updatedAt: 2,
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
        updatedAt: 3,
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

  it("has nothing to say when the session has no tasks at all", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-empty" });

    await harness.startSession();

    // No count to show means no line: the widget slot is cleared, not zeroed.
    expect(harness.widgets.at(-1)).toEqual({ key: SUMMARY_KEY, lines: [] });
    expect(harness.statuses).toEqual([]);
  });

  it("names the shortcut, which is registered and opens the same panel", async () => {
    expect(statusLineText([])).toContain("Shift↓");
    expect(statusLineText([])).toBe(" · /tasks or Shift↓");

    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-shortcut" });
    expect(harness.shortcutKeys).toContain(TASKS_SHORTCUT);

    const opened = harness.runShortcut(TASKS_SHORTCUT);
    const panel = harness.lastCustom();
    if (!(panel instanceof TasksPanel)) throw new Error("the shortcut opened no panel");
    await panel.settle();
    panel.handleInput("\u001bq");
    await opened;

    expect(harness.widgets.at(-1)?.key).toBe(SUMMARY_KEY);
  });

  it("appears even when the extension is loaded mid-session", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-reload" });

    // `/reload` never emits session_start, so the first turn is the way in.
    await harness.emit({ type: "agent_start" });

    // With no task yet there is no line, but the slot is now known to the extension.
    expect(harness.widgetKeys).toContain(SUMMARY_KEY);
  });

  it("is published at session start, before /tasks was ever opened", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-line" });

    await harness.startSession();

    expect(harness.widgetKeys).toContain(SUMMARY_KEY);
    expect(harness.statuses).toEqual([]);
  });
});

describe("/tasks command", () => {
  it("is registered and opens an overlay, not a widget", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-command" });

    expect(harness.commandNames).toContain(TASKS_COMMAND);

    const { panel, closed } = await openPanel(harness);
    expect(panel.render(100).join("\n")).toContain("No processes here");
    expect(harness.lastCustomOptions()?.overlay).toBe(true);

    panel.handleInput("\u001bq");
    await closed;

    // ADR 0003: the overlay is gone, and what remains is one line of text.
    expect(harness.widgetKeys).toEqual([SUMMARY_KEY]);
  });

  it("leaves exactly one summary line when the panel closes", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const harness = createHarness({ cwd: dir.path, sessionId: "session-status" });

    const { panel, closed } = await openPanel(harness);
    expect(harness.widgetKeys).toEqual([]);

    panel.handleInput("\u001bq");
    await closed;

    // One slot, cleared: an idle session keeps no line above the editor.
    expect(harness.widgetKeys).toEqual([SUMMARY_KEY]);
    expect(harness.widgets[0]?.lines).toEqual([]);
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

    const started = (await harness.call("pretty_task_bg_run", { name: "sleepy job", command }))
      .details as StartedTask;
    const pid = started.pid;
    if (pid === undefined) throw new Error("pretty_task_bg_run reported no pid");
    spawned.push(pid);
    await waitFor("the task to print its line", async () => {
      const logs = await harness.call("pretty_task_bg_logs", { id: started.id, lines: 5 });
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
    const after = (await harness.call("pretty_task_bg_status", { id: started.id }))
      .details as StartedTask;
    expect(after.status).toBe("killed");

    panel.handleInput("\u001bq");
    await closed;

    expect(harness.widgets.at(-1)?.lines.join(" | ")).toContain("1 finished");
  });

  it("shows a loop's iterations newest first, each with the commands its turn ran", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const clock = { now: Date.UTC(2026, 0, 1, 9, 5, 0) };
    const harness = createHarness(
      { cwd: dir.path, sessionId: "session-loop" },
      { now: () => clock.now },
    );
    const created = (
      await harness.call("pretty_task_loop_create", {
        name: "review loop",
        schedule: "10s",
        prompt: "review the diff",
      })
    ).details as LoopStarted;

    // A 10s loop run five times: five iterations, one command each.
    for (let fire = 1; fire <= 5; fire += 1) await fireLoop(harness, clock, fire);
    const { panel, closed } = await openPanel(harness);
    // A loop gets its own page (ADR-0012); the panel opens on Processes.
    panel.handleInput("2");
    const list = panel.render(100).join("\n");
    expect(list).toContain("review loop");
    expect(list).toContain(created.id);
    // The row shows the countdown; the detail carries the wall-clock times.
    expect(list).toContain("10.0s");

    panel.handleInput("\r");
    await panel.settle();
    const loop = panel.render(100).join("\n");
    expect(loop).toContain("10s");
    expect(loop).toContain("review the diff");
    expect(loop).toContain("newest first · 5 kept");

    panel.handleInput("\r");
    await panel.settle();
    const newest = panel.render(100).join("\n");
    expect(newest).toContain("fire 5");
    expect(newest).toContain("echo fire 5");

    // Back to the loop, one row older, and the command that turn ran.
    panel.handleInput(LEFT);
    panel.handleInput(DOWN);
    panel.handleInput("\r");
    await panel.settle();
    const older = panel.render(100).join("\n");
    expect(older).toContain("fire 4");
    expect(older).toContain("echo fire 4");
    expect(older).not.toContain("echo fire 5");

    panel.handleInput("\u001bq");
    await closed;

    // The line was repainted as the turn ran; what matters is where it lands.
    const last = harness.widgets.at(-1);
    expect(last?.lines.join(" | ")).toContain("1 running");
    expect(last?.lines.join(" | ")).toContain("Shift↓");
  });

  it("stops a loop with k on its row, and the schedule never fires again", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const clock = { now: Date.UTC(2026, 0, 2, 8, 0, 0) };
    const harness = createHarness(
      { cwd: dir.path, sessionId: "session-loop-stop" },
      { now: () => clock.now },
    );
    const created = (
      await harness.call("pretty_task_loop_create", {
        name: "stop me",
        schedule: "10s",
        prompt: "keep going",
      })
    ).details as LoopStarted;
    await fireLoop(harness, clock, 1);

    const { panel, closed } = await openPanel(harness);
    panel.handleInput("2");
    expect(panel.render(100).join("\n")).toContain("stop me");

    // One key for both kinds: on a loop row `k` ends the schedule, not a process.
    panel.handleInput("k");
    await panel.settle();
    const stopped = (await harness.call("pretty_task_loop_list", { id: created.id }))
      .details as LoopStarted;
    expect(stopped.status).toBe("completed");
    expect(stopped.fires).toBe(1);

    await fireLoop(harness, clock, 2);
    const after = (await harness.call("pretty_task_loop_list", { id: created.id }))
      .details as LoopStarted;
    expect(after.fires).toBe(1);

    panel.handleInput("\u001bq");
    await closed;
    expect(harness.widgets.at(-1)?.lines.join(" | ")).toContain("1 finished");
  });

  it("shows another session's task read-only, tagged and never stopped by k", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    // One checkout, two sessions: the second keeps its own store under the same root.
    const harness = createHarness({ cwd: dir.path, sessionId: "session-mine" });
    const theirs: Turn = { cwd: dir.path, sessionId: "7f2c9d10-4b3a-4e55-9a01-6c7d8e9f0a1b" };
    const command = await writeScript(
      dir.path,
      "edge.js",
      "console.log('edge ok');\nsetTimeout(() => {}, 60000);\n",
    );
    const started = (
      await harness.call("pretty_task_bg_run", { name: "edge deploy", command }, theirs)
    ).details as StartedTask;
    const pid = started.pid;
    if (pid === undefined) throw new Error("pretty_task_bg_run reported no pid");
    spawned.push(pid);
    await waitFor("the other session's task to print its line", async () => {
      const logs = await harness.call("pretty_task_bg_logs", { id: started.id, lines: 5 }, theirs);
      return resultText(logs).includes("edge ok");
    });

    const { panel, closed } = await openPanel(harness);
    // A reopened panel lands on the last page used, so this test names its own.
    panel.handleInput("1");
    // This session's own page is empty: the row is another session's to own.
    expect(panel.render(100).join("\n")).toContain("No processes here");

    panel.handleInput("o");
    await panel.settle();
    const list = panel.render(100).join("\n");
    expect(list).toContain("edge deploy");
    expect(list).toContain("@7f2c9d");

    // The detail names the whole session and reads that session's output file.
    panel.handleInput("\r");
    await panel.settle();
    const detail = panel.render(100).join("\n");
    expect(detail).toContain(theirs.sessionId);
    expect(detail).toContain("edge ok");

    // `k` on another session's task says why and leaves the process running.
    panel.handleInput("k");
    await panel.settle();
    expect(panel.render(100).join("\n")).toContain("another session's task is read-only here");
    expect(isAlive(pid)).toBe(true);

    panel.handleInput("\u001bq");
    await closed;
    // This session owns no task, and the other session's running one is not its
    // count: the line above the editor stays empty rather than borrowing a run.
    expect(harness.widgets.at(-1)?.lines).toEqual([]);
  });

  /**
   * The other session's schedules are its own: this extension may look at them, but
   * the pump drives only the scopes this session attached to. A view is a view.
   */
  describe("another session's loops", () => {
    /** One checkout, two sessions: the other one's records are already on disk. */
    async function setup() {
      const dir = await makeTempDir();
      cleanup.push(dir.dispose);
      const clock = { now: Date.UTC(2026, 0, 3, 9, 0, 0) };
      const mine: Turn = { cwd: dir.path, sessionId: "session-mine" };
      const theirs: Turn = { cwd: dir.path, sessionId: "session-theirs" };
      const harness = createHarness(mine, { now: () => clock.now });
      // Written by that session's own store, as a second pi process would: nothing
      // this session does later can be confused with the records having been made here.
      const foreign = new LoopTasks({
        sessions: new TaskSessions({ now: () => clock.now }),
        now: () => clock.now,
      });
      const wake = await foreign.create({
        ...theirs,
        name: "their wake",
        schedule: "10s",
        prompt: "their prompt",
      });
      const command = await foreign.create({
        ...theirs,
        name: "their fire",
        schedule: "10s",
        command: "echo their fire",
      });
      return { dir, clock, harness, theirs, wake, command };
    }

    /** The other session's records as its own next reader would load them. */
    async function theirsOnDisk(dir: string, theirs: Turn) {
      return new TaskStore(sessionTaskDirectory(dir, theirs.sessionId)).load();
    }

    it("shows them, fires none of them, and writes nothing of theirs", async () => {
      const { dir, clock, harness, theirs } = await setup();
      await harness.startSession();

      const { panel, closed } = await openPanel(harness);
      panel.handleInput("2");
      panel.handleInput("o");
      await panel.settle();
      const shown = panel.render(100).join("\n");
      expect(shown).toContain("their wake");
      expect(shown).toContain("their fire");

      // Both foreign loops are due now: showing them must not arm a pump for them.
      clock.now += 10_000;
      expect(await harness.pump(clock.now)).toEqual([]);
      // No wake entered this session, and no command started in that session's cwd.
      expect(harness.messages).toEqual([]);

      const [wake, command] = await theirsOnDisk(dir.path, theirs);
      expect(wake).toMatchObject({ kind: "prompt-loop", status: "running", fires: 0 });
      expect(command).toMatchObject({ kind: "cmd-loop", status: "running", fires: 0 });
      expect(await theirsOnDisk(dir.path, theirs)).toHaveLength(2);

      panel.handleInput("\u001bq");
      await closed;
    });

    it("still fires this session's own loop after theirs was shown", async () => {
      const { dir, clock, harness, theirs } = await setup();
      await harness.startSession();
      const mine = (
        await harness.call("pretty_task_loop_create", {
          name: "my wake",
          schedule: "10s",
          prompt: "keep going",
        })
      ).details as LoopStarted;

      const { panel, closed } = await openPanel(harness);
      panel.handleInput("2");
      panel.handleInput("o");
      await panel.settle();
      expect(panel.render(100).join("\n")).toContain("their wake");

      clock.now += 10_000;
      const fired = await harness.pump(clock.now);
      expect(fired.map((fire) => fire.task.id)).toEqual([mine.id]);
      expect(harness.messages).toHaveLength(1);

      // The foreign schedule is still untouched by this session's turn.
      const [wake, command] = await theirsOnDisk(dir.path, theirs);
      expect(wake).toMatchObject({ fires: 0 });
      expect(command).toMatchObject({ fires: 0 });

      panel.handleInput("\u001bq");
      await closed;
    });
  });
});
