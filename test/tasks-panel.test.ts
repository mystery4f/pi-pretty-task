/**
 * Panel seam: the `/tasks` overlay is one screen of keyboard interaction, so it
 * is driven here the way a terminal drives it — raw key bytes in, rendered lines
 * out. The panel reads through a narrow source, so these tests need no process.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { formatClockTime } from "../src/tasks/base/format.js";
import type { OutputTail } from "../src/tasks/base/output.js";
import type { CmdLoopTask, FireRecord, LlmLoopTask, ProcessTask } from "../src/tasks/base/task.js";
import type { Iteration, IterationCall } from "../src/tasks/loop/iteration.js";
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
  const created = overrides.createdAt ?? 1_000;
  const task: ProcessTask = {
    id,
    kind: "process",
    name: `task ${id}`,
    status: "running",
    createdAt: created,
    updatedAt: created,
    command: "npm run dev",
    cwd: "/work",
    outputPath: `/work/.pi/tasks/session/${id}.output`,
    outputBytes,
    ...overrides,
  };
  return { task, elapsedMs, outputBytes };
}

/** One loop row, with the iterations the store keeps under it. */
function loopView(
  id: string,
  overrides: Partial<LlmLoopTask> = {},
  elapsedMs = 12_000,
  untilNextFireMs?: number,
): PanelTaskView {
  const created = overrides.createdAt ?? 1_000;
  const task: LlmLoopTask = {
    id,
    kind: "llm-loop",
    name: `loop ${id}`,
    status: "running",
    createdAt: created,
    updatedAt: created,
    schedule: "10s",
    prompt: "review the diff",
    fires: 0,
    iterations: [],
    ...overrides,
  };
  return {
    task,
    elapsedMs,
    outputBytes: 0,
    ...(untilNextFireMs === undefined ? {} : { untilNextFireMs }),
  };
}

/** True when a rendered row carries this strip cell. */
function row_shows(row: string, cell: string): boolean {
  return row.includes(cell);
}

/** A command loop row: a schedule whose fires are process tasks of their own. */
function cmdLoopView(
  id: string,
  overrides: Partial<CmdLoopTask> = {},
  elapsedMs = 12_000,
  untilNextFireMs?: number,
): PanelTaskView {
  const created = overrides.createdAt ?? 1_000;
  const task: CmdLoopTask = {
    id,
    kind: "cmd-loop",
    name: `loop ${id}`,
    status: "running",
    createdAt: created,
    updatedAt: created,
    schedule: "10s",
    command: "node watch.js",
    fires: 0,
    fireHistory: [],
    ...overrides,
  };
  return {
    task,
    elapsedMs,
    outputBytes: 0,
    ...(untilNextFireMs === undefined ? {} : { untilNextFireMs }),
  };
}

/** One fire, as the loop keeps it: the numbers a fire row prints. */
function fireOf(fire: number, overrides: Partial<FireRecord> = {}): FireRecord {
  const at = CLOCK + fire * 10_000;
  return {
    fire,
    at,
    startedAt: at,
    endedAt: at + 800,
    outcome: "success",
    exitCode: 0,
    durationMs: 800,
    outputBytes: 120,
    taskId: `bg-${String(fire).padStart(5, "0")}`,
    ...overrides,
  };
}

const CLOCK = Date.UTC(2026, 0, 1, 9, 0, 0);

function callOf(
  id: string,
  tool: string,
  subject: string,
  overrides: Partial<IterationCall> = {},
): IterationCall {
  return { id, tool, subject, startedAt: CLOCK, status: "completed", ...overrides };
}

function iterationOf(
  fire: number,
  calls: IterationCall[] = [],
  overrides: Partial<Iteration> = {},
): Iteration {
  return {
    fire,
    startedAt: CLOCK + fire * 10_000,
    status: "completed",
    calls,
    droppedCalls: 0,
    ...overrides,
  };
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
  readonly reran: string[] = [];

  /** Rerunning answers with a new row; the old one stays, as the store's would. */
  async rerun(id: string): Promise<PanelTaskView | undefined> {
    this.reran.push(id);
    const row = this.rows.find((candidate) => candidate.task.id === id);
    if (row === undefined || row.task.kind !== "process") return undefined;
    return { ...row, task: { ...row.task, id: `${id}2`, name: `${row.task.name} again` } };
  }
}

interface Opened {
  readonly panel: TasksPanel;
  readonly source: FakeSource;
  readonly done: ReturnType<typeof vi.fn>;
  drawn(): string;
}

/**
 * A theme that adds no markup: the panel's width math sees real glyph widths, so
 * a test can narrow a row and watch what makes way. Colours are asserted through
 * {@link recordingTheme} instead, where the tag overhead would skew the row.
 */
function plainTheme(): Theme {
  const plain = (_colour: string, text: string): string => text;
  return {
    fg: plain,
    bg: plain,
    bold: plain,
    italic: plain,
    underline: plain,
    inverse: plain,
    strikethrough: plain,
  } as unknown as Theme;
}

/** A theme that keeps the text plain but records every colour it was asked for. */
function recordingTheme(): { theme: Theme; painted: Array<{ colour: string; text: string }> } {
  const painted: Array<{ colour: string; text: string }> = [];
  const style = (colour: string, text: string): string => {
    painted.push({ colour, text });
    return text;
  };
  const theme = {
    fg: style,
    bg: style,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
  return { theme, painted };
}

function openPanel(
  source: FakeSource,
  now: () => number = () => 13_000,
  theme: Theme = fakeTheme(),
): Opened {
  const done = vi.fn();
  const panel = new TasksPanel({
    tui: { requestRender: () => undefined },
    theme,
    done,
    source,
    // Tests advance the panel by hand; the live timer would only add races.
    refreshMs: 0,
    // A pinned clock keeps the ages on rows and in details exact.
    now,
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

/** The drawn screen without the fake theme's tags, for assertions on plain text. */
function plain(text: string): string {
  return text.replace(/<\/?[a-zA-Z]+>/g, "");
}

describe("task list", () => {
  it("lists tasks most recently changed first, with kind, name, id, status, elapsed and size", async () => {
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
    expect(lines[newer]).toContain("<dim>·</dim> <muted>proc</muted> <accent>running");
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

    // A finished task is history, so it has to be asked for before Enter can open it.
    panel.handleInput("h");
    await panel.settle();
    panel.handleInput(ENTER);
    await panel.settle();

    expect(drawn()).toContain("nightly build");
    expect(drawn()).toContain("node build.js --nightly");
    expect(drawn()).toContain("4242");
    expect(drawn()).toContain("Exit code");
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
    expect(frozen).toContain("r follows");

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
    expect(drawn()).toContain("Enter logs");

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

  const CLOSE = "\x1bq";

  it("closes on x from the list, and on alt+q from a detail view", async () => {
    const source = new FakeSource();
    source.rows = [view("build1")];
    const { panel, done } = openPanel(source);
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();
    panel.handleInput("x");

    expect(done).not.toHaveBeenCalled();

    panel.handleInput(CLOSE);
    expect(done).toHaveBeenCalledTimes(1);
    panel.dispose();

    const second = openPanel(new FakeSource());
    await second.panel.settle();
    second.panel.handleInput("x");
    expect(second.done).toHaveBeenCalledTimes(1);
    second.panel.dispose();
  });

  it("treats x as a query character while a search is being typed", async () => {
    const source = new FakeSource();
    source.rows = [view("bg-a1b2c", { name: "xenon build" }), view("bg-b2c3d", { name: "lint" })];
    const { panel, done, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("/");
    panel.handleInput("x");
    await panel.settle();

    expect(done).not.toHaveBeenCalled();
    expect(drawn()).toContain("xenon build");
    expect(drawn()).not.toContain("lint ");
    panel.dispose();
  });
});

it("stops every row on a, one source call per task", async () => {
  const source = new FakeSource();
  source.rows = [view("first1"), view("second"), loopView("loop01")];
  const { panel, drawn } = openPanel(source);
  await panel.settle();

  panel.handleInput("a");
  await panel.settle();

  expect(source.stopped.sort()).toEqual(["first1", "loop01", "second"]);
  expect(drawn()).toContain("stopped 3 tasks");

  panel.dispose();
});

it("narrows the list to loops on l and restores it on the second press", async () => {
  const source = new FakeSource();
  source.rows = [view("build1", { name: "build job" }), loopView("loop01", { name: "review" })];
  const { panel, drawn } = openPanel(source);
  await panel.settle();

  panel.handleInput("l");
  await panel.settle();
  expect(drawn()).toContain("review");
  expect(drawn()).not.toContain("build job");

  panel.handleInput("l");
  await panel.settle();
  expect(drawn()).toContain("build job");

  panel.dispose();
});

describe("loop tasks in the list", () => {
  it("mixes loop rows with process rows, the loop row carrying its iterations and last fire", async () => {
    const source = new FakeSource();
    const lastFireAt = CLOCK;
    source.rows = [
      loopView(
        "loop01",
        {
          name: "review loop",
          createdAt: 9_000,
          fires: 5,
          lastFireAt,
          iterations: [iterationOf(4), iterationOf(5)],
          droppedIterations: 3,
        },
        12_000,
        4_000,
      ),
      view("build1", { name: "nightly build", createdAt: 1_000 }, 5000, 1536),
    ];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    const lines = drawn().split("\n");
    const loopRow = lines.find((line) => line.includes("review loop"));
    const processRow = lines.find((line) => line.includes("nightly build"));
    if (loopRow === undefined || processRow === undefined) throw new Error("both rows must render");

    expect(drawn().indexOf("review loop")).toBeLessThan(drawn().indexOf("nightly build"));
    // The row carries the fires and the countdown; the dropped iterations and the
    // last fire's wall-clock time live in the detail.
    expect(loopRow).toContain("<muted>llm</muted>");
    expect(loopRow).toContain("5 fires");
    expect(loopRow).toContain("next 4.0s");
    expect(loopRow).not.toContain("KiB");
    expect(processRow).toContain("<muted>proc</muted>");
    expect(processRow).toContain("1.5 KiB");
    expect(processRow).not.toContain("iterations");

    panel.dispose();
  });

  it("opens a loop without asking the source for an output tail", async () => {
    const source = new FakeSource();
    source.rows = [loopView("loop01", { name: "review loop" })];
    const { panel } = openPanel(source);
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();

    expect(source.tailed).toEqual([]);

    panel.dispose();
  });
});

describe("the loop detail view", () => {
  it("shows the schedule, fire counts, next fire and iterations newest first", async () => {
    const source = new FakeSource();
    const lastFireAt = CLOCK + 30_000;
    source.rows = [
      loopView(
        "loop01",
        {
          name: "review loop",
          schedule: "10s",
          prompt: "review the diff and report",
          fires: 5,
          maxFires: 10,
          lastFireAt,
          nextFireAt: lastFireAt + 10_000,
          iterations: [iterationOf(3), iterationOf(4), iterationOf(5)],
          droppedIterations: 2,
        },
        12_000,
        4_000,
      ),
    ];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();

    const screen = drawn();
    expect(screen).toContain("review loop");
    expect(screen).toContain("llm-loop");
    expect(screen).toContain("10s");
    expect(screen).toContain("5 / 10");
    expect(screen).toContain("review the diff and report");
    expect(screen).toContain(formatClockTime(lastFireAt + 10_000));
    expect(screen).toContain("in 4.0s");
    expect(screen).toContain("3 kept · 2 older dropped");
    expect(screen.indexOf("fire 5")).toBeLessThan(screen.indexOf("fire 3"));

    panel.dispose();
  });

  it("states dropped iterations even when no iteration record is left", async () => {
    const source = new FakeSource();
    source.rows = [loopView("loop01", { name: "review loop", fires: 40, droppedIterations: 40 })];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();

    expect(drawn()).toContain("iterations · none kept · 40 older dropped");

    panel.dispose();
  });

  it("opens an iteration with its tool calls in order, commands highlighted and errors kept", async () => {
    const source = new FakeSource();
    const calls = [
      callOf("c1", "bash", "npm test", { durationMs: 1_200, endedAt: CLOCK + 1_200 }),
      callOf("c2", "read", "src/index.ts"),
      callOf("c3", "bash", "npm run lint", {
        status: "failed",
        endedAt: CLOCK + 300,
        error: "biome: 3 errors",
      }),
    ];
    source.rows = [
      loopView("loop01", {
        name: "review loop",
        fires: 1,
        iterations: [iterationOf(1, calls, { endedAt: CLOCK + 2_000, droppedCalls: 4 })],
      }),
    ];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();
    panel.handleInput(ENTER);
    await panel.settle();

    const screen = drawn();
    expect(screen).toContain("fire 1");
    expect(screen.indexOf("npm test")).toBeLessThan(screen.indexOf("src/index.ts"));
    expect(screen.indexOf("src/index.ts")).toBeLessThan(screen.indexOf("npm run lint"));
    expect(screen).toContain("<accent>npm test</accent>");
    expect(screen).toContain("biome: 3 errors");
    expect(screen).toContain("+4 earlier calls dropped");

    panel.dispose();
  });

  it("walks older iterations with the arrows and returns through the left arrow", async () => {
    const source = new FakeSource();
    source.rows = [
      loopView("loop01", {
        name: "review loop",
        fires: 3,
        iterations: [
          iterationOf(1, [callOf("a", "bash", "command one")]),
          iterationOf(2, [callOf("b", "bash", "command two")]),
          iterationOf(3, [callOf("c", "bash", "command three")]),
        ],
      }),
    ];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();
    panel.handleInput(ENTER);
    await panel.settle();
    expect(drawn()).toContain("command three");

    panel.handleInput(LEFT);
    panel.handleInput(DOWN);
    panel.handleInput(ENTER);
    await panel.settle();
    expect(drawn()).toContain("command two");
    expect(drawn()).not.toContain("command three");

    panel.handleInput(LEFT);
    panel.handleInput(DOWN);
    panel.handleInput(ENTER);
    await panel.settle();
    expect(drawn()).toContain("command one");

    panel.handleInput(LEFT);
    panel.handleInput(LEFT);
    await panel.settle();
    expect(drawn()).toContain("Enter logs");

    panel.dispose();
  });

  it("scrolls a long list of calls and reports the visible range", async () => {
    const source = new FakeSource();
    const calls = Array.from({ length: 20 }, (_, index) =>
      callOf(`c${String(index)}`, "bash", `step-${String(index + 1).padStart(2, "0")}`),
    );
    source.rows = [
      loopView("loop01", {
        name: "review loop",
        fires: 1,
        iterations: [iterationOf(1, calls)],
      }),
    ];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();
    panel.handleInput(ENTER);
    await panel.settle();

    expect(drawn()).toContain(`calls 1–${String(DETAIL_OUTPUT_LINES)} of 20`);
    expect(drawn()).toContain("step-01");
    expect(drawn()).not.toContain("step-20");

    panel.handleInput(DOWN);
    await panel.settle();
    expect(drawn()).toContain(`calls 2–${String(DETAIL_OUTPUT_LINES + 1)} of 20`);

    panel.handleInput("\u001b[6~");
    await panel.settle();
    expect(drawn()).toContain("calls 9–20 of 20");
    expect(drawn()).toContain("step-20");
    expect(drawn()).not.toContain("step-01");

    panel.dispose();
  });

  it("stops a loop from its detail view with k", async () => {
    const source = new FakeSource();
    source.rows = [loopView("loop01", { name: "review loop" })];
    source.stop = async (id: string): Promise<PanelStopResult | undefined> => {
      source.stopped.push(id);
      return { outcome: "completed", view: loopView(id, { status: "completed" }) };
    };
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();
    panel.handleInput("k");
    await panel.settle();

    expect(source.stopped).toEqual(["loop01"]);
    expect(drawn()).toContain("stopped loop01 · completed");

    panel.dispose();
  });
});

describe("the list header", () => {
  it("tallies every ending above the rows, whatever the filters hide", async () => {
    const source = new FakeSource();
    source.rows = [
      view("run0001", { name: "server", status: "running" }),
      view("done001", { name: "build", status: "completed", exitCode: 0 }),
      view("bad0001", { name: "lint", status: "failed" }),
      view("slow001", { name: "deploy", status: "killed", killReason: "timeout" }),
      view("kill001", { name: "watch", status: "killed", killReason: "user" }),
    ];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    const header = drawn().split("\n").slice(0, 2).join("\n");
    expect(header).toContain("Background Tasks");
    for (const label of ["Running", "Succeeded", "Failed", "Timeout", "Killed"]) {
      expect(header).toContain(`<muted>${label}</muted>`);
    }

    // Only the running row is live, so history stays out of the list until `h`.
    expect(drawn()).toContain("server");
    expect(drawn()).not.toContain("lint");

    panel.dispose();
  });
});

describe("history, rerun and the output path", () => {
  it("shows finished rows on h and hides them again", async () => {
    const source = new FakeSource();
    source.rows = [
      view("run0001", { name: "server", status: "running" }),
      view("done001", { name: "build", status: "completed", exitCode: 0 }),
    ];
    const { panel, drawn } = openPanel(source);
    await panel.settle();
    expect(drawn()).not.toContain("build");

    panel.handleInput("h");
    await panel.settle();
    expect(drawn()).toContain("build");
    expect(drawn()).toContain("showing history");

    panel.handleInput("h");
    await panel.settle();
    expect(drawn()).not.toContain("build");

    panel.dispose();
  });

  it("keeps history hidden on an idle session until h asks for it", async () => {
    const source = new FakeSource();
    source.rows = [
      view("done001", { name: "build", status: "completed", exitCode: 0 }),
      view("done002", { name: "lint", status: "completed", exitCode: 0 }),
    ];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    // Nothing runs and h was never pressed: the list stays empty and says how
    // to get the past back, even though the counts already know it exists.
    expect(drawn()).not.toContain("build");
    expect(drawn()).toContain("History is hidden — press h to show it.");

    panel.handleInput("h");
    await panel.settle();
    expect(drawn()).toContain("build");

    // A later refresh must not undo the reader's choice either way.
    panel.handleInput("h");
    await panel.settle();
    expect(drawn()).not.toContain("build");

    panel.dispose();
  });

  it("reruns the selected task with R and selects the new row", async () => {
    const source = new FakeSource();
    source.rows = [view("run0001", { name: "server" })];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("R");
    await panel.settle();

    expect(source.reran).toEqual(["run0001"]);
    expect(drawn()).toContain("ran run0001 again as run00012");

    panel.dispose();
  });

  it("refuses to rerun a loop row", async () => {
    const source = new FakeSource();
    source.rows = [loopView("loop01", { name: "review loop" })];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("R");
    await panel.settle();

    expect(source.reran).toEqual([]);
    expect(drawn()).toContain("A loop is scheduled, not run");

    panel.dispose();
  });

  it("shows the output path with c", async () => {
    const source = new FakeSource();
    source.rows = [view("run0001", { name: "server" })];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("c");
    await panel.settle();

    expect(drawn()).toContain("output: /work/.pi/tasks/session/run0001.output");

    panel.dispose();
  });
});

describe("recency and search", () => {
  const ALT_Q = "\x1bq";
  const BACKSPACE = "\x7f";

  /** Three tasks whose commands, ids and statuses each say something different. */
  function searchFixture(): FakeSource {
    const source = new FakeSource();
    source.rows = [
      view("bg-a1b2c", { name: "web build", command: "npm run build", createdAt: 1_000 }),
      view("bg-b2c3d", { name: "unit tests", command: "npm test", createdAt: 2_000 }),
      view(
        "bg-c3d4e",
        {
          name: "lint run",
          command: "npm run lint",
          status: "failed",
          createdAt: 3_000,
          endedAt: 4_000,
          exitCode: 1,
        },
        1_000,
      ),
    ];
    return source;
  }

  it("orders rows by the last change, not by when they were created", async () => {
    const source = new FakeSource();
    source.rows = [
      // Created first, changed last: recency, not age, decides the order.
      view("bg-aaaaa", { name: "old build", createdAt: 2_000, updatedAt: 9_000 }),
      view("bg-bbbbb", { name: "new task", createdAt: 8_000, updatedAt: 8_500 }),
    ];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    const lines = drawn().split("\n");
    const changed = lines.findIndex((line) => line.includes("old build"));
    const created = lines.findIndex((line) => line.includes("new task"));
    expect(changed).toBeGreaterThan(-1);
    expect(created).toBeGreaterThan(changed);

    panel.dispose();
  });

  it("shows how long ago a task last changed, on its row and in the detail", async () => {
    const source = new FakeSource();
    source.rows = [view("bg-aaaaa", { name: "nightly build", updatedAt: 5_000 }, 2_000, 512)];
    const clock = 17_000; // Twelve seconds after the last change.
    const { panel, drawn } = openPanel(source, () => clock);
    await panel.settle();

    const row = drawn()
      .split("\n")
      .find((line) => line.includes("nightly build"));
    expect(row).toContain("12.0s ago");

    panel.handleInput(ENTER);
    // The label column pads the value, so the absolute time and its age are
    // asserted as the two things the field says.
    expect(plain(drawn())).toContain("Updated:");
    expect(plain(drawn())).toContain(formatClockTime(5_000));
    expect(plain(drawn())).toContain("12.0s ago");

    panel.dispose();
  });

  it("filters live rows by a command substring as the query is typed", async () => {
    const source = searchFixture();
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "build") panel.handleInput(character);

    expect(plain(drawn())).toContain("filter: build");
    expect(drawn()).toContain("web build");
    expect(drawn()).not.toContain("unit tests");
    // The counts still cover every task: the failed lint run is history, hidden
    // from the list but not forgotten by the header.
    expect(drawn()).toContain("<error>");

    panel.dispose();
  });

  it("filters by an id prefix", async () => {
    const source = searchFixture();
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "bg-b") panel.handleInput(character);

    expect(drawn()).toContain("unit tests");
    expect(drawn()).not.toContain("web build");
    expect(drawn()).not.toContain("lint run");

    panel.dispose();
  });

  it("filters by the kind word the row shows, so an llm loop answers to llm", async () => {
    const source = new FakeSource();
    source.rows = [
      loopView("lp-abcde", { name: "nightly review", createdAt: 2_000 }),
      view("bg-aaaaa", { name: "nightly build", createdAt: 1_000 }),
    ];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "llm") panel.handleInput(character);

    expect(drawn()).toContain("nightly review");
    expect(drawn()).not.toContain("nightly build");

    panel.dispose();
  });

  it("filters by the status word without revealing the history h hides", async () => {
    const source = searchFixture();
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "failed") panel.handleInput(character);

    // The query matches a failed record, but history stays the reader's call.
    expect(plain(drawn())).toContain("filter: failed");
    expect(drawn()).not.toContain("lint run");
    expect(plain(drawn())).toContain("History is hidden");

    // Leaving search keeps the query; h then reveals the past under the filter.
    panel.handleInput(ALT_Q);
    panel.handleInput("h");
    await panel.settle();
    expect(drawn()).toContain("lint run");
    expect(drawn()).not.toContain("web build");

    panel.dispose();
  });

  it("turns a pasted command into a one-line query", async () => {
    const source = searchFixture();
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("/");
    panel.handleInput("\x1b[200~npm test\nnpm run lint\x1b[201~");

    expect(plain(drawn())).toContain("filter: npm test npm run lint");
    expect(plain(drawn())).not.toContain("filter: npm test\n");

    panel.dispose();
  });

  it("edits the query with backspace", async () => {
    const source = searchFixture();
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "build") panel.handleInput(character);
    panel.handleInput(BACKSPACE);

    expect(plain(drawn())).toContain("filter: buil");
    expect(drawn()).toContain("web build");

    panel.dispose();
  });

  it("leaves search on alt+q with the query kept, and closes on the second alt+q", async () => {
    const source = searchFixture();
    const { panel, done, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "build") panel.handleInput(character);

    panel.handleInput(ALT_Q);
    expect(done).not.toHaveBeenCalled();
    // The header keeps saying why rows are missing after search mode is left.
    expect(plain(drawn())).toContain("filter: build");
    expect(drawn()).toContain("web build");

    panel.handleInput(ALT_Q);
    expect(done).toHaveBeenCalledTimes(1);

    panel.dispose();
  });

  it("closes nothing on escape or q", async () => {
    const source = searchFixture();
    const { panel, done } = openPanel(source);
    await panel.settle();

    panel.handleInput("\x1b");
    panel.handleInput("q");
    expect(done).not.toHaveBeenCalled();

    panel.handleInput("/");
    panel.handleInput("build");
    panel.handleInput("\x1b");
    expect(done).not.toHaveBeenCalled();

    panel.dispose();
  });
});

describe("command loops in the list and in the detail", () => {
  it("puts the newest three fires on the row, oldest left, and never shows a fire as a row", async () => {
    const source = new FakeSource();
    source.rows = [
      cmdLoopView(
        "lc00001",
        {
          name: "watch loop",
          command: "node watch.js",
          fires: 45,
          fireHistory: [
            fireOf(42),
            fireOf(43),
            fireOf(44, { outcome: "failed", exitCode: 2 }),
            fireOf(45, {
              outcome: "running",
              exitCode: undefined,
              durationMs: undefined,
              outputBytes: undefined,
              endedAt: undefined,
            }),
          ],
        },
        30_000,
        5_000,
      ),
      // The fire's own process task is a record, not a row (ADR-0014).
      view("bg-00001", { name: "watch loop #1", parentId: "lc00001", fire: 1 }),
    ];
    // A recording theme keeps every glyph in place and still says what colour the
    // panel asked for, so the strip can be checked for both order and outcome.
    const { theme, painted } = recordingTheme();
    const { panel, drawn } = openPanel(source, () => 13_000, theme);
    await panel.settle();

    // A wide page fits all three cells; how the strip gives way is the next test.
    const row = panel
      .render(160)
      .join("\n")
      .split("\n")
      .find((line) => line.includes("watch loop"));
    if (row === undefined) throw new Error("the loop row must render");
    expect(row).not.toContain("#42");
    expect(row).toContain("45 fires");
    expect(row).toContain("#43✓ #44✗ #45•");
    expect(row.indexOf("#43")).toBeLessThan(row.indexOf("#44"));
    expect(row.indexOf("#44")).toBeLessThan(row.indexOf("#45"));
    // Each cell is coloured by its own outcome: success, failure, still running.
    expect(painted).toContainEqual({ colour: "success", text: "#43✓" });
    expect(painted).toContainEqual({ colour: "error", text: "#44✗" });
    expect(painted).toContainEqual({ colour: "accent", text: "#45•" });
    // The child shows only in the loop's own detail, never as a list row.
    expect(drawn()).not.toContain("watch loop #1");

    panel.dispose();
  });

  it("drops the oldest strip cells on a narrow row and omits the strip when nothing fits", async () => {
    const source = new FakeSource();
    source.rows = [
      cmdLoopView(
        "lc00001",
        {
          name: "watch loop",
          fires: 45,
          fireHistory: [
            fireOf(43),
            fireOf(44, { outcome: "failed", exitCode: 2 }),
            fireOf(45, { outcome: "skipped", exitCode: undefined }),
          ],
        },
        30_000,
        5_000,
      ),
    ];
    const { panel } = openPanel(source, () => 13_000, plainTheme());
    await panel.settle();

    const widths = [160, 140, 120, 100, 90, 80, 70, 60, 50, 44, 38];
    const rows = widths.map((width) => {
      const line = panel
        .render(width)
        .join("\n")
        .split("\n")
        .find((candidate) => candidate.includes("watch loop"));
      if (line === undefined) throw new Error(`the row must render at width ${String(width)}`);
      return line;
    });
    const cells = ["#43✓", "#44✗", "#45–"];

    // The widest row carries all three cells, oldest left.
    expect(rows[0]).toContain(cells.join(" "));
    // Narrowing only ever drops cells, and always from the left: a row that shows
    // an older cell shows every newer one too (ADR-0015).
    const counts = rows.map((row) => cells.filter((cell) => row.includes(cell)).length);
    for (const [index, count] of counts.entries()) {
      if (index > 0) expect(count).toBeLessThanOrEqual(counts[index - 1] ?? 3);
      if (row_shows(rows[index] ?? "", cells[0] ?? "")) {
        expect(rows[index]).toContain(cells[1] ?? "");
        expect(rows[index]).toContain(cells[2] ?? "");
      }
      if (row_shows(rows[index] ?? "", cells[1] ?? "")) expect(rows[index]).toContain(cells[2]);
    }
    // Too narrow for even one cell: the strip is gone, the row is intact.
    const omitted = rows.find((row) => !row.includes("#45"));
    if (omitted === undefined) throw new Error("some width must omit the strip");
    expect(omitted).toContain("watch loop");
    expect(omitted).toContain("45 fires");

    panel.dispose();
  });

  it("lists fires newest first with time, outcome, exit code, duration and bytes", async () => {
    const source = new FakeSource();
    source.rows = [
      cmdLoopView(
        "lc00001",
        {
          name: "watch loop",
          fires: 46,
          lastFireAt: CLOCK + 450_000,
          nextFireAt: CLOCK + 460_000,
          lastExitCode: 0,
          lastOutputPath: "/state/bg-00046.output",
          lastOutputBytes: 120,
          fireHistory: [
            fireOf(44),
            fireOf(45, { outcome: "failed", exitCode: 2 }),
            fireOf(46, {
              outcome: "skipped",
              exitCode: undefined,
              durationMs: undefined,
              outputBytes: undefined,
            }),
          ],
        },
        30_000,
        5_000,
      ),
    ];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();

    const screen = drawn();
    expect(screen).toContain("cmd-loop");
    expect(screen).toContain("node watch.js");
    expect(screen).toContain("fires · newest first · 3 kept · 43 older dropped");
    expect(screen).toContain(formatClockTime(CLOCK + 460_000));
    expect(screen).toContain("exit 0");
    expect(screen).toContain("0.8s");
    expect(screen).toContain("120 B");
    expect(screen).toContain("skipped");
    expect(screen.indexOf("#46")).toBeLessThan(screen.indexOf("#45"));
    expect(screen.indexOf("#45")).toBeLessThan(screen.indexOf("#44"));
    // A skipped fire never ran, so it prints no exit code.
    expect(screen).toContain("#46 · ");

    panel.dispose();
  });

  it("opens a fire's output, returns to the loop with the left arrow, and stops only that fire", async () => {
    const source = new FakeSource();
    const child: PanelTaskView = view("bg-00045", {
      name: "watch loop #45",
      parentId: "lc00001",
      fire: 45,
      createdAt: CLOCK,
    });
    source.rows = [
      cmdLoopView(
        "lc00001",
        {
          name: "watch loop",
          fires: 45,
          fireHistory: [fireOf(44), fireOf(45, { taskId: "bg-00045" })],
        },
        30_000,
        5_000,
      ),
      child,
    ];
    source.tails.set("bg-00045", { text: "hello from fire 45", lines: 1, truncated: false });
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();
    // The newest fire sits under the cursor, so one more enter opens its child.
    panel.handleInput(ENTER);
    await panel.settle();

    expect(source.tailed).toEqual(["bg-00045"]);
    expect(plain(drawn())).toContain("hello from fire 45");

    panel.handleInput(LEFT);
    await panel.settle();
    expect(plain(drawn())).toContain("fires · newest first");

    panel.handleInput(ENTER);
    await panel.settle();
    panel.handleInput("k");
    await panel.settle();
    // `k` in a fire detail stops that fire, not the schedule around it.
    expect(source.stopped).toEqual(["bg-00045"]);

    panel.dispose();
  });

  it("finds a command loop by its command and by its kind word", async () => {
    const byCommand = new FakeSource();
    byCommand.rows = [
      cmdLoopView("lc00001", { name: "nightly probe", command: "node probe.js" }),
      cmdLoopView("lc00002", { name: "nightly review" }),
    ];
    const first = openPanel(byCommand);
    await first.panel.settle();

    first.panel.handleInput("/");
    for (const character of "probe.js") first.panel.handleInput(character);
    await first.panel.settle();
    expect(first.drawn()).toContain("nightly probe");
    expect(first.drawn()).not.toContain("nightly review");
    first.panel.dispose();

    const byKind = new FakeSource();
    byKind.rows = [
      cmdLoopView("lc00001", { name: "nightly probe", command: "node probe.js" }),
      cmdLoopView("lc00002", { name: "nightly review" }),
    ];
    const second = openPanel(byKind);
    await second.panel.settle();

    second.panel.handleInput("/");
    for (const character of "cmd") second.panel.handleInput(character);
    await second.panel.settle();
    expect(second.drawn()).toContain("nightly probe");
    expect(second.drawn()).toContain("nightly review");
    second.panel.dispose();
  });
});
