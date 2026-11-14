/**
 * The terminal notification: one OSC 9 escape per finished task, written to the
 * terminal's stdout. Asserted by capturing bytes, since running a terminal is not
 * what a test can do (issue #15).
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalNotifications,
  MAX_NOTIFICATION_BYTES,
  OSC9_START,
  STRING_TERMINATOR,
  terminalNotification,
} from "../src/ui/terminal-notification.js";
import { createHarness, resultText } from "./support/extension-harness.js";
import { killTree, makeTempDir, waitFor, writeScript } from "./support/processes.js";

describe("the notification escape", () => {
  it("carries the task name and its ending in one escape", () => {
    expect(terminalNotification("nightly build", "failed")).toBe(
      "\u001b]9;nightly build failed\u0007",
    );
  });

  it("keeps the escape intact when the name holds control bytes", () => {
    const written = terminalNotification("evil\u0007name\u001b]0;title\there", "completed");
    // ESC would start a second escape and BEL would end this one early: both go,
    // and each leaves a space so the words around it stay apart.
    expect(written.split(STRING_TERMINATOR)).toHaveLength(2);
    expect(written.slice(OSC9_START.length)).not.toContain("\u001b");
    expect(written).toBe("\u001b]9;evil name ]0;title here completed\u0007");
  });

  it("collapses whitespace into single spaces", () => {
    expect(terminalNotification("  multi\n\nline\t name  ", "killed")).toBe(
      "\u001b]9;multi line name killed\u0007",
    );
  });

  it("keeps a name written in Chinese, which is what a task name usually is", () => {
    expect(terminalNotification("构建文档", "completed")).toContain("构建文档");
  });

  it("falls back to a word when the name has nothing left to show", () => {
    expect(terminalNotification("\u0007\u0000", "failed")).toBe("\u001b]9;task failed\u0007");
  });

  it("caps the whole escape, name included", () => {
    const written = terminalNotification("x".repeat(500), "completed");
    expect(Buffer.byteLength(written, "utf8")).toBeLessThanOrEqual(MAX_NOTIFICATION_BYTES);
    expect(written.endsWith(`completed${STRING_TERMINATOR}`)).toBe(true);
  });
});

describe("when a notification is written", () => {
  it("writes one escape for a task that ended", () => {
    const written: string[] = [];
    const terminal = createTerminalNotifications({
      enabled: true,
      attached: () => true,
      write: (text) => written.push(text),
    });
    terminal.finished("nightly build", "completed");
    expect(written).toEqual(["\u001b]9;nightly build completed\u0007"]);
  });

  it("writes nothing while the task is still running", () => {
    const written: string[] = [];
    const terminal = createTerminalNotifications({
      enabled: true,
      attached: () => true,
      write: (text) => written.push(text),
    });
    terminal.finished("nightly build", "running");
    terminal.finished("nightly build", "paused");
    expect(written).toEqual([]);
  });

  it("writes nothing when notifications are turned off", () => {
    const written: string[] = [];
    const terminal = createTerminalNotifications({
      enabled: false,
      attached: () => true,
      write: (text) => written.push(text),
    });
    terminal.finished("nightly build", "completed");
    expect(written).toEqual([]);
  });

  it("writes nothing when no terminal UI is attached", () => {
    const written: string[] = [];
    const terminal = createTerminalNotifications({
      enabled: true,
      attached: () => false,
      write: (text) => written.push(text),
    });
    terminal.finished("nightly build", "completed");
    expect(written).toEqual([]);
  });

  it("sends nothing down a stdout that is not a terminal", () => {
    const stream = process.stdout as { isTTY?: boolean };
    const previous = stream.isTTY;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stream.isTTY = false;
    try {
      const terminal = createTerminalNotifications({ enabled: true, attached: () => true });
      terminal.finished("piped", "completed");
      // A TUI whose stdout is a pipe would otherwise put escape bytes in the pipe.
      expect(write).not.toHaveBeenCalled();
      stream.isTTY = true;
      terminal.finished("ttied", "completed");
      expect(write).toHaveBeenCalledWith("\u001b]9;ttied completed\u0007");
    } finally {
      write.mockRestore();
      stream.isTTY = previous;
    }
  });
});

describe("the extension's notification", () => {
  let directories: { path: string; dispose(): Promise<void> }[] = [];
  let pids: number[] = [];

  beforeEach(() => {
    directories = [];
    pids = [];
  });

  afterEach(async () => {
    for (const pid of pids) await killTree(pid);
    for (const directory of directories) await directory.dispose();
  });

  it("writes exactly one escape when a background task ends", async () => {
    const dir = await makeTempDir();
    directories.push(dir);
    const script = await writeScript(dir.path, "quick.js", "process.exit(0);\n");
    const written: string[] = [];
    const harness = createHarness(
      { cwd: dir.path, sessionId: "session-notify" },
      { notificationWrite: (text) => written.push(text) },
    );
    harness.startSession({ cwd: dir.path, sessionId: "session-notify" });

    const result = await harness.call("bg_run", {
      command: script,
      name: "quick one",
    });
    pids.push((result.details as { pid?: number }).pid ?? 0);
    await waitFor("the task to end", () => written.length > 0);
    expect(resultText(result)).toContain("Started background task");
    expect(written).toEqual(["\u001b]9;quick one completed\u0007"]);
    // The notice still goes into the session: the terminal escape is an extra.
    await waitFor("the completion notice", () => harness.messages.length > 0);
  });

  it("stays silent in a headless run, where no terminal is attached", async () => {
    const dir = await makeTempDir();
    directories.push(dir);
    const script = await writeScript(dir.path, "quick.js", "process.exit(2);\n");
    const written: string[] = [];
    const harness = createHarness(
      { cwd: dir.path, sessionId: "session-headless" },
      { notificationWrite: (text) => written.push(text) },
    );

    const result = await harness.call("bg_run", {
      command: script,
      name: "quiet one",
    });
    expect(resultText(result)).toContain("Started background task");
    // No `startSession`: a tool call is what a headless or print-mode run sees, and
    // its context carries no UI, so the escape must never reach the bytes.
    await waitFor("the completion notice", () => harness.messages.length > 0);
    expect(written).toEqual([]);
  });

  it("stays silent when PI_PRETTY_TASK_NOTIFY is off", async () => {
    const dir = await makeTempDir();
    directories.push(dir);
    const script = await writeScript(dir.path, "quick.js", "process.exit(0);\n");
    const written: string[] = [];
    const harness = createHarness(
      { cwd: dir.path, sessionId: "session-notify-off" },
      { env: { PI_PRETTY_TASK_NOTIFY: "off" }, notificationWrite: (text) => written.push(text) },
    );
    harness.startSession({ cwd: dir.path, sessionId: "session-notify-off" });

    await harness.call("bg_run", {
      command: script,
      name: "silent one",
    });
    await waitFor("the completion notice", () => harness.messages.length > 0);
    expect(written).toEqual([]);
  });

  it("does not write for a task that is still running", async () => {
    const dir = await makeTempDir();
    directories.push(dir);
    const script = await writeScript(dir.path, "slow.js", "setInterval(() => {}, 1000);\n");
    const written: string[] = [];
    const harness = createHarness(
      { cwd: dir.path, sessionId: "session-notify-running" },
      { notificationWrite: (text) => written.push(text) },
    );
    harness.startSession({ cwd: dir.path, sessionId: "session-notify-running" });

    const result = await harness.call("bg_run", {
      command: script,
      name: "slow one",
    });
    const id = (result.details as { id: string }).id;
    pids.push((result.details as { pid?: number }).pid ?? 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(written).toEqual([]);

    await harness.call("bg_kill", { id });
    await waitFor("the escape for the stopped task", () => written.length > 0);
    expect(written).toEqual([`\u001b]9;slow one killed\u0007`]);
  });

  it("keeps the session notice as well, so nothing depends on the escape", async () => {
    const dir = await makeTempDir();
    directories.push(dir);
    const script = await writeScript(dir.path, "quiet.js", "process.exit(0);\n");
    const harness = createHarness(
      { cwd: dir.path, sessionId: "session-notify-notice" },
      { notificationWrite: () => {} },
    );
    harness.startSession({ cwd: dir.path, sessionId: "session-notify-notice" });

    const result = await harness.call("bg_run", {
      command: script,
      name: "both ways",
    });
    pids.push((result.details as { pid?: number }).pid ?? 0);
    await waitFor("the completion notice", () => harness.messages.length > 0);
    const notice = harness.messages[harness.messages.length - 1];
    expect(notice?.customType).toBe("task-finished");
    expect(notice?.details).toMatchObject({ name: "both ways", status: "completed" });
  });
});
