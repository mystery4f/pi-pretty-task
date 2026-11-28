/**
 * The run-choice rule as text, pinned where it is cheap to check (ADR-0028).
 *
 * Three claims are worth a test rather than a habit. The guidelines are literals,
 * because anything that changes between turns would make every request a cache
 * miss while looking like a helpful dynamic hint. The description stays under a
 * ceiling, because it is part of the tool schema and is paid on the first request
 * of every session. And the nudge is one sentence about a pattern, never about a
 * particular task, so it cannot leak an id into the next turn's prompt.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { describe, expect, it } from "vitest";

import { TaskSessions } from "../../src/tasks/base/task-sessions.js";
import { ChainTasks } from "../../src/tasks/chain/chain-tasks.js";
import { ProcessTasks } from "../../src/tasks/process/process-tasks.js";
import type { CommandTemplate } from "../../src/tasks/process/templates.js";
import {
  processTaskTools,
  RUN_CHOICE_GUIDELINES,
  WAIT_AFTER_RUN_NUDGE,
  WAIT_CHOICE_GUIDELINES,
} from "../../src/tasks/process/tools.js";

/** The description's ceiling, list of templates included. */
const DESCRIPTION_LIMIT = 900;

/** The tools as pi registers them, without a turn ever reaching a store. */
function registered(templates: ReadonlyMap<string, CommandTemplate> = new Map()) {
  const sessions = new TaskSessions();
  const processes = new ProcessTasks({ sessions });
  return processTaskTools(
    processes,
    new ChainTasks({ sessions, processes: () => processes }),
    templates,
  );
}

function description(templates?: ReadonlyMap<string, CommandTemplate>): string {
  const run = registered(templates).find((tool) => tool.name === "pretty_task_bg_run");
  if (run === undefined) throw new Error("pretty_task_bg_run is not registered");
  return run.description;
}

/** More templates than the budget holds, so the list is the worst case, not a short one. */
function manyTemplates(): ReadonlyMap<string, CommandTemplate> {
  const templates = new Map<string, CommandTemplate>();
  for (let index = 0; index < 40; index += 1) {
    templates.set(`template-${String(index)}-with-a-long-name`, {
      command: "npm run something-that-takes-a-while",
    });
  }
  return templates;
}

describe("the run-choice guidelines", () => {
  it("are literals, not text assembled per turn", () => {
    // Deep equality against the expected words is the point: a template string
    // with a clock or a counter in it would compile and be invisible at runtime.
    expect(RUN_CHOICE_GUIDELINES).toEqual([
      "If you have other work you could do while a command runs, do not wait for it: start it with no `wait`, keep the task id, finish that work, then read the result with `pretty_task_bg_logs`, `pretty_task_bg_grep` or `pretty_task_bg_wait`.",
      "Wait inside the call only when all four hold: the command ends by itself, its result is what the next step needs, it should finish within 600 seconds, and you have nothing else to do meanwhile — then pass `wait: true` and `waitSeconds` (expected seconds plus 60, at most 600).",
      "Leave `wait` off when the result is not needed yet, when the command may run past 600 seconds, or when its duration cannot be estimated; a task id is enough and the answer returns the same second.",
      "Spend no task on work that ends in a few seconds: use `bash`. A command that never ends (a dev server, a watcher) is started once in the background and read with `pretty_task_bg_logs follow`; `tail -f` is never started as a task.",
    ]);
    expect(WAIT_CHOICE_GUIDELINES).toEqual([
      "Never `pretty_task_bg_wait` the task your previous `pretty_task_bg_run` started: when its result is what you need, wait inside that run with `wait: true` and `waitSeconds`.",
    ]);
  });

  it("carry nothing that changes between turns", () => {
    const text = [...RUN_CHOICE_GUIDELINES, ...WAIT_CHOICE_GUIDELINES].join("\n");
    // A date, a task id or a count of running tasks here would miss the cache
    // on every turn of a session that keeps working (ADR-0028).
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
    expect(text).not.toMatch(/bg-[a-z0-9]{5}/u);
    expect(text).not.toMatch(/\b\d+ (?:tasks?|runs?|running)\b/u);
    // The two numbers that are allowed are the rule's own ceiling and margin.
    expect(text).toContain("600 seconds");
    expect(text).toContain("plus 60");
  });

  it("are attached to the tools whose decision they describe", () => {
    const tools = registered();
    const run = tools.find((tool) => tool.name === "pretty_task_bg_run");
    const wait = tools.find((tool) => tool.name === "pretty_task_bg_wait");
    expect(run?.promptGuidelines).toEqual([...RUN_CHOICE_GUIDELINES]);
    expect(wait?.promptGuidelines).toEqual([...WAIT_CHOICE_GUIDELINES]);
  });
});

describe("the run description", () => {
  it("carries the choice, so a reader of the schema meets it too", () => {
    expect(description()).toContain("With `wait: true` it answers when the command ends");
    expect(description()).toContain("600 seconds");
  });

  it("stays under its ceiling with no templates at all", () => {
    expect(description().length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
  });

  it("stays under its ceiling when the template list is at its budget", () => {
    expect(description(manyTemplates()).length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
  });
});

describe("the nudge", () => {
  it("is one sentence about a pattern, never about a task", () => {
    expect(WAIT_AFTER_RUN_NUDGE).not.toContain("\n");
    expect(WAIT_AFTER_RUN_NUDGE).not.toMatch(/bg-[a-z0-9]{5}/u);
    expect(WAIT_AFTER_RUN_NUDGE).toContain("waitSeconds");
  });
});
