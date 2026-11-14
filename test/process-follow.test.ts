/**
 * Extension seam: `bg_logs` with `follow` reads only what the caller has not
 * seen yet. A long task is followed by asking again, so an answer carries the
 * bytes since the previous follow call, says when the task has finished, and
 * never waits for the whole window once new output arrives.
 *
 * The cursor lives in memory for the session: the files here are real, because
 * a follow read cannot be proven against a fake file.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness, resultText } from "./support/extension-harness.js";
import { makeTempDir, waitFor, writeScript } from "./support/processes.js";

interface TaskDetails {
  id: string;
  status: string;
  outputPath: string;
}

interface FollowDetails {
  id: string;
  status: string;
  follow: boolean;
  from: number;
  offset: number;
  deltaBytes: number;
  finished: boolean;
  timedOut: boolean;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** The body of a `bg_logs` answer: everything after the blank line under the header. */
function body(text: string): string {
  return text.slice(text.indexOf("\n\n") + 2);
}

function followAnswer(result: AgentToolResult<unknown>): {
  text: string;
  details: FollowDetails;
} {
  return { text: resultText(result), details: result.details as FollowDetails };
}

/** Start a command and wait until it has ended, so its output file is settled. */
async function finishedTask(harness: Harness, command: string): Promise<TaskDetails> {
  const started = await harness.call("bg_run", { command });
  const task = started.details as TaskDetails;
  await waitFor("the task to finish", async () => {
    const status = await harness.call("bg_status", { id: task.id });
    return (status.details as TaskDetails).status !== "running";
  });
  return task;
}

describe("bg_logs following a task", () => {
  it("returns the output no follow call has shown yet, and says the task has finished", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const command = await writeScript(
      dir.path,
      "two-lines.js",
      'process.stdout.write("first\\nsecond\\n");\n',
    );
    const harness = createHarness({ cwd: dir.path, sessionId: "session-follow-first" });
    const task = await finishedTask(harness, command);

    const { text, details } = followAnswer(
      await harness.call("bg_logs", { id: task.id, follow: true }),
    );

    expect(body(text)).toBe("first\nsecond\n");
    expect(details.follow).toBe(true);
    expect(details.deltaBytes).toBe(13);
    expect(details.finished).toBe(true);
    expect(details.timedOut).toBe(false);
    expect(text).toContain("nothing more will arrive");
  });
});
