/**
 * Id seam: the first characters of an id say which kind of task it names, so a
 * `bg-1a2cf` quoted in a later message is readable without the panel in front of
 * you (ADR-0011). Records written before the prefix keep their six characters.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { afterEach, describe, expect, it } from "vitest";

import { TaskSessions } from "../src/tasks/base/task-sessions.js";
import { makeTempDir } from "./support/processes.js";

const cleanup: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => directory.dispose()));
});

describe("task ids", () => {
  it("starts a process id with bg- and a loop id with lp-, five random characters after each", async () => {
    const directory = await makeTempDir();
    cleanup.push(directory);
    const sessions = new TaskSessions();
    const session = await sessions.session({ cwd: directory.path, sessionId: "session-ids" });

    const processId = sessions.createId(session, "process");
    const loopId = sessions.createId(session, "loop");

    expect(processId).toMatch(/^bg-[a-z0-9]{5}$/);
    expect(loopId).toMatch(/^lp-[a-z0-9]{5}$/);
    // Three characters of prefix plus five of randomness: the example `bg-1a2cf`
    // is eight cells, whatever a count in the ADR prose says.
    expect(processId).toHaveLength(8);
    expect(loopId).toHaveLength(8);
    // One namespace per session: the collision check spans the whole id, so the
    // two prefixes never compete for it, and neither id is already taken.
    expect(processId).not.toBe(loopId);
    expect(session.tasks.has(processId)).toBe(false);
    expect(session.tasks.has(loopId)).toBe(false);
  });
});
