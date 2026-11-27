/**
 * The registered tool names are the whole model-facing surface of this package
 * (#38). A bare `bg_run` or `loop_create` reads like it belongs to whoever loaded
 * first, and two extensions that both claim `bg_*` cannot coexist: the model calls
 * one name and cannot tell which extension answered.
 *
 * So the set is asserted literally — exactly eleven prefixed names, no aliases, one
 * name per tool — and the descriptions are checked for a bare spelling that would
 * send the model to a name that is not registered.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { afterEach, describe, expect, it } from "vitest";

import { createHarness } from "../support/extension-harness.js";
import { makeTempDir } from "../support/processes.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** Every name this package registers, spelled once, in registration order. */
const EXPECTED_TOOL_NAMES = [
  "pretty_task_bg_run",
  "pretty_task_bg_status",
  "pretty_task_bg_logs",
  "pretty_task_bg_wait",
  "pretty_task_bg_grep",
  "pretty_task_bg_kill",
  "pretty_task_loop_create",
  "pretty_task_loop_list",
  "pretty_task_loop_update",
  "pretty_task_loop_fire",
  "pretty_task_loop_delete",
] as const;

/** The names this package registered before the prefix; none may survive. */
const OLD_TOOL_NAMES = [
  "bg_run",
  "bg_status",
  "bg_logs",
  "bg_wait",
  "bg_grep",
  "bg_kill",
  "loop_create",
  "loop_list",
  "loop_update",
  "loop_delete",
] as const;

async function loadHarness() {
  const directory = await makeTempDir();
  cleanup.push(directory.dispose);
  return createHarness({ cwd: directory.path, sessionId: "session-tool-names" });
}

describe("the registered tool names", () => {
  it("registers exactly the eleven pretty_task_ names and nothing else", async () => {
    const harness = await loadHarness();

    expect([...harness.toolNames].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    expect(harness.toolNames).toHaveLength(EXPECTED_TOOL_NAMES.length);

    for (const name of OLD_TOOL_NAMES) {
      expect(harness.toolNames).not.toContain(name);
    }
  });

  it("names no tool by a bare spelling in any description", async () => {
    const harness = await loadHarness();

    for (const name of harness.toolNames) {
      const description = harness.toolDescription(name);
      for (const old of OLD_TOOL_NAMES) {
        // `pretty_task_bg_run` contains `bg_run`, so match the name only where
        // it is not already prefixed: a letter, digit or `_` before it makes it
        // part of the longer, registered spelling.
        expect(description).not.toMatch(new RegExp(`(?<![\\w])${old}(?![\\w])`, "u"));
      }
    }
  });
});
