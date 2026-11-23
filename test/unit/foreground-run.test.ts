/**
 * A foreground run is a small state machine: one outcome, claimed once. The
 * process here is a promise the test settles, because what is under test is who
 * wins the race — the natural exit, a detach, or an abort — never the spawn.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { describe, expect, it } from "vitest";
import {
  describeDetach,
  detachedNotice,
  type ForegroundOutcome,
  ForegroundRun,
} from "../../src/tasks/process/foreground.js";
import type {
  ProcessExit,
  RunningProcess,
  StopResult,
} from "../../src/tasks/process/supervisor.js";

/** A command the test ends by hand. */
function fakeProcess(): {
  running: RunningProcess;
  end(exitCode?: number | null): void;
  /** How many stops reached the command; a run that was let go must see none. */
  stops(): number;
} {
  let settle: (exit: ProcessExit) => void = () => {};
  let ended = false;
  let stops = 0;
  const exit = new Promise<ProcessExit>((resolve) => {
    settle = resolve;
  });
  return {
    running: {
      pid: 4242,
      exit,
      bytesWritten: () => 0,
      stop: () => {
        stops += 1;
        return Promise.resolve<StopResult>({ outcome: "stopped", tookMs: 0, graceMs: 0 });
      },
      signalled: () => stops > 0,
      hasExited: () => ended,
    },
    end: (exitCode = 0) => {
      ended = true;
      settle({ exitCode, signal: null });
    },
    stops: () => stops,
  };
}

function makeRun(detachAfterMs = 0): ForegroundRun {
  return new ForegroundRun({
    id: "bg-7",
    sessionId: "session-1",
    sessionCwd: "/work",
    command: "node build.js",
    workingDirectory: "/work",
    outputPath: "/work/.pi/pretty-task/output/bg-7.log",
    startedAt: 1_000,
    detachAfterMs,
  });
}

describe("foreground run", () => {
  it("ends with the exit code the shell produced", async () => {
    const run = makeRun();
    const process = fakeProcess();
    run.bind(process.running);
    expect(run.done).toBe(false);
    process.end(3);
    expect(await run.settled).toEqual({ kind: "exited", exitCode: 3 });
    expect(run.done).toBe(true);
  });

  it("keeps the first outcome and drops a later one", async () => {
    const run = makeRun();
    const process = fakeProcess();
    run.bind(process.running);
    expect(run.finish({ kind: "detached", taskId: "bg-7" })).toBe(true);
    process.end(0);
    expect(run.finish({ kind: "aborted" })).toBe(false);
    expect(await run.settled).toEqual({ kind: "detached", taskId: "bg-7" });
  });

  it("reports an abort as withdrawn rather than as the code a signal left behind", async () => {
    const run = makeRun();
    const process = fakeProcess();
    run.bind(process.running);
    run.abort();
    // Windows tooling exits 1 and a POSIX shell 143 for a tree that was killed;
    // neither is something the user typed.
    process.end(143);
    expect(await run.settled).toEqual({ kind: "aborted" });
  });

  it("reports the call's own timeout with its seconds", async () => {
    const run = makeRun();
    const process = fakeProcess();
    run.bind(process.running);
    run.expire(90);
    process.end(null);
    expect(await run.settled).toEqual({ kind: "timedOut", seconds: 90 });
  });

  it("lets exactly one detach in, and gives it back when it is refused", () => {
    const run = makeRun();
    expect(run.beginDetach()).toBe(true);
    expect(run.detachInFlight).toBe(true);
    expect(run.beginDetach()).toBe(false);
    run.abandonDetach();
    expect(run.detachInFlight).toBe(false);
    expect(run.beginDetach()).toBe(true);
  });

  it("refuses a detach once the run has ended", () => {
    const run = makeRun();
    run.finish({ kind: "exited", exitCode: 0 });
    expect(run.beginDetach()).toBe(false);
  });

  it("reports a spawn failure as the run's outcome", async () => {
    const run = makeRun();
    run.bind({
      pid: undefined,
      exit: Promise.reject(new Error("spawn EPERM")),
      bytesWritten: () => 0,
      stop: () => Promise.resolve<StopResult>({ outcome: "stopped", tookMs: 0, graceMs: 0 }),
      signalled: () => false,
      hasExited: () => false,
    });
    const outcome: ForegroundOutcome = await run.settled;
    expect(outcome).toEqual({ kind: "failed", message: "spawn EPERM" });
  });

  it("leaves the process alone when the caller withdraws after a detach", () => {
    // The key press already told the caller to follow a task; a late abort from the
    // same call must not stop the tree it handed over.
    const run = makeRun();
    const process = fakeProcess();
    run.bind(process.running);
    expect(run.finish({ kind: "detached", taskId: "bg-7" })).toBe(true);
    run.abort();
    expect(process.stops()).toBe(0);
  });

  it("ignores an expiry that arrives after the run ended", () => {
    const run = makeRun();
    const process = fakeProcess();
    run.bind(process.running);
    run.finish({ kind: "exited", exitCode: 0 });
    run.expire(30);
    expect(process.stops()).toBe(0);
  });
});

describe("detach wording", () => {
  it("names the task and both ways to follow it", () => {
    const notice = detachedNotice("bg-12");
    expect(notice).toContain("↪ moved to bg-12");
    expect(notice).toContain("pretty_task_bg_logs bg-12");
    expect(notice).toContain("pretty_task_bg_kill bg-12");
  });

  it("says one line per outcome", () => {
    expect(describeDetach({ kind: "detached", taskId: "bg-3" })).toContain("bg-3");
    expect(describeDetach({ kind: "nothing" })).toContain("Nothing is running");
    expect(describeDetach({ kind: "ambiguous", running: 2 })).toContain("2 commands");
    expect(describeDetach({ kind: "refused", message: "capacity reached" })).toContain(
      "capacity reached",
    );
    expect(describeDetach({ kind: "pending" })).toContain("already moving");
  });
});
