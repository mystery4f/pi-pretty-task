/**
 * Id seam: the first characters of an id say which kind of task it names, so a
 * `bg-1a2cf` quoted in a later message is readable without the panel in front of
 * you (ADR-0011). Records written before the prefix keep their six characters.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { mkdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { sessionTaskDirectory } from "../src/tasks/base/runtime-state.js";
import type { LlmLoopTask } from "../src/tasks/base/task.js";
import { TaskSessions } from "../src/tasks/base/task-sessions.js";
import { TaskStore } from "../src/tasks/base/task-store.js";
import { makeTempDir } from "./support/processes.js";

const cleanup: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => directory.dispose()));
});

describe("task ids", () => {
  it("gives every kind its own prefix and five random characters after it", async () => {
    const directory = await makeTempDir();
    cleanup.push(directory);
    const sessions = new TaskSessions();
    const session = await sessions.session({ cwd: directory.path, sessionId: "session-ids" });

    const processId = sessions.createId(session, "process");
    const llmLoopId = sessions.createId(session, "llm-loop");
    const cmdLoopId = sessions.createId(session, "cmd-loop");

    expect(processId).toMatch(/^bg-[a-z0-9]{5}$/);
    expect(llmLoopId).toMatch(/^lp-[a-z0-9]{5}$/);
    expect(cmdLoopId).toMatch(/^lc-[a-z0-9]{5}$/);
    // Three characters of prefix plus five of randomness: the example `bg-1a2cf`
    // is eight cells.
    expect(processId).toHaveLength(8);
    expect(llmLoopId).toHaveLength(8);
    expect(cmdLoopId).toHaveLength(8);
    // One namespace per session: the collision check spans the whole id, so the
    // three prefixes never compete for it, and none of the ids is already taken.
    expect(new Set([processId, llmLoopId, cmdLoopId]).size).toBe(3);
    expect(session.tasks.has(processId)).toBe(false);
    expect(session.tasks.has(llmLoopId)).toBe(false);
    expect(session.tasks.has(cmdLoopId)).toBe(false);
  });

  it("treats an id restored from disk as taken instead of reissuing it", async () => {
    const directory = await makeTempDir();
    cleanup.push(directory);
    const scope = { cwd: directory.path, sessionId: "session-ids-restored" };
    const restored: LlmLoopTask = {
      id: "lp-aaaaa",
      kind: "llm-loop",
      name: "nightly review",
      status: "running",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      schedule: "10m",
      prompt: "review the diff",
      fires: 0,
      nextFireAt: 1_700_000_600_000,
      iterations: [],
    };
    const stateDirectory = sessionTaskDirectory(scope.cwd, scope.sessionId);
    await mkdir(stateDirectory, { recursive: true });
    await new TaskStore(stateDirectory).save([restored]);

    // Every suffix character is pinned: `aaaaa` is restored, so the generator
    // must reject its first candidate and issue `bbbbb` instead.
    const characters = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
    const sessions = new TaskSessions({ randomInt: () => characters.shift() ?? 0 });
    const session = await sessions.session(scope);

    expect(session.tasks.get("lp-aaaaa")?.kind).toBe("llm-loop");
    expect(sessions.createId(session, "llm-loop")).toBe("lp-bbbbb");
  });
});
