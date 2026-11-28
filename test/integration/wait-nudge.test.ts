/**
 * The nudge that closes a `bg_wait` which collects the task the session's own
 * last `pretty_task_bg_run` started (ADR-0028).
 *
 * The rule is a guideline in the system prompt, but a guideline is advice: the
 * measurable half is this sentence, which appears only for the pattern the advice
 * names and says nothing for any other wait. A nudge on every wait would be noise
 * the model learns to skip; a nudge on none is the state this decision exists to
 * leave.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { afterAll, describe, expect, it } from "vitest";

import { WAIT_AFTER_RUN_NUDGE } from "../../src/tasks/process/tools.js";
import { createHarness, type Harness, resultText } from "../support/extension-harness.js";
import { makeTempDir, writeScript } from "../support/processes.js";

const SESSION = "session-wait-nudge";

interface Started {
  readonly id: string;
}

const cleanups: Array<() => Promise<void>> = [];

async function setup(): Promise<Harness> {
  const dir = await makeTempDir();
  cleanups.push(dir.dispose.bind(dir));
  await writeScript(dir.path, "quick.mjs", ["console.log('quick');", ""].join("\n"));
  const harness = createHarness({ cwd: dir.path, sessionId: SESSION });
  await harness.startSession();
  return harness;
}

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** One background start, without waiting: the shape the rule warns about. */
async function start(harness: Harness): Promise<string> {
  const result = await harness.call("pretty_task_bg_run", { command: "node quick.mjs" });
  return (result.details as Started).id;
}

describe("pretty_task_bg_wait", () => {
  it("nudges when it collects the task the previous run started", async () => {
    const harness = await setup();
    const id = await start(harness);

    const text = resultText(await harness.call("pretty_task_bg_wait", { id }));
    expect(text).toContain(WAIT_AFTER_RUN_NUDGE);
    // Last, so it reads as a note on the answer rather than part of the status.
    expect(text.trimEnd().endsWith(WAIT_AFTER_RUN_NUDGE)).toBe(true);
  });

  it("stays silent when that run already waited inside the call", async () => {
    const harness = await setup();
    const result = await harness.call("pretty_task_bg_run", {
      command: "node quick.mjs",
      wait: true,
    });
    const id = (result.details as Started).id;

    const text = resultText(await harness.call("pretty_task_bg_wait", { id }));
    expect(text).not.toContain(WAIT_AFTER_RUN_NUDGE);
  });

  it("stays silent for a task an earlier run started", async () => {
    const harness = await setup();
    const first = await start(harness);
    const second = await start(harness);
    expect(second).not.toBe(first);

    const text = resultText(await harness.call("pretty_task_bg_wait", { id: first }));
    expect(text).not.toContain(WAIT_AFTER_RUN_NUDGE);
  });
});
