/**
 * Retention seam: a session's records and output files live in one directory, so
 * reclaiming them is one removal. These tests use a real temporary directory and
 * the real record file, and they judge the sweep by what is left on disk.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { pruneSessions } from "../src/tasks/base/retention.js";
import {
  processOutputPath,
  RUNTIME_STATE_DIRECTORY,
  sessionTaskDirectory,
} from "../src/tasks/base/runtime-state.js";
import type { LlmLoopTask, ProcessTask, Task } from "../src/tasks/base/task.js";
import { TaskStore } from "../src/tasks/base/task-store.js";
import { createHarness } from "./support/extension-harness.js";
import { makeTempDir } from "./support/processes.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** A project root whose `.pi/tasks` is empty, removed once the test finishes. */
async function projectRoot(): Promise<string> {
  const dir = await makeTempDir();
  cleanup.push(dir.dispose);
  await mkdir(join(dir.path, RUNTIME_STATE_DIRECTORY), { recursive: true });
  return dir.path;
}

function processTask(overrides: Partial<ProcessTask> = {}): ProcessTask {
  return {
    id: "bg1a2cf",
    kind: "process",
    name: "build",
    status: "completed",
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 10 * DAY,
    endedAt: NOW - 10 * DAY,
    command: "npm run build",
    cwd: "/work/project",
    outputPath: "/state/bg1a2cf.output",
    exitCode: 0,
    outputBytes: 12,
    ...overrides,
  };
}

function llmLoopTask(overrides: Partial<LlmLoopTask> = {}): LlmLoopTask {
  return {
    id: "lp1a2cf",
    kind: "llm-loop",
    name: "nightly review",
    status: "completed",
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 10 * DAY,
    endedAt: NOW - 10 * DAY,
    schedule: "10m",
    prompt: "review the diff",
    fires: 3,
    iterations: [],
    ...overrides,
  };
}

/** One stored session, aged by `ageDays`, with output bytes on disk. */
async function storedSession(
  root: string,
  sessionId: string,
  tasks: readonly Task[],
  options: { readonly ageDays: number; readonly outputBytes?: number },
): Promise<string> {
  const directory = sessionTaskDirectory(root, sessionId);
  await mkdir(directory, { recursive: true });
  await new TaskStore(directory).save(tasks);
  if (options.outputBytes !== undefined && tasks[0] !== undefined) {
    await writeFile(processOutputPath(directory, tasks[0].id), "x".repeat(options.outputBytes));
  }
  const when = new Date(NOW - options.ageDays * DAY);
  await utimes(directory, when, when);
  return directory;
}

/** Bytes of every file directly inside one session directory. */
async function sizeOf(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile()) total += (await stat(join(directory, entry.name))).size;
  }
  return total;
}

describe("retention", () => {
  it("removes a finished session older than the window, output files and all", async () => {
    const root = await projectRoot();
    const directory = await storedSession(root, "old-session", [processTask()], {
      ageDays: 8,
      outputBytes: 12,
    });
    const bytes = await sizeOf(directory);

    const report = await pruneSessions({
      scope: { cwd: root, sessionId: "current-session" },
      retentionDays: 7,
      now: () => NOW,
    });

    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(report).toEqual({ sessions: 1, bytes, failures: 0 });
  });

  it("keeps the session that is running now, whatever its age", async () => {
    const root = await projectRoot();
    const directory = await storedSession(root, "current-session", [processTask()], {
      ageDays: 30,
    });

    const report = await pruneSessions({
      scope: { cwd: root, sessionId: "current-session" },
      retentionDays: 7,
      now: () => NOW,
    });

    await expect(stat(directory)).resolves.toBeDefined();
    expect(report).toEqual({ sessions: 0, bytes: 0, failures: 0 });
  });

  it.each(["running", "paused", "interrupted"] as const)(
    "keeps a session holding a %s task",
    async (status) => {
      const root = await projectRoot();
      const directory = await storedSession(root, "busy-session", [processTask({ status })], {
        ageDays: 30,
      });

      const report = await pruneSessions({
        scope: { cwd: root, sessionId: "current-session" },
        retentionDays: 7,
        now: () => NOW,
      });

      await expect(stat(directory)).resolves.toBeDefined();
      expect(report).toEqual({ sessions: 0, bytes: 0, failures: 0 });
    },
  );

  it("keeps a session holding a loop that will still fire", async () => {
    const root = await projectRoot();
    const directory = await storedSession(
      root,
      "loop-session",
      [llmLoopTask({ status: "running", nextFireAt: NOW + 50 * 60 * 1000 })],
      { ageDays: 30 },
    );

    const report = await pruneSessions({
      scope: { cwd: root, sessionId: "current-session" },
      retentionDays: 7,
      now: () => NOW,
    });

    await expect(stat(directory)).resolves.toBeDefined();
    expect(report).toEqual({ sessions: 0, bytes: 0, failures: 0 });
  });

  it("keeps a finished session that is still inside the window", async () => {
    const root = await projectRoot();
    const directory = await storedSession(root, "yesterday", [processTask()], {
      ageDays: 6,
    });

    const report = await pruneSessions({
      scope: { cwd: root, sessionId: "current-session" },
      retentionDays: 7,
      now: () => NOW,
    });

    await expect(stat(directory)).resolves.toBeDefined();
    expect(report).toEqual({ sessions: 0, bytes: 0, failures: 0 });
  });

  it("says once how many sessions and bytes it removed", async () => {
    const root = await projectRoot();
    const first = await storedSession(root, "old-a", [processTask()], {
      ageDays: 9,
      outputBytes: 4000,
    });
    const second = await storedSession(root, "old-b", [llmLoopTask()], { ageDays: 40 });
    const bytes = (await sizeOf(first)) + (await sizeOf(second));
    const lines: string[] = [];

    const report = await pruneSessions({
      scope: { cwd: root, sessionId: "current-session" },
      retentionDays: 7,
      now: () => NOW,
      report: (line) => lines.push(line),
    });

    expect(report).toEqual({ sessions: 2, bytes, failures: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^pruned 2 sessions, [\d.]+ [KMG]?i?B$/);
  });

  it("says nothing when it removed nothing", async () => {
    const root = await projectRoot();
    await storedSession(root, "yesterday", [processTask()], { ageDays: 6 });
    const lines: string[] = [];

    await pruneSessions({
      scope: { cwd: root, sessionId: "current-session" },
      retentionDays: 7,
      now: () => NOW,
      report: (line) => lines.push(line),
    });

    expect(lines).toEqual([]);
  });

  it("keeps a session whose records cannot be read, and says which one", async () => {
    const root = await projectRoot();
    const broken = await storedSession(root, "broken", [processTask()], { ageDays: 30 });
    await writeFile(join(broken, "tasks.json"), "{ not json");
    const stale = await storedSession(root, "stale", [processTask()], { ageDays: 30 });
    const lines: string[] = [];

    const report = await pruneSessions({
      scope: { cwd: root, sessionId: "current-session" },
      retentionDays: 7,
      now: () => NOW,
      report: (line) => lines.push(line),
    });

    await expect(stat(broken)).resolves.toBeDefined();
    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    expect(report).toEqual({ sessions: 1, bytes: expect.any(Number), failures: 1 });
    expect(lines).toContain("kept broken: its records could not be read");
  });

  it("survives a removal that fails, and keeps sweeping", async () => {
    const root = await projectRoot();
    const stuck = await storedSession(root, "stuck", [processTask()], { ageDays: 30 });
    const free = await storedSession(root, "free", [processTask()], { ageDays: 30 });
    const lines: string[] = [];

    const report = await pruneSessions({
      scope: { cwd: root, sessionId: "current-session" },
      retentionDays: 7,
      now: () => NOW,
      report: (line) => lines.push(line),
      remove: async (directory) => {
        if (directory === stuck) throw new Error("EPERM: access denied");
        await rm(directory, { recursive: true, force: true });
      },
    });

    await expect(stat(stuck)).resolves.toBeDefined();
    await expect(stat(free)).rejects.toMatchObject({ code: "ENOENT" });
    expect(report.sessions).toBe(1);
    expect(report.failures).toBe(1);
    expect(lines).toContain("kept stuck: EPERM: access denied");
  });

  it("costs nothing where no session ever stored anything", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const lines: string[] = [];

    const report = await pruneSessions({
      scope: { cwd: dir.path, sessionId: "current-session" },
      retentionDays: 7,
      now: () => NOW,
      report: (line) => lines.push(line),
    });

    expect(report).toEqual({ sessions: 0, bytes: 0, failures: 0 });
    expect(lines).toEqual([]);
  });

  it("frees the ids it removed", async () => {
    const root = await projectRoot();
    const directory = await storedSession(root, "old-session", [processTask()], {
      ageDays: 30,
    });

    await pruneSessions({
      scope: { cwd: root, sessionId: "current-session" },
      retentionDays: 7,
      now: () => NOW,
    });

    const store = new TaskStore(directory);
    await expect(store.load()).resolves.toEqual([]);
    await mkdir(directory, { recursive: true });
    await store.save([processTask({ id: "bg1a2cf", status: "running" })]);
    await expect(store.load()).resolves.toEqual([expect.objectContaining({ id: "bg1a2cf" })]);
  });

  describe("at session start", () => {
    it("reclaims old sessions before the session does anything else", async () => {
      const root = await projectRoot();
      const directory = await storedSession(root, "old-session", [processTask()], {
        ageDays: 30,
      });
      const harness = createHarness(
        { cwd: root, sessionId: "current-session" },
        { env: {}, now: () => NOW },
      );

      await harness.startSession({ cwd: root, sessionId: "current-session" });

      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(harness.problems.filter((line) => line.startsWith("pruned "))).toHaveLength(1);
      expect(harness.problems.join("\n")).toContain("pruned 1 session, ");
    });

    it("fails the load instead of silently changing the window", () => {
      expect(() =>
        createHarness(
          { cwd: ".", sessionId: "session-bad-window" },
          { env: { PI_PRETTY_TASK_RETENTION_DAYS: "week" } },
        ),
      ).toThrow(/PI_PRETTY_TASK_RETENTION_DAYS.*received "week"/);
    });
  });
});
