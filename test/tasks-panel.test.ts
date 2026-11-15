/**
 * Panel seam: the `/tasks` overlay is one screen of keyboard interaction, so it
 * is driven here the way a terminal drives it — raw key bytes in, rendered lines
 * out. The panel reads through a narrow source, so these tests need no process.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatClockTime, formatDuration } from "../src/tasks/base/format.js";
import type { OutputTail } from "../src/tasks/base/output.js";
import type {
  ChainTask,
  CmdLoopTask,
  FireRecord,
  ProcessTask,
  PromptLoopTask,
} from "../src/tasks/base/task.js";
import type { Iteration, IterationCall } from "../src/tasks/loop/iteration.js";
import {
  DEFAULT_PANEL_FILTER,
  DETAIL_OUTPUT_LINES,
  PANEL_FILTERS,
  PANEL_TABS,
  type PanelFilter,
  type PanelSource,
  type PanelStopResult,
  type PanelTab,
  type PanelTaskView,
  rememberPanelTab,
  TasksPanel,
} from "../src/ui/tasks-panel.js";
import { plainTheme } from "./support/extension-harness.js";

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
  overrides: Partial<PromptLoopTask> = {},
  elapsedMs = 12_000,
  untilNextFireMs?: number,
): PanelTaskView {
  const created = overrides.createdAt ?? 1_000;
  const task: PromptLoopTask = {
    id,
    kind: "prompt-loop",
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

/**
 * One chain: a queue of step ids and a cursor (ADR-0013). The steps themselves are
 * ordinary process records, listed separately so a test can resolve them by id.
 */
function chainView(
  id: string,
  overrides: Partial<ChainTask> = {},
  elapsedMs = 8_000,
): PanelTaskView {
  const created = overrides.createdAt ?? 1_000;
  const task: ChainTask = {
    kind: "chain",
    id,
    name: `chain ${id}`,
    status: "running",
    createdAt: created,
    updatedAt: created,
    steps: [],
    cursor: 0,
    ...overrides,
  };
  return { task, elapsedMs, outputBytes: 0 };
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
/** A source stand-in: rows to list, tails to read, stops to record. */
class FakeSource implements PanelSource {
  /** The session the panel belongs to; a row tagged otherwise came from elsewhere. */
  readonly sessionId = "mine0000-0000-4000-8000-000000000000";
  rows: PanelTaskView[] = [];
  /** Roots of the other sessions in the same checkout, tagged with their session. */
  otherRows: PanelTaskView[] = [];
  readonly tails = new Map<string, OutputTail | Error>();
  readonly stopped: string[] = [];
  readonly tailed: string[] = [];
  /** The session each tail was asked for; undefined means this panel's own. */
  readonly tailedFrom: Array<string | undefined> = [];
  listCalls = 0;

  async list(): Promise<readonly PanelTaskView[]> {
    this.listCalls += 1;
    return this.rows;
  }

  async others(): Promise<readonly PanelTaskView[]> {
    return this.otherRows;
  }

  async tail(id: string, sessionId?: string): Promise<OutputTail | undefined> {
    this.tailed.push(id);
    this.tailedFrom.push(sessionId);
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
  theme: Theme = plainTheme(),
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

/**
 * Open the panel and walk to a page with the key a reader presses, so the tab
 * machinery is exercised rather than bypassed.
 */
async function openOn(
  tab: PanelTab | PanelFilter,
  source: FakeSource,
  now: () => number = () => 13_000,
  theme: Theme = plainTheme(),
): Promise<Opened> {
  const opened = openPanel(source, now, theme);
  await opened.panel.settle();
  opened.panel.handleInput(tabKey(tab));
  return opened;
}

/**
 * The key that reaches a page or a filter from wherever the panel opens: `1`–`3`
 * for a page, `f` as many times as the filter is from the one the panel opens on.
 */
function tabKey(choice: PanelTab | PanelFilter): string {
  switch (choice) {
    case "processes":
    case "loops":
    case "chains":
      return String(PANEL_TABS.indexOf(choice) + 1);
    default: {
      // The panel opens on DEFAULT_PANEL_FILTER; `f` walks the list in one direction only.
      const from = PANEL_FILTERS.indexOf(DEFAULT_PANEL_FILTER);
      const to = PANEL_FILTERS.indexOf(choice);
      return "f".repeat((to - from + PANEL_FILTERS.length) % PANEL_FILTERS.length);
    }
  }
}

/** `f` walks running → failed → done → all, so the archive is three presses away. */
function showAll(panel: TasksPanel): void {
  for (let press = 0; press < PANEL_FILTERS.length - 1; press += 1) panel.handleInput("f");
}

// The remembered page outlives a panel, which is the point of it; each test still
// wants the panel a first-time reader gets.
beforeEach(() => {
  rememberPanelTab("processes");
});
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
    expect(lines[newer]).toContain("· proc running");
    expect(drawn()).toContain("running");
    expect(drawn()).toContain("3.5s");
    expect(drawn()).toContain("1.5 KiB");
    expectNoHexColour(drawn());

    panel.dispose();
  });

  it("explains an empty session instead of drawing a blank box", async () => {
    const { panel, drawn } = openPanel(new FakeSource());
    await panel.settle();

    expect(drawn()).toContain("No processes here");
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
    const { theme, painted } = recordingTheme();
    const { panel, drawn } = openPanel(source, () => 13_000, theme);
    await panel.settle();

    // The drawer paints whatever it was asked to; the render is what asks it.
    expectNoHexColour(drawn());
    // The row's marker and status word take the palette's colour for a failure.
    expect(painted).toContainEqual({ colour: "error", text: "●" });

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
    showAll(panel);
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
    expect(plain(drawn())).toContain("xenon build");
    expect(plain(drawn())).not.toContain("lint ");
    panel.dispose();
  });
});

it("stops every row on the open page on a, one source call per task", async () => {
  const source = new FakeSource();
  source.rows = [view("first1"), view("second"), loopView("loop01")];
  const { panel, drawn } = openPanel(source);
  await panel.settle();

  panel.handleInput("a");
  await panel.settle();

  // `a` acts on what the page lists: the loop keeps running from here (ADR-0012).
  expect(source.stopped.sort()).toEqual(["first1", "second"]);
  expect(drawn()).toContain("stopped 2 tasks");

  panel.dispose();
});

describe("the three pages", () => {
  /** One record of each kind, so every page has something of its own to list. */
  function threeKinds(): FakeSource {
    const source = new FakeSource();
    source.rows = [
      view("bg-build", { name: "web build", createdAt: 1_000 }),
      loopView("lp-review", { name: "nightly review", createdAt: 2_000 }),
      chainView("ch-deploy", { name: "deploy queue", createdAt: 3_000 }),
    ];
    return source;
  }

  it("opens on Processes and lists no other page's root", async () => {
    const { panel, drawn } = openPanel(threeKinds());
    await panel.settle();

    expect(plain(drawn())).toContain("1 Processes");
    expect(drawn()).toContain("web build");
    expect(drawn()).not.toContain("nightly review");
    expect(drawn()).not.toContain("deploy queue");

    panel.dispose();
  });

  it("switches pages on 1, 2 and 3, and washes the open one in the band", async () => {
    const { theme, painted } = recordingTheme();
    const { panel, drawn } = openPanel(threeKinds(), () => 13_000, theme);
    await panel.settle();

    panel.handleInput("2");
    expect(drawn()).toContain("nightly review");
    expect(drawn()).not.toContain("web build");
    // The band washes the open page's label (with its live count) and leaves the
    // others alone.
    const washed = painted
      .filter((stroke) => stroke.colour === "selectedBg")
      .map((stroke) => stroke.text);
    expect(washed.join("")).toContain(" 2 Loops ");
    expect(washed.join("")).not.toContain(" 1 Processes ");

    panel.handleInput("3");
    expect(drawn()).toContain("deploy queue");
    expect(drawn()).not.toContain("nightly review");

    panel.handleInput("1");
    expect(drawn()).toContain("web build");

    panel.dispose();
  });

  it("walks the pages with tab and wraps from the last one to the first", async () => {
    const { panel, drawn } = openPanel(threeKinds());
    await panel.settle();

    panel.handleInput("\t");
    expect(drawn()).toContain("nightly review");
    panel.handleInput("\t");
    expect(drawn()).toContain("deploy queue");
    panel.handleInput("\t");
    expect(drawn()).toContain("web build");

    panel.dispose();
  });

  it("leaves a detail view for the page a tab key names", async () => {
    const { panel, drawn } = openPanel(threeKinds());
    await panel.settle();

    panel.handleInput(ENTER);
    expect(plain(drawn())).toContain("Command:");

    // A tab key leaves any view: the page's list, not its detail, is where it lands.
    panel.handleInput("2");
    expect(drawn()).toContain("nightly review");
    expect(drawn()).not.toContain("web build");
    panel.handleInput(ENTER);
    expect(plain(drawn())).toContain("Schedule:");
    panel.dispose();
  });

  it("reopens on the page the reader left", async () => {
    const first = openPanel(threeKinds());
    await first.panel.settle();
    first.panel.handleInput("3");
    first.panel.dispose();

    const second = openPanel(threeKinds());
    await second.panel.settle();
    expect(second.drawn()).toContain("deploy queue");
    expect(second.drawn()).not.toContain("web build");

    second.panel.dispose();
  });

  it("gives a page with nothing of its kind its own words", async () => {
    const source = new FakeSource();
    source.rows = [view("bg-build", { name: "web build" })];
    const { panel, drawn } = await openOn("chains", source);

    expect(drawn()).toContain("No chains here");

    panel.dispose();
  });

  it("reaches no row of another page, whichever page the query was typed on", async () => {
    const { panel, drawn } = openPanel(threeKinds());
    await panel.settle();

    panel.handleInput("/");
    for (const character of "deploy") panel.handleInput(character);
    // No process row answers to `deploy`, and the chain on another page is not
    // allowed to answer for it either (ADR-0012).
    expect(drawn()).toContain("Nothing on this page matches the search");
    expect(plain(drawn())).not.toContain("deploy queue");

    // Leaving search keeps the query; the page it names is reached by a page key.
    panel.handleInput("\x1bq");
    panel.handleInput("3");
    expect(plain(drawn())).toContain("deploy queue");

    // While the query is being typed, a digit is a character of it, not a page key.
    panel.handleInput("/");
    panel.handleInput("3");
    expect(plain(drawn())).toContain("search: deploy3");

    panel.dispose();
  });

  it("holds the selected row across a refresh and a narrower screen", async () => {
    const source = new FakeSource();
    source.rows = [
      view("bg-aaaaa", { name: "first build", updatedAt: 1_000 }),
      view("bg-bbbbb", { name: "second build", updatedAt: 2_000 }),
      view("bg-ccccc", { name: "third build", updatedAt: 3_000 }),
    ];
    const { panel } = openPanel(source, () => 13_000, plainTheme());
    await panel.settle();

    panel.handleInput(DOWN);
    await panel.settle();
    const selected = (): string | undefined =>
      panel
        .render(WIDTH)
        .find((line) => line.includes("›"))
        ?.split(/\s+/)
        .find((word) => word.startsWith("bg-"));

    expect(selected()).toBe("bg-bbbbb");

    // The store answers in a new order; the reader's row is still the one marked.
    source.rows = [
      source.rows[0] as PanelTaskView,
      { ...(source.rows[1] as PanelTaskView), task: { ...(source.rows[1] as PanelTaskView).task } },
      {
        ...(source.rows[2] as PanelTaskView),
        task: { ...(source.rows[2] as PanelTaskView).task, updatedAt: 50_000 },
      },
    ];
    await panel.refresh();
    expect(selected()).toBe("bg-bbbbb");

    // Narrowing the screen must not reorder a filtered list either.
    const order = (width: number): string[] =>
      panel
        .render(width)
        .filter((line) => line.includes("build"))
        .map((line) => line.split(/\s+/).find((word) => word.startsWith("bg-")) ?? "");
    expect(order(70)).toEqual(order(100));

    panel.dispose();
  });

  it("keeps the selected row on screen when a query lifts it above the scroll", async () => {
    const source = new FakeSource();
    source.rows = Array.from({ length: 13 }, (_, index) =>
      view(`bg-000${String(index).padStart(2, "0")}`, {
        name: `task ${index}`,
        updatedAt: 1_000 + index,
      }),
    );
    source.rows.push(view("bg-00013", { name: "zebra", updatedAt: 1_000 }));
    const { panel, drawn } = openPanel(source, () => 13_000, plainTheme());
    await panel.settle();

    // Walk to the oldest row, which scrolls the list down.
    for (let step = 0; step < 13; step += 1) panel.handleInput(DOWN);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "zeb") panel.handleInput(character);
    await panel.settle();

    const row = drawn()
      .split("\n")
      .find((line) => line.includes("zebra"));
    expect(row).toBeDefined();
    expect(row).toContain("›");
    expect(row).toContain("bg-00013");

    panel.dispose();
  });

  it("hands the recency order back when the query empties, selection unchanged", async () => {
    const source = new FakeSource();
    source.rows = [
      view("bg-aaaaa", { name: "deploy-bg", updatedAt: 1_000 }),
      view("bg-bbbbb", { name: "debug", updatedAt: 9_000 }),
    ];
    const { panel } = openPanel(source, () => 13_000, plainTheme());
    await panel.settle();

    const order = (): string[] =>
      panel
        .render(WIDTH)
        .filter((line) => line.includes("bg-"))
        .map((line) => line.split(/\s+/).find((word) => word.startsWith("bg-")) ?? "");
    expect(order()).toEqual(["bg-bbbbb", "bg-aaaaa"]);

    // Hold the older row, then let a query that prefers it rewrite the order.
    panel.handleInput(DOWN);
    await panel.settle();
    panel.handleInput("/");
    for (const character of "dbg") panel.handleInput(character);
    await panel.settle();

    // Deleting the query must not reshuffle the list around the held selection.
    for (let step = 0; step < 3; step += 1) panel.handleInput("\u007f");
    await panel.settle();

    expect(order()).toEqual(["bg-bbbbb", "bg-aaaaa"]);
    const selected = panel
      .render(WIDTH)
      .find((line) => line.includes("›"))
      ?.split(/\s+/)
      .find((word) => word.startsWith("bg-"));
    expect(selected).toBe("bg-aaaaa");

    panel.dispose();
  });
});

describe("loop tasks in the list", () => {
  it("draws a loop row with its fire count and next fire, and no output size", async () => {
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
    const { panel, drawn } = await openOn("loops", source);

    const lines = drawn().split("\n");
    const loopRow = lines.find((line) => line.includes("review loop"));
    if (loopRow === undefined) throw new Error("the loop row must render");

    // A loop keeps no output file, so its row carries the schedule's numbers; the
    // dropped iterations and the last fire's wall-clock time live in the detail.
    expect(loopRow).toContain("llm");
    expect(loopRow).toContain("5 fires");
    expect(loopRow).toContain("next 4.0s");
    expect(loopRow).not.toContain("KiB");
    // The process belongs to its own page, which is where its size is drawn.
    expect(drawn()).not.toContain("nightly build");

    panel.dispose();
  });

  it("opens a loop without asking the source for an output tail", async () => {
    const source = new FakeSource();
    source.rows = [loopView("loop01", { name: "review loop" })];
    const { panel } = await openOn("loops", source);

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
    const { panel, drawn } = await openOn("loops", source);
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();

    const screen = drawn();
    expect(screen).toContain("review loop");
    expect(screen).toContain("prompt-loop");
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
    const { panel, drawn } = await openOn("loops", source);
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
    const { panel, drawn } = await openOn("loops", source);
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();
    panel.handleInput(ENTER);
    await panel.settle();

    const screen = drawn();
    expect(screen).toContain("fire 1");
    expect(screen.indexOf("npm test")).toBeLessThan(screen.indexOf("src/index.ts"));
    expect(screen.indexOf("src/index.ts")).toBeLessThan(screen.indexOf("npm run lint"));
    expect(screen).toContain("npm test");
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
    const { panel, drawn } = await openOn("loops", source);
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
    const { panel, drawn } = await openOn("loops", source);
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
    const { panel, drawn } = await openOn("loops", source);
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
  it("tallies every ending above the rows, whatever the page or filter hides", async () => {
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
      expect(header).toContain(label);
    }

    // The filter narrows the rows, never the tally: with `failed` on, only `lint`
    // is listed and the header still names all five endings (ADR-0012).
    panel.handleInput("f");
    expect(plain(drawn())).toContain("filter: failed");
    expect(drawn()).toContain("lint");
    expect(drawn()).not.toContain("server");

    panel.dispose();
  });
});

describe("the status filter", () => {
  /** One row per ending the filter has to tell apart, plus a paused schedule. */
  function byStatus(): FakeSource {
    const source = new FakeSource();
    source.rows = [
      view("run0001", { name: "server", status: "running" }),
      view("done001", { name: "build", status: "completed", exitCode: 0 }),
      view("bad0001", { name: "lint", status: "failed" }),
      view("slow001", { name: "deploy", status: "killed", killReason: "timeout" }),
      view("kill001", { name: "watch", status: "killed", killReason: "user" }),
      loopView("loop01", { name: "review loop", status: "paused" }),
    ];
    return source;
  }

  it("walks all, running, failed and done on f, and names the filter in the header", async () => {
    const { panel, drawn } = openPanel(byStatus());
    await panel.settle();

    // `running` is where the panel opens: the past is one keypress group away.
    expect(plain(drawn())).toContain("filter: running");
    expect(drawn()).toContain("server");
    expect(drawn()).not.toContain("lint");

    panel.handleInput("f");
    expect(plain(drawn())).toContain("filter: failed");
    expect(drawn()).toContain("lint");
    expect(drawn()).not.toContain("server");

    // A killed task finished without failing, so it is done, not failed.
    panel.handleInput("f");
    expect(plain(drawn())).toContain("filter: done");
    expect(drawn()).toContain("watch");
    expect(drawn()).toContain("deploy");
    expect(drawn()).toContain("build");
    expect(drawn()).not.toContain("lint");

    panel.handleInput("f");
    expect(plain(drawn())).toContain("filter: all");
    expect(drawn()).toContain("build");

    panel.dispose();
  });

  it("narrows a query by the status filter it is paired with", async () => {
    const source = new FakeSource();
    source.rows = [
      view("bg-aaaaa", { name: "deploy east", status: "running" }),
      view("bg-bbbbb", { name: "deploy west", status: "failed", exitCode: 1 }),
    ];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "dpl") panel.handleInput(character);
    // The panel opens on `running`, so the failed row is hidden until the filter
    // asks for it; the query keeps narrowing whatever the filter lets through.
    expect(plain(drawn())).toContain("deploy east");
    expect(plain(drawn())).not.toContain("deploy west");

    // Leaving search keeps the query; `f` then walks the filter under it.
    panel.handleInput("\x1bq");
    expect(plain(drawn())).toContain("deploy east");
    expect(plain(drawn())).not.toContain("deploy west");

    panel.handleInput("f");
    expect(plain(drawn())).toContain("deploy west");
    expect(plain(drawn())).not.toContain("deploy east");

    panel.dispose();
  });

  it("counts a paused schedule as running, since it is still owed a turn", async () => {
    const { panel, drawn } = await openOn("loops", byStatus());

    expect(drawn()).toContain("review loop");
    expect(drawn()).toContain("filter: running");
    expect(drawn()).not.toContain("Nothing");

    panel.dispose();
  });

  it("keeps the filter inside the page it was set on", async () => {
    const { panel, drawn } = await openOn("loops", byStatus());
    expect(drawn()).toContain("review loop");

    panel.handleInput("f");
    panel.handleInput("f");
    // Done: the paused loop is not done, so the page empties.
    expect(drawn()).toContain("Nothing here matches this status");

    // Processes are untouched by a filter set on the loops page.
    panel.handleInput("1");
    expect(drawn()).toContain("filter: done");
    expect(drawn()).toContain("build");
    expect(drawn()).not.toContain("server");

    panel.dispose();
  });

  it("keeps a chain under running while its steps run, and under done once they end", async () => {
    const source = new FakeSource();
    source.rows = [
      chainView("ch-run01", { name: "ship it" }),
      chainView("ch-done1", { name: "old news", status: "completed" }),
    ];
    const { panel, drawn } = await openOn("chains", source);

    expect(drawn()).toContain("ship it");
    expect(drawn()).not.toContain("old news");

    // Failed, then done: the finished queue is the only one left on the page.
    panel.handleInput("f");
    panel.handleInput("f");
    expect(drawn()).toContain("old news");
    expect(drawn()).not.toContain("ship it");

    panel.dispose();
  });
});
describe("rerun and the output path", () => {
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
    const { panel, drawn } = await openOn("loops", source);

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

  /**
   * A command loop with one finished fire, plus the child record that fire started.
   * The child is listed separately, as the store lists it: a detail page resolves it
   * by id and no page of the list ever shows it (ADR-0014).
   */
  function loopWithFire(): FakeSource {
    const source = new FakeSource();
    source.rows = [
      cmdLoopView(
        "lc00001",
        { name: "watch loop", fires: 45, fireHistory: [fireOf(44), fireOf(45)] },
        30_000,
        5_000,
      ),
      view("bg-00045", {
        name: "watch loop #45",
        parentId: "lc00001",
        fire: 45,
        createdAt: CLOCK,
      }),
    ];
    return source;
  }

  /** Walk to a fire's own detail page: the list, the loop, then the newest fire. */
  async function openFireDetail(source: FakeSource): Promise<Opened> {
    const opened = await openOn("loops", source);
    await opened.panel.settle();
    opened.panel.handleInput(ENTER);
    await opened.panel.settle();
    opened.panel.handleInput(ENTER);
    await opened.panel.settle();
    return opened;
  }

  it("reruns the fire whose detail page is open, not the loop around it", async () => {
    const source = loopWithFire();
    const { panel, drawn } = await openFireDetail(source);

    panel.handleInput("R");
    await panel.settle();

    // The page belongs to the fire, so the key does too.
    expect(source.reran).toEqual(["bg-00045"]);
    expect(drawn()).toContain("ran bg-00045 again as bg-000452");
    expect(drawn()).not.toContain("A loop is scheduled, not run");

    panel.dispose();
  });

  it("prints the open fire's own output path with c", async () => {
    const source = loopWithFire();
    const { panel, drawn } = await openFireDetail(source);

    panel.handleInput("c");
    await panel.settle();

    expect(drawn()).toContain("output: /work/.pi/tasks/session/bg-00045.output");
    expect(drawn()).not.toContain("a loop writes no output file");

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

  it("filters the page by a command substring as the query is typed", async () => {
    const source = searchFixture();
    const { theme, painted } = recordingTheme();
    const { panel, drawn } = openPanel(source, () => 13_000, theme);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "build") panel.handleInput(character);

    expect(plain(drawn())).toContain("search: build");
    expect(drawn()).toContain("web build");
    expect(drawn()).not.toContain("unit tests");
    // The counts still cover every task: the failed lint run is out of the query,
    // not out of the tally.
    expect(painted.some(({ colour }) => colour === "error")).toBe(true);

    panel.dispose();
  });

  it("matches a query as an in-order subsequence, not as a substring", async () => {
    const source = new FakeSource();
    source.rows = [
      view("bg-aaaaa", { name: "deploy-bg", createdAt: 1_000 }),
      view("bg-bbbbb", { name: "build-test", createdAt: 2_000 }),
      view("bg-ccccc", { name: "unit tests", createdAt: 3_000 }),
    ];
    const { panel, drawn } = openPanel(source, () => 13_000, plainTheme());
    await panel.settle();

    panel.handleInput("/");
    for (const character of "dbg") panel.handleInput(character);

    // `dbg` sits inside `deploy-bg` one letter at a time; no field of the other
    // two rows carries the three letters in order.
    expect(drawn()).toContain("deploy-bg");
    expect(drawn()).not.toContain("build-test");
    expect(drawn()).not.toContain("unit tests");

    for (let index = 0; index < 3; index += 1) panel.handleInput(BACKSPACE);
    for (const character of "bldt") panel.handleInput(character);

    // Neither `bldt` nor `bt` is a substring of `build-test`.
    expect(drawn()).toContain("build-test");
    expect(drawn()).not.toContain("deploy-bg");

    panel.dispose();
  });

  it("ranks a tight match above a scattered one, whatever the recency", async () => {
    const source = new FakeSource();
    source.rows = [
      // The scattered match is the newer row, so recency alone would keep it on top.
      view("bg-aaaaa", { name: "debug", updatedAt: 9_000 }),
      view("bg-bbbbb", { name: "deploy-bg", updatedAt: 1_000 }),
    ];
    const { panel, drawn } = openPanel(source, () => 13_000, plainTheme());
    await panel.settle();
    const rowLine = (id: string): number =>
      drawn()
        .split("\n")
        .findIndex((line) => line.includes(id));
    expect(rowLine("bg-aaaaa")).toBeLessThan(rowLine("bg-bbbbb"));

    panel.handleInput("/");
    for (const character of "dbg") panel.handleInput(character);

    // `bg` sits together in `deploy-bg` and `b` starts a word; `debug` has all
    // three letters, but scattered through the name.
    expect(rowLine("bg-bbbbb")).toBeLessThan(rowLine("bg-aaaaa"));

    panel.dispose();
  });

  it("prefers the shorter field when two matches are as tight", async () => {
    const source = new FakeSource();
    source.rows = [
      view("bg-aaaaa", { name: "build-logs-archive", updatedAt: 9_000 }),
      view("bg-bbbbb", { name: "build", updatedAt: 1_000 }),
    ];
    const { panel, drawn } = openPanel(source, () => 13_000, plainTheme());
    await panel.settle();
    const rowLine = (id: string): number =>
      drawn()
        .split("\n")
        .findIndex((line) => line.includes(id));

    panel.handleInput("/");
    for (const character of "build") panel.handleInput(character);

    expect(rowLine("bg-bbbbb")).toBeLessThan(rowLine("bg-aaaaa"));

    panel.dispose();
  });

  it("lights the characters it matched, and only those, inside the row", async () => {
    const source = new FakeSource();
    source.rows = [view("bg-aaaaa", { name: "deploy-bg" })];
    const { theme, painted } = recordingTheme();
    const { panel, drawn } = openPanel(source, () => 13_000, theme);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "dbg") panel.handleInput(character);

    const row = drawn()
      .split("\n")
      .find((line) => line.includes("bg-aaaaa"));
    expect(row).toBeDefined();
    expect(painted).toContainEqual({ colour: "accent", text: "d" });
    expect(painted).toContainEqual({ colour: "accent", text: "bg" });
    // The characters between matches keep the name's own colour.
    expect(painted).toContainEqual({ colour: "text", text: "eploy-" });
    expect(row).toContain("deploy-bg");

    panel.dispose();
  });

  it("finds a row by its id", async () => {
    const source = searchFixture();
    const { panel, drawn } = openPanel(source);
    await panel.settle();
    // The fixture keeps a failed row, which the opening `running` filter would hide.
    showAll(panel);

    panel.handleInput("/");
    for (const character of "a1b") panel.handleInput(character);

    // Every id starts `bg-`, so a fuzzy query has to name the part that differs.
    expect(drawn()).toContain("web build");
    expect(drawn()).not.toContain("unit tests");
    expect(drawn()).not.toContain("lint run");

    panel.dispose();
  });

  it("never turns a fire into a row, however well the query fits it", async () => {
    const source = new FakeSource();
    source.rows = [
      view("bg-aaaaa", {
        name: "build",
        status: "completed",
        exitCode: 0,
        command: "npm run build",
      }),
      // The failing fire of some command loop: a record, not a row (ADR-0014).
      view("bg-bbbbb", {
        name: "watch loop #1",
        parentId: "lc00001",
        fire: 1,
        command: "deploy deploy",
        status: "completed",
        exitCode: 0,
      }),
    ];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "deploy") panel.handleInput(character);

    expect(drawn()).toContain("Nothing on this page matches the search");

    panel.dispose();
  });

  it("says so when the hit came from a command the row never prints", async () => {
    const source = new FakeSource();
    source.rows = [view("bg-aaaaa", { name: "build", command: "make deploy" })];
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "deploy") panel.handleInput(character);

    const row = drawn()
      .split("\n")
      .find((line) => line.includes("bg-aaaaa"));
    expect(row).toBeDefined();
    expect(plain(row ?? "")).toContain("via command");
    // The note is the row's own admission; there is nothing on the row to light.
    expect(row).not.toContain("<bold><accent>deploy</accent></bold>");

    panel.dispose();
  });

  it("says so when the hit came from a loop's prompt", async () => {
    const source = new FakeSource();
    source.rows = [loopView("lc00001", { name: "nightly", prompt: "review the diff" })];
    const { panel, drawn } = await openOn("loops", source);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "diff") panel.handleInput(character);

    const row = drawn()
      .split("\n")
      .find((line) => line.includes("lc00001"));
    expect(row).toBeDefined();
    expect(plain(row ?? "")).toContain("via prompt");

    panel.dispose();
  });

  it("says so when a chain's own name is the only word the query hit", async () => {
    const source = new FakeSource();
    source.rows = [
      chainView("ch-abcde", { name: "nightly", steps: ["bg-00001"], cursor: 0 }),
      view("bg-00001", { name: "deploy", parentId: "ch-abcde" }),
    ];
    const { panel, drawn } = await openOn("chains", source);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "night") panel.handleInput(character);

    const row = drawn()
      .split("\n")
      .find((line) => line.includes("ch-abcde"));
    expect(row).toBeDefined();
    // The row spends its name column on the queue, so `nightly` is not on it.
    expect(plain(row ?? "")).toContain("deploy");
    expect(plain(row ?? "")).toContain("via name");

    panel.dispose();
  });

  it("filters by the kind word the row shows, so an prompt loop answers to llm", async () => {
    const source = new FakeSource();
    source.rows = [
      loopView("lp-abcde", { name: "nightly review", createdAt: 2_000 }),
      cmdLoopView("lc-abcde", { name: "nightly probe", createdAt: 1_000 }),
    ];
    const { panel, drawn } = await openOn("loops", source);

    panel.handleInput("/");
    for (const character of "llm") panel.handleInput(character);

    expect(drawn()).toContain("nightly review");
    expect(drawn()).not.toContain("nightly probe");
  });

  it("finds a row by the status word it draws, and by no word it does not", async () => {
    const source = searchFixture();
    const { panel, drawn } = openPanel(source);
    await panel.settle();
    // The fixture keeps a failed row, which the opening `running` filter would hide.
    showAll(panel);
    panel.handleInput("/");
    for (const character of "failed") panel.handleInput(character);

    // The status word is printed in the row's status column, so it is a fair
    // thing to type; nothing reaches a row by a word the row never shows.
    expect(plain(drawn())).toContain("search: failed");
    expect(drawn()).toContain("lint run");
    expect(drawn()).not.toContain("web build");
  });

  it("turns a pasted command into a one-line query", async () => {
    const source = searchFixture();
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("/");
    panel.handleInput("\x1b[200~npm test\nnpm run lint\x1b[201~");

    expect(plain(drawn())).toContain("search: npm test npm run lint");
    expect(plain(drawn())).not.toContain("search: npm test\n");

    panel.dispose();
  });

  it("edits the query with backspace", async () => {
    const source = searchFixture();
    const { panel, drawn } = openPanel(source);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "build") panel.handleInput(character);
    panel.handleInput(BACKSPACE);

    expect(plain(drawn())).toContain("search: buil");
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
    expect(plain(drawn())).toContain("search: build");
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
    const { panel, drawn } = await openOn("loops", source, () => 13_000, theme);
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
    const { panel } = await openOn("loops", source, () => 13_000, plainTheme());
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

  it("shows a command loop's failure streak and its backoff, and keeps the schedule as written", async () => {
    const source = new FakeSource();
    source.rows = [
      cmdLoopView(
        "lc00001",
        {
          name: "watch loop",
          schedule: "10s",
          nextFireAt: CLOCK + 40 * 60_000,
          fires: 5,
          consecutiveFailures: 3,
          missedFires: 1,
          fireHistory: [
            fireOf(4, { outcome: "failed", exitCode: 1 }),
            fireOf(5, { outcome: "skipped", exitCode: undefined }),
          ],
        },
        30_000,
        40 * 60_000,
      ),
    ];
    const { panel, drawn } = await openOn("loops", source, () => 13_000, plainTheme());
    await panel.settle();

    const rowAt = (width: number): string => {
      const line = panel.render(width).find((candidate) => candidate.includes("watch loop"));
      if (line === undefined) throw new Error("the loop row must render");
      return line;
    };
    // A hundred columns is tight: the streak and the wait fit and the strip keeps its
    // cells, so the label saying the wait is a backoff is the first thing to go.
    const row = rowAt(WIDTH);
    expect(row).toContain("3 failed");
    expect(row).toContain(`next ${formatDuration(40 * 60_000)}`);
    expect(row).toContain("#4✗");
    expect(row).toContain("#5–");
    // Whatever it sheds, the row stays inside the frame instead of pushing it wide.
    for (const line of panel.render(WIDTH)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
    }
    // A wider screen has room for the word, and the wait is then labelled as what it
    // is: the schedule pushed out by the streak, not the schedule as written.
    expect(rowAt(120)).toContain(`next ${formatDuration(40 * 60_000)} (backoff)`);
    // The raw expression is not rewritten into the delay: the row never shows it,
    // and the detail still prints the schedule the user typed.
    expect(row).not.toContain("10s");

    panel.handleInput(ENTER);
    await panel.settle();
    const screen = plain(drawn());
    expect(screen).toContain("Schedule:");
    expect(screen).toContain("10s");
    expect(screen).toContain("Failures:");
    expect(screen).toContain("3 in a row");
    // The skipped fire is counted where the fires are counted, not only as a glyph.
    expect(screen).toContain("1 skipped");
    expect(screen).toContain("backoff");
    panel.dispose();

    // A healthy loop says nothing about failures.
    const healthySource = new FakeSource();
    healthySource.rows = [
      cmdLoopView("lc00002", { name: "healthy loop", fires: 2 }, 30_000, 10_000),
    ];
    const healthyPanel = await openOn("loops", healthySource, () => 13_000, plainTheme());
    await healthyPanel.panel.settle();
    const healthy = healthyPanel
      .drawn()
      .split("\n")
      .find((line) => line.includes("healthy loop"));
    if (healthy === undefined) throw new Error("the healthy row must render");
    expect(healthy).toContain(`next ${formatDuration(10_000)}`);
    expect(healthy).not.toContain("failed");
    expect(healthy).not.toContain("backoff");
    healthyPanel.panel.dispose();
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
    const { panel, drawn } = await openOn("loops", source);
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
    const { panel, drawn } = await openOn("loops", source);
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
    const first = await openOn("loops", byCommand);
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
    const second = await openOn("loops", byKind);
    await second.panel.settle();

    second.panel.handleInput("/");
    for (const character of "cmd") second.panel.handleInput(character);
    await second.panel.settle();
    expect(second.drawn()).toContain("nightly probe");
    expect(second.drawn()).toContain("nightly review");
    second.panel.dispose();
  });
});

describe("chains in the list and in the detail", () => {
  const CHAIN = "ch-abcde";

  /**
   * One chain of three steps as the store keeps them: the steps are ordinary process
   * records with a `parentId`, so the panel resolves them by id and never lists them
   * as rows of their own (ADR-0014).
   */
  function chainOf(names: readonly string[] = ["build", "deploy", "smoke"]): PanelTaskView[] {
    const ids = names.map((_, index) => `bg-0000${String(index + 1)}`);
    const steps = names.map((name, index) =>
      view(
        ids[index] ?? "bg-00000",
        {
          name,
          parentId: CHAIN,
          status: index === 0 ? "completed" : index === 1 ? "running" : "waiting",
          createdAt: 1_000 + index * 2_000,
          updatedAt: 3_000 + index * 2_000,
          ...(index === 0 ? { exitCode: 0, endedAt: 3_000 } : {}),
        },
        3_000,
      ),
    );
    return [
      chainView(
        CHAIN,
        { name: "build", steps: ids, cursor: 1, createdAt: 1_000, updatedAt: 5_000 },
        12_000,
      ),
      ...steps,
    ];
  }

  it("draws a chain as one row of steps, the running one in the accent colour", async () => {
    const source = new FakeSource();
    source.rows = chainOf();
    const { theme, painted } = recordingTheme();
    const { panel, drawn } = await openOn("chains", source, () => 13_000, theme);
    await panel.settle();

    const lines = panel
      .render(WIDTH)
      .join("\n")
      .split("\n")
      .filter((line) => line.includes("build → deploy → smoke"));
    expect(lines).toHaveLength(1);
    // The chain is one row: its steps never get rows of their own.
    expect(drawn()).not.toContain("bg-00002");
    expect(drawn()).not.toContain("1/3");
    expect(drawn()).toContain("2/3");
    // The step being worked on is the one the page points at.
    expect(painted).toContainEqual({ colour: "accent", text: "deploy" });
    expect(painted).toContainEqual({ colour: "success", text: "build" });
    expect(painted).toContainEqual({ colour: "muted", text: "smoke" });

    panel.dispose();
  });

  it("sheds the finished steps on a narrow row and keeps the running one", async () => {
    const source = new FakeSource();
    source.rows = chainOf(["compile assets", "deploy edge", "smoke test"]);
    const { panel } = await openOn("chains", source, () => 13_000, plainTheme());
    await panel.settle();

    const narrow = panel.render(70).join("\n");
    expect(narrow).toContain("deploy edge");
    expect(narrow).not.toContain("compile assets");
    expect(narrow).toContain("…");
    // Nothing wraps: every line still fits the width it was given.
    for (const line of panel.render(70)) expect(visibleWidth(line)).toBeLessThanOrEqual(70);

    panel.dispose();
  });

  it("opens the chain detail on its steps, in run order, with what each ended with", async () => {
    const source = new FakeSource();
    source.rows = chainOf();
    const { panel, drawn } = await openOn("chains", source, () => 13_000, plainTheme());
    await panel.settle();

    panel.handleInput(ENTER);
    await panel.settle();

    const text = drawn();
    expect(text).toContain("chain: build");
    expect(text).toContain("1 of 3 done · step 2 of 3");
    const build = text.indexOf("1. build");
    const deploy = text.indexOf("2. deploy");
    const smoke = text.indexOf("3. smoke");
    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(deploy);
    expect(deploy).toBeLessThan(smoke);
    // Every line carries its status, its duration and, where it has one, its exit code.
    expect(text).toMatch(/1\. build\s+completed\s+2\.0s\s+exit 0/);
    expect(text).toMatch(/2\. deploy\s+running\s+10\.0s\b/);
    // A step that has not run yet has no duration and no exit code to report.
    expect(text).toMatch(/3\. smoke\s+waiting\s+—/);

    panel.dispose();
  });

  it("stops the whole chain from the running step on k, never a step of its own", async () => {
    const source = new FakeSource();
    source.rows = chainOf();
    const { panel, source: fake, drawn } = await openOn("chains", source);
    await panel.settle();

    panel.handleInput("k");
    await panel.settle();

    expect(fake.stopped).toEqual([CHAIN]);
    expect(drawn()).toContain(`stopped ${CHAIN}`);
    expect(fake.stopped).not.toContain("bg-00002");

    panel.dispose();
  });

  it("refuses to rerun a chain and to name an output file it does not have", async () => {
    const source = new FakeSource();
    source.rows = chainOf();
    const { panel, drawn } = await openOn("chains", source);
    await panel.settle();

    panel.handleInput("R");
    await panel.settle();
    expect(drawn()).toContain("A chain is a queue; run its steps again with bg_run.");
    expect(source.reran).toEqual([]);

    panel.handleInput("c");
    await panel.settle();
    expect(drawn()).toContain("a chain writes no output of its own");

    panel.dispose();
  });

  it("finds a chain by a step name its row shows, and by no word it leaves out", async () => {
    const source = new FakeSource();
    source.rows = chainOf().map((row) =>
      row.task.kind === "process" && row.task.name === "deploy"
        ? { ...row, task: { ...row.task, command: "curl -sf https://edge" } }
        : row,
    );
    const { panel, drawn } = await openOn("chains", source, () => 13_000, plainTheme());
    await panel.settle();

    panel.handleInput("/");
    for (const character of "deploy") panel.handleInput(character);
    await panel.settle();
    expect(drawn()).toContain("build → deploy → smoke");

    // A step's command is not on the row, so it must not bring the row back.
    for (let index = 0; index < "deploy".length; index += 1) panel.handleInput("\u007f");
    for (const character of "curl") panel.handleInput(character);
    await panel.settle();
    expect(drawn()).toContain("Nothing on this page matches the search");
    expect(drawn()).not.toContain("build → deploy → smoke");

    panel.dispose();
  });

  it("lights the matched step inside a chain's column", async () => {
    const source = new FakeSource();
    source.rows = chainOf();
    const { theme, painted } = recordingTheme();
    const { panel, drawn } = await openOn("chains", source, () => 13_000, theme);
    await panel.settle();

    panel.handleInput("/");
    for (const character of "smo") panel.handleInput(character);

    const row = drawn()
      .split("\n")
      .find((line) => line.includes("ch-abcde"));
    expect(row).toBeDefined();
    // `smoke` is a waiting step, so its own colour is muted; only the query's
    // characters take the accent.
    expect(painted).toContainEqual({ colour: "accent", text: "smo" });
    expect(painted).toContainEqual({ colour: "muted", text: "ke" });
    expect(row).toContain("build → deploy → smoke");

    panel.dispose();
  });

  it("counts a fire the pages never give a row, as ADR 0014 asks", async () => {
    const source = new FakeSource();
    source.rows = [
      view("bg-aaaaa", { name: "server", status: "running" }),
      view("bg-bbbbb", { name: "unit tests", status: "completed", exitCode: 0 }),
      // The failing fire of some command loop: a record, not a row.
      view("bg-ccccc", {
        name: "watch loop #7",
        parentId: "lc00001",
        fire: 7,
        status: "failed",
        exitCode: 1,
      }),
    ];
    const { panel, drawn } = await openOn("processes", source, () => 13_000, plainTheme());
    await panel.settle();

    expect(drawn()).toContain("Failed 1");
    expect(drawn()).toContain("Running 1");
    expect(drawn()).not.toContain("watch loop #7");

    panel.dispose();
  });
});

describe("the other sessions sharing a checkout", () => {
  const STRANGER = "7f2c9d10-4b3a-4e55-9a01-6c7d8e9f0a1b";

  /**
   * One session's row of its own, and one root another session left in the same
   * checkout: `o` is the only key that brings the second into view (ticket #27).
   */
  function twoSessions(): FakeSource {
    const source = new FakeSource();
    source.rows = [view("bg-a1b2c", { name: "web build" })];
    source.otherRows = [{ ...view("bg-x1x2x", { name: "deploy the edge" }), sessionId: STRANGER }];
    return source;
  }

  it("keeps another session's rows off the page until o asks for them", async () => {
    const source = twoSessions();
    const { panel, drawn } = await openOn("processes", source, () => 13_000, plainTheme());
    await panel.settle();

    expect(drawn()).not.toContain("deploy the edge");
    // The counts speak for this session only: another session's run is not ours.
    expect(drawn()).toContain("Running 1");

    panel.handleInput("o");
    await panel.settle();
    const revealed = drawn();
    expect(revealed).toContain("deploy the edge");
    // The row is tagged with the session it came from, shortened to fit a column.
    expect(revealed).toContain("@7f2c9d");
    expect(revealed).toContain("Running 1");

    panel.handleInput("o");
    await panel.settle();
    expect(drawn()).not.toContain("deploy the edge");

    panel.dispose();
  });

  it("lets a query reach another session's row only behind o", async () => {
    const source = twoSessions();
    const { panel, drawn } = await openOn("processes", source, () => 13_000, plainTheme());
    await panel.settle();

    panel.handleInput("/");
    for (const character of "dpl") panel.handleInput(character);
    await panel.settle();
    // The row exists, but `o` is what makes it part of this page.
    expect(drawn()).toContain("Nothing on this page matches the search");

    panel.handleInput("\x1bq");
    panel.handleInput("o");
    await panel.settle();
    expect(drawn()).toContain("deploy the edge");
    expect(drawn()).not.toContain("web build");

    panel.dispose();
  });

  it("stops and reruns nothing on another session's row", async () => {
    const source = twoSessions();
    const { panel, drawn } = await openOn("processes", source, () => 13_000, plainTheme());
    await panel.settle();

    panel.handleInput("o");
    await panel.settle();
    panel.handleInput(DOWN);
    panel.handleInput("k");
    await panel.settle();
    expect(source.stopped).toEqual([]);
    expect(drawn()).toContain("another session's task is read-only here");

    panel.handleInput("R");
    await panel.settle();
    expect(source.reran).toEqual([]);

    // Nor does "stop all" reach across: only this session's own row stops.
    panel.handleInput("a");
    await panel.settle();
    expect(source.stopped).toEqual(["bg-a1b2c"]);

    panel.dispose();
  });

  it("names the whole session in the detail and reads its output from there", async () => {
    const source = twoSessions();
    source.tails.set("bg-x1x2x", { text: "edge ok", lines: 1, truncated: false });
    const { panel, drawn } = await openOn("processes", source, () => 13_000, plainTheme());
    await panel.settle();

    panel.handleInput("o");
    await panel.settle();
    panel.handleInput(DOWN);
    panel.handleInput(ENTER);
    await panel.settle();

    const text = drawn();
    expect(text).toContain("deploy the edge");
    // A six-character tag cannot be the whole truth, so the detail spells it out.
    expect(text).toContain(STRANGER);
    expect(source.tailed).toContain("bg-x1x2x");
    expect(source.tailedFrom).toContain(STRANGER);

    panel.dispose();
  });
});

/**
 * One render, with the proof that not a single line crossed the width it was given.
 * The narrow width is the one ADR-0017 holds the panel to.
 */
function expectFits(panel: TasksPanel, width: number): readonly string[] {
  const lines = panel.render(width);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  return lines;
}

describe("the frame never draws past the terminal", () => {
  const NARROW = 70;

  it("keeps a long row inside 70 columns and holds its shape", async () => {
    const source = new FakeSource();
    source.rows = [
      view("bg-a1b2c", {
        name: "a background build whose name runs well past the border",
        status: "running",
      }),
    ];
    const { panel } = openPanel(source, () => 13_000, plainTheme());
    await panel.settle();

    const lines = expectFits(panel, NARROW);
    const row = lines.find((line) => line.includes("›"));
    expect(row).toBeDefined();
    // Border, marker, border: the name gives way, the row does not.
    expect(row?.startsWith("│")).toBe(true);
    expect(row?.endsWith("│")).toBe(true);
    expect(row).toContain("bg-a1b2c");
    expect(row).toContain("running");

    panel.dispose();
  });

  it("cuts a detail page's title and drops the keys that cannot fit", async () => {
    const source = new FakeSource();
    source.rows = [
      view("bg-a1b2c", {
        name: "a process whose name is long enough to cross the border of any terminal",
        command: "npm run build -- --mode production --watch --poll --no-cache --verbose",
      }),
    ];
    const { panel } = openPanel(source, () => 13_000, plainTheme());
    await panel.settle();
    panel.handleInput(ENTER);
    await panel.settle();

    const text = expectFits(panel, NARROW).join("\n");
    expect(text).toContain("…");
    // A shortened footer is still a whole list of keys, never one cut mid-word.
    expect(text).toContain("← list");
    expect(text).toContain("alt+q");

    panel.dispose();
  });

  it("keeps a page's empty state inside 70 columns", async () => {
    const source = new FakeSource();
    const { panel } = await openOn("loops", source, () => 13_000, plainTheme());
    await panel.settle();

    const text = expectFits(panel, NARROW).join("\n");
    expect(text).toContain("No loops here");
    expect(text).toContain("…");

    panel.dispose();
  });

  it("keeps a search result and an empty search inside 70 columns", async () => {
    const source = new FakeSource();
    source.rows = [
      view("bg-a1b2c", {
        name: "a web build whose name runs well past the border of the panel",
        command: "npm run build",
      }),
    ];
    const { panel } = openPanel(source, () => 13_000, plainTheme());
    await panel.settle();

    panel.handleInput("/");
    for (const character of "build") panel.handleInput(character);
    let text = expectFits(panel, NARROW).join("\n");
    expect(text).toContain("search: build");
    // The hit keeps its id and its numbers; the name gives way, as on every row.
    expect(text).toContain("bg-a1b2c");
    expect(text).not.toContain("runs well past the border");

    for (const character of "zzz") panel.handleInput(character);
    text = expectFits(panel, NARROW).join("\n");
    expect(text).toContain("Nothing on this page matches the search");

    panel.dispose();
  });

  it("keeps an iteration page inside 70 columns", async () => {
    const source = new FakeSource();
    source.rows = [
      loopView("loop01", {
        name: "review loop",
        fires: 1,
        iterations: [
          iterationOf(1, [
            callOf("call-1", "bash", "npm test -- --reporter=verbose --runInBand --silent"),
          ]),
        ],
      }),
    ];
    const { panel } = await openOn("loops", source, () => 13_000, plainTheme());
    await panel.settle();
    panel.handleInput(ENTER);
    await panel.settle();
    panel.handleInput(ENTER);
    await panel.settle();

    const text = expectFits(panel, NARROW).join("\n");
    expect(text).toContain("calls");

    panel.dispose();
  });

  it("drops a row's numbers rather than pushing the border wider", async () => {
    const source = new FakeSource();
    source.rows = [loopView("loop01", { name: "review loop", fires: 45 }, 30_000, 40 * 60_000)];
    const { panel } = await openOn("loops", source, () => 13_000, plainTheme());
    await panel.settle();

    expect(panel.render(120).join("\n")).toContain("45 fires");

    // Every width keeps the invariant; the numbers go before the row does.
    for (const width of [70, 60, 50, 44, 38]) expectFits(panel, width);
    const narrow = panel.render(38).join("\n");
    expect(narrow).not.toContain("45 fires");
    expect(narrow).toContain("review loop");

    panel.dispose();
  });
});
