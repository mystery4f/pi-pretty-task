/**
 * The row projection: one record in, one row out, for every kind.
 *
 * The panel reads every record through `rowOf`, so these cases pin the two things
 * a page depends on and cannot see: the elapsed arithmetic, and which extras are
 * present. A field that reaches one kind and misses another would show up here.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */
import { describe, expect, it } from "vitest";
import type { ChainTask, CmdLoopTask, ProcessTask } from "../../src/tasks/base/task.js";
import { rowOf } from "../../src/ui/panel/model.js";

const created = Date.parse("2026-01-01T00:00:00.000Z");

const processTask: ProcessTask = {
  kind: "process",
  id: "bg-aaaaa",
  name: "build",
  command: "npm run build",
  cwd: "/tmp",
  outputPath: "/tmp/out.log",
  status: "running",
  createdAt: created,
  updatedAt: created,
  outputBytes: 0,
};

describe("rowOf", () => {
  it("measures a running record against now", () => {
    expect(rowOf(processTask, created + 4_000).elapsedMs).toBe(4_000);
  });

  it("measures a finished record against its end, not now", () => {
    const done: ProcessTask = { ...processTask, status: "completed", endedAt: created + 1_500 };
    expect(rowOf(done, created + 90_000).elapsedMs).toBe(1_500);
  });

  it("never reports a negative age when the clock steps back", () => {
    expect(rowOf(processTask, created - 5_000).elapsedMs).toBe(0);
  });

  it("defaults the byte count to zero, so a loop row has one number", () => {
    const loop: CmdLoopTask = {
      kind: "cmd-loop",
      id: "lc-aaaaa",
      name: "echo",
      command: "echo hi",
      schedule: "* * * * *",
      status: "running",
      createdAt: created,
      updatedAt: created,
      fires: 0,
      fireHistory: [],
    };
    expect(rowOf(loop, created).outputBytes).toBe(0);
  });

  it("keeps an absent countdown absent instead of spreading undefined", () => {
    const row = rowOf(processTask, created);
    expect("untilNextFireMs" in row).toBe(false);
    expect("sessionId" in row).toBe(false);
  });

  it("carries the extras it is given", () => {
    const row = rowOf(processTask, created, {
      outputBytes: 2_048,
      untilNextFireMs: 9_000,
      sessionId: "other-session",
    });
    expect(row.outputBytes).toBe(2_048);
    expect(row.untilNextFireMs).toBe(9_000);
    expect(row.sessionId).toBe("other-session");
  });

  it("builds the same shape for a chain as for a process", () => {
    const chain: ChainTask = {
      kind: "chain",
      id: "ch-aaaaa",
      name: "pipeline",
      status: "running",
      steps: ["bg-aaaaa"],
      cursor: 0,
      createdAt: created,
      updatedAt: created,
    };
    expect(Object.keys(rowOf(chain, created)).sort()).toEqual(
      Object.keys(rowOf(processTask, created)).sort(),
    );
  });
});
