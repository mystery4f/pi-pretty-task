/**
 * Panel seam: the `/tasks` overlay is one screen of keyboard interaction, so it
 * is driven here the way a terminal drives it — raw key bytes in, rendered lines
 * out. The panel reads through a narrow source, so these tests need no process.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { describe, expect, it, vi } from "vitest";
import type { OutputTail } from "../src/tasks/base/output.js";
import type { ProcessTask } from "../src/tasks/base/task.js";
import {
  DETAIL_OUTPUT_LINES,
  type PanelSource,
  type PanelStopResult,
  type PanelTaskView,
  TasksPanel,
} from "../src/ui/tasks-panel.js";
import { fakeTheme } from "./support/extension-harness.js";

const UP = "\u001b[A";
const DOWN = "\u001b[B";
const LEFT = "\u001b[D";
const ENTER = "\r";
const WIDTH = 100;

/** One row as the store would hand it to the panel. */
function view(
  id: string,
  overrides: Partial<ProcessTask> = {},
  elapsedMs = 5000,
  outputBytes = 1024,
): PanelTaskView {
  const task: ProcessTask = {
    id,
    kind: "process",
    name: `task ${id}`,
    status: "running",
    createdAt: 1_000,
    command: "npm run dev",
    cwd: "/work",
    outputPath: `/work/.pi/tasks/session/${id}.output`,
    outputBytes,
    ...overrides,
  };
  return { task, elapsedMs, outputBytes };
}

/** A source stand-in: rows to list, tails to read, stops to record. */
class FakeSource implements PanelSource {
  rows: PanelTaskView[] = [];
  readonly tails = new Map<string, OutputTail | Error>();
  readonly stopped: string[] = [];
  readonly tailed: string[] = [];
  listCalls = 0;

  async list(): Promise<readonly PanelTaskView[]> {
    this.listCalls += 1;
    return this.rows;
  }

  async tail(id: string): Promise<OutputTail | undefined> {
    this.tailed.push(id);
    const answer = this.tails.get(id);
    if (answer instanceof Error) throw answer;
    return answer ?? { text: "", lines: 0, truncated: false };
  }

  async stop(id: string): Promise<PanelStopResult | undefined> {
    this.stopped.push(id);
    const row = this.rows.find((candidate) => candidate.task.id === id);
    if (row === undefined) return undefined;
    return { outcome: "killed", view: row };
  }
}

interface Opened {
  readonly panel: TasksPanel;
  readonly source: FakeSource;
  readonly done: ReturnType<typeof vi.fn>;
  drawn(): string;
}

function openPanel(source: FakeSource): Opened {
  const done = vi.fn();
  const panel = new TasksPanel({
    tui: { requestRender: () => undefined },
    theme: fakeTheme(),
    done,
    source,
    // Tests advance the panel by hand; the live timer would only add races.
    refreshMs: 0,
  });
  return { panel, source, done, drawn: () => panel.render(WIDTH).join("\n") };
}

/** Output lines named `output-01` … `output-NN`, oldest first. */
function numberedOutput(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `output-${String(index + 1).padStart(2, "0")}`,
  );
}

function tailOf(lines: string[]): OutputTail {
  return { text: lines.join("\n"), lines: lines.length, truncated: false };
}

function expectNoHexColour(drawn: string): void {
  // Colours come from theme tokens only; a hex literal would bypass the user's palette.
  expect(drawn).not.toMatch(/#[0-9a-fA-F]{6}/);
}

describe("task list", () => {
  it("lists tasks newest first, with kind, name, id, status, elapsed and size", async () => {
    const source = new FakeSource();
    source.rows = [
      view("older1", { name: "older build", createdAt: 1_000 }, 2_000, 512),
      view("newer1", { name: "newer build", createdAt: 9_000 }, 3_500, 1536),
    ];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    const lines = drawn().split("\n");
    const newer = lines.findIndex((line) => line.includes("newer build"));
    const older = lines.findIndex((line) => line.includes("older build"));

    expect(newer).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(newer);
    expect(drawn()).toContain("newer1");
    expect(drawn()).toContain("process");
    expect(drawn()).toContain("running");
    expect(drawn()).toContain("3.5s");
    expect(drawn()).toContain("1.5 KiB");
    expectNoHexColour(drawn());

    panel.dispose();
  });

  it("explains an empty session instead of drawing a blank box", async () => {
    const { panel, drawn } = openPanel(new FakeSource());
    await panel.settle();

    expect(drawn()).toContain("No tasks yet");
    expect(drawn()).toContain("bg_run");
    expect(
      drawn()
        .split("\n")
        .filter((line) => line.trim().length > 0).length,
    ).toBeGreaterThan(2);

    panel.dispose();
  });

  it("paints a finished task's status in the theme's own colour", async () => {
    const source = new FakeSource();
    source.rows = [view("done01", { status: "failed" })];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    expect(drawn()).toContain("<error>");
    expectNoHexColour(drawn());

    panel.dispose();
  });
});

describe("detail view", () => {
  it("opens on Enter with a process task's metadata and its last 12 output lines", async () => {
    const source = new FakeSource();
    source.rows = [
      view(
        "build1",
        {
          name: "nightly build",
          command: "node build.js --nightly",
          pid: 4242,
          status: "failed",
          exitCode: 3,
          error: "exited with code 3",
          endedAt: 9_000,
          outputBytes: 4400,
        },
        5000,
        4400,
      ),
    ];
    source.tails.set("build1", tailOf(numberedOutput(20)));
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();

    expect(drawn()).toContain("nightly build");
    expect(drawn()).toContain("node build.js --nightly");
    expect(drawn()).toContain("4242");
    expect(drawn()).toContain("exit code");
    expect(drawn()).toContain("exited with code 3");
    expect(drawn()).toContain("build1");

    // Exactly the visible window: the twelfth line back is shown, the thirteenth is not.
    const visible = DETAIL_OUTPUT_LINES;
    expect(drawn()).toContain(`output-${String(20).padStart(2, "0")}`);
    expect(drawn()).toContain(`output-${String(20 - visible + 1).padStart(2, "0")}`);
    expect(drawn()).not.toContain(`output-${String(20 - visible).padStart(2, "0")}`);
    expect(drawn()).toContain("4.3 KiB");
    expectNoHexColour(drawn());

    panel.dispose();
  });

  it("freezes the tail when scrolled up and resumes following on r", async () => {
    const source = new FakeSource();
    source.rows = [view("build1", { name: "nightly build" })];
    source.tails.set("build1", tailOf(numberedOutput(20)));
    const { panel, drawn } = openPanel(source);
    await panel.settle();
    panel.handleInput(ENTER);
    await panel.settle();

    panel.handleInput(UP);
    panel.handleInput(UP);
    await panel.settle();
    const frozen = drawn();
    // Two lines up: the window ends two lines above the newest.
    expect(frozen).toContain("output-18");
    expect(frozen).not.toContain("output-19");
    expect(frozen).toContain("r resumes following");

    // New output arrives; the frozen view must not move under the reader.
    source.tails.set("build1", tailOf(numberedOutput(24)));
    await panel.refresh();
    expect(drawn()).toBe(frozen);
    expect(drawn()).not.toContain("output-23");

    panel.handleInput("r");
    await panel.settle();
    expect(drawn()).toContain("following");
    expect(drawn()).toContain("output-24");
    expect(drawn()).not.toContain("output-12");

    panel.dispose();
  });

  it("scrolls back to the top and never past it", async () => {
    const source = new FakeSource();
    source.rows = [view("build1")];
    source.tails.set("build1", tailOf(numberedOutput(20)));
    const { panel, drawn } = openPanel(source);
    await panel.settle();
    panel.handleInput(ENTER);
    await panel.settle();

    for (let step = 0; step < 50; step += 1) panel.handleInput(UP);
    await panel.settle();
    expect(drawn()).toContain("output-01");
    expect(drawn()).toContain("output-12");
    expect(drawn()).not.toContain("output-13");

    // Down at the bottom follows again.
    for (let step = 0; step < 50; step += 1) panel.handleInput(DOWN);
    await panel.settle();
    expect(drawn()).toContain("following");
    expect(drawn()).toContain("output-20");

    panel.dispose();
  });

  it("shows a task whose output file is gone as having no output yet", async () => {
    const source = new FakeSource();
    source.rows = [view("gone01", { name: "missing output" })];
    // The store answers a missing file with an empty tail, as readOutputTail does.
    source.tails.set("gone01", { text: "", lines: 0, truncated: false });
    const { panel, drawn } = openPanel(source);
    await panel.settle();
    panel.handleInput(ENTER);
    await panel.settle();

    expect(drawn()).toContain("missing output");
    expect(drawn()).toContain("no output yet");

    panel.dispose();
  });

  it("keeps the detail readable when the output cannot be read at all", async () => {
    const source = new FakeSource();
    source.rows = [view("deny01", { name: "denied output" })];
    source.tails.set("deny01", new Error("EACCES: permission denied"));
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();

    expect(drawn()).toContain("denied output");
    expect(drawn()).toContain("output unavailable");
    expect(drawn()).toContain("EACCES");

    panel.dispose();
  });

  it("returns to the list on the left arrow", async () => {
    const source = new FakeSource();
    source.rows = [view("build1", { name: "nightly build" })];
    const { panel, drawn } = openPanel(source);
    await panel.settle();
    panel.handleInput(ENTER);
    await panel.settle();

    panel.handleInput(LEFT);
    await panel.settle();

    expect(drawn()).toContain("nightly build");
    expect(drawn()).toContain("Enter details");

    panel.dispose();
  });
});

describe("stopping and closing", () => {
  it("stops the selected task with k, through the source only", async () => {
    const source = new FakeSource();
    source.rows = [
      view("older1", { name: "older build", createdAt: 1_000 }),
      view("newer1", { name: "newer build", createdAt: 9_000 }),
    ];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("k");
    await panel.settle();

    expect(source.stopped).toEqual(["newer1"]);
    expect(drawn()).toContain("newer1");

    panel.dispose();
  });

  it("reports that a task had already finished instead of pretending to kill it", async () => {
    const source = new FakeSource();
    source.rows = [view("done01", { name: "finished build" })];
    source.stop = async (id: string): Promise<PanelStopResult | undefined> => {
      source.stopped.push(id);
      return undefined;
    };
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("k");
    await panel.settle();

    expect(drawn()).toContain("no such task");

    panel.dispose();
  });

  it("closes on x from the list and from the detail view", async () => {
    const source = new FakeSource();
    source.rows = [view("build1")];
    const { panel, done } = openPanel(source);
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();
    panel.handleInput("x");

    expect(done).toHaveBeenCalledTimes(1);
    panel.dispose();

    const second = openPanel(new FakeSource());
    await second.panel.settle();
    second.panel.handleInput("x");
    expect(second.done).toHaveBeenCalledTimes(1);
    second.panel.dispose();
  });
});
