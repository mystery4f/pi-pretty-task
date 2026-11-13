/**
 * Extension seam: a task that ends announces itself in the session. Every test
 * here starts a real process task through `bg_run`, lets it end, and asserts
 * what the user sees in the transcript — the message the extension sent and
 * the text its renderer draws.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  type FinishedTaskDetails,
  finishedTaskMessage,
  TASK_FINISHED_CUSTOM_TYPE,
} from "../src/ui/notification.js";
import { createHarness, type Harness, type SentMessage } from "./support/extension-harness.js";
import { killTree, makeTempDir, waitFor, writeScript } from "./support/processes.js";

interface TaskDetails {
  id: string;
  status: string;
  pid?: number;
}

const cleanup: Array<() => Promise<void>> = [];
const spawned: number[] = [];

afterEach(async () => {
  while (spawned.length > 0) await killTree(spawned.pop());
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** Start a task, wait until it has ended, and return what `bg_run` reported. */
async function runToEnd(harness: Harness, command: string, name: string): Promise<TaskDetails> {
  const result = await harness.call("bg_run", { name, command });
  const details = result.details as TaskDetails;
  if (details.pid !== undefined) spawned.push(details.pid);
  await waitFor("the task to end", async () => {
    const status = await harness.call("bg_status", { id: details.id });
    return (status.details as TaskDetails).status !== "running";
  });
  return details;
}

/** The one notice the extension sent, once it arrives. */
async function waitForNotice(harness: Harness): Promise<SentMessage> {
  await waitFor("the completion notice", () => harness.messages.length > 0);
  const [first] = harness.messages;
  if (first === undefined) throw new Error("no completion notice was sent");
  return first;
}

describe("finished-task notice", () => {
  it("sends one follow-up session message per finished task", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "greeting.js", "console.log('all done');\n");
    const harness = createHarness({ cwd: dir.path, sessionId: "session-notice" });

    await runToEnd(harness, command, "greeting");

    const notice = await waitForNotice(harness);
    expect(notice.customType).toBe("task-finished");
    expect(notice.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(notice.display).toBe(true);

    // Exactly one: a task that ends must not report itself twice.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(harness.messages).toHaveLength(1);
  });

  it("carries name, id, kind, status, duration, exit code and the trailing output", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    // Twenty lines in, so a bounded tail is distinguishable from all output.
    const steps = Array.from({ length: 20 }, (_, index) => {
      const step = String(index + 1).padStart(2, "0");
      return `console.log('step-${step}');`;
    });
    const command = await writeScript(
      dir.path,
      "failing-build.js",
      `${steps.join("\n")}\nconsole.log('warning: two files changed');\nprocess.exitCode = 3;\n`,
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-notice-content" });

    const started = await runToEnd(harness, command, "nightly build");
    const notice = await waitForNotice(harness);
    const details = notice.details as FinishedTaskDetails;

    expect(details.name).toBe("nightly build");
    expect(details.id).toBe(started.id);
    expect(details.kind).toBe("process");
    expect(details.status).toBe("failed");
    expect(details.durationMs).toBeGreaterThan(0);
    expect(details.exitCode).toBe(3);
    expect(details.outputTail).toContain("step-20");
    expect(details.outputTail).toContain("warning: two files changed");
    expect(details.outputTail).not.toContain("step-01");
    expect(details.outputTruncated).toBe(true);

    expect(notice.content).toContain("nightly build");
    expect(notice.content).toContain(started.id);
    expect(notice.content).toContain("process");
    expect(notice.content).toContain("failed");
    expect(notice.content).toContain("exit code: 3");
    expect(notice.content).toContain("warning: two files changed");
  });

  it("draws the notice with its own renderer, in theme colours", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(dir.path, "docs.js", "console.log('docs written');\n");
    const harness = createHarness({ cwd: dir.path, sessionId: "session-notice-render" });

    const started = await runToEnd(harness, command, "build docs");
    const notice = await waitForNotice(harness);
    const drawn = harness.render(notice.customType, notice.details);

    expect(drawn).toContain("build docs");
    expect(drawn).toContain(started.id);
    expect(drawn).toContain("completed");
    expect(drawn).toContain("exit code: 0");
    expect(drawn).toContain("docs written");
    // Colours come from the theme, so every colour is a token, not an escape code.
    expect(drawn).toContain("<success>");
    // The renderer draws facts; the details object itself never leaks through.
    expect(drawn).not.toContain('"id"');
    expect(drawn).not.toContain("{");
  });
});

describe("killed task notice", () => {
  // A kill has no exit code and its reason is a stored fact, not a status name.
  // Ticket #3 makes `bg_kill` reachable; until then the notice is driven here.
  it("keeps the same shape and carries the kill reason", () => {
    const harness = createHarness({ cwd: process.cwd(), sessionId: "session-notice-killed" });
    const notice = finishedTaskMessage({
      id: "k1x9zq",
      name: "dev server",
      kind: "process",
      status: "killed",
      durationMs: 65_000,
      exitCode: null,
      reason: "the user killed it",
      outputTail: "listening on :3000\n",
    });

    expect(notice.details.status).toBe("killed");
    expect(notice.content).toContain("dev server");
    expect(notice.content).toContain("k1x9zq");
    expect(notice.content).toContain("killed");
    expect(notice.content).toContain("the user killed it");
    expect(notice.content).not.toContain("exit code");

    const drawn = harness.render(TASK_FINISHED_CUSTOM_TYPE, notice.details);
    expect(drawn).toContain("dev server");
    expect(drawn).toContain("k1x9zq");
    expect(drawn).toContain("the user killed it");
    expect(drawn).toContain("listening on :3000");
    expect(drawn).toContain("<warning>");
  });
});
