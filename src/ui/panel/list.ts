/**
 * The list page: its header, page band, counts, rows and the frame around them.
 * Pure drawing over the panel's state — nothing here reads a file, signals a
 * process or moves a selection, so a renderer can be read on its own.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ChainTask, CmdLoopTask, Task } from "../../tasks/base/task.js";
import { STATUS_COLOUR } from "../status-colour.js";
import {
  dotColour,
  exitText,
  FIRE_COLOUR,
  FIRE_MARK,
  kindWord,
  nameColour,
  rightText,
  signalWord,
  stepColour,
} from "./format.js";
import { fittedFooter, LIST_KEYS, pad } from "./keys.js";
import {
  ID_COLUMN_WIDTH,
  listWindow,
  PANEL_TABS,
  type PanelTab,
  type PanelTaskView,
  STRIP_CELLS,
  TAB_EMPTY,
  TAB_TITLE,
} from "./model.js";
import type { MatchField } from "./query.js";
import { inTab } from "./row-filter.js";
import type { PanelView } from "./view.js";

export function renderList(panel: PanelView, width: number): string[] {
  const theme = panel.theme;
  const inner = Math.max(1, width - 2);
  const body: string[] = [];

  if (panel.rows.length === 0) {
    // An empty page says which of the three reasons emptied it: nothing of that
    // kind, a status filter that keeps nothing, or a query that matches no row.
    // It never blames the other pages, which are only a keypress away.
    const message =
      panel.allRows.every((row) => !inTab(row.task, panel.tab)) || panel.allRows.length === 0
        ? TAB_EMPTY[panel.tab]
        : panel.query.length > 0
          ? "  Nothing on this page matches the search — / , then backspace, widens it."
          : panel.filter === "running"
            ? "  Nothing is running on this page — f shows every status, so finished work is one keypress away."
            : "  Nothing here matches this status — f moves to the next filter.";
    body.push("", theme.fg("dim", message));
    return listFrame(panel, body, width);
  }

  // One name column for the whole page, so the ids line up and nothing more.
  const room = (row: PanelTaskView): number => visibleWidth(chainCells(panel, row).plain);
  const longest = panel.rows.reduce(
    (most, row) =>
      Math.max(most, row.task.kind === "chain" ? room(row) : visibleWidth(row.task.name)),
    12,
  );
  // A chain sells its name column to the steps, so the numbers beside it need less
  // room than a process's size and age; the strip sheds its finished steps instead.
  const nameRoom = Math.min(longest, Math.max(12, inner - (panel.tab === "chains" ? 48 : 79)));

  // The paging line says how much is hidden, so it is paid for out of the window
  // rather than pushing the frame past the pane.
  const { rows: shown, paged } = listWindow(panel.rows.length, panel.renderHeight);
  const visible = panel.rows.slice(panel.listTop, panel.listTop + shown);
  visible.forEach((row, offset) => {
    body.push(
      listRow(panel, row, panel.listTop + offset === selectedIndex(panel), inner, nameRoom),
    );
  });
  if (paged) {
    const first = panel.listTop + 1;
    const last = Math.min(panel.rows.length, panel.listTop + shown);
    body.push(
      theme.fg("dim", `  Showing ${String(first)}-${String(last)} of ${String(panel.rows.length)}`),
    );
  }
  if (panel.notice !== undefined) body.push(theme.fg("warning", `  ${panel.notice}`));
  return listFrame(panel, body, width);
}

export function listHeader(panel: PanelView, width: number): string[] {
  const theme = panel.theme;
  const heading = theme.fg("borderMuted", "──") + theme.fg("text", " Background Tasks ");
  const rule = Math.max(0, width - visibleWidth("── Background Tasks "));
  const lines = [
    heading + theme.fg("borderMuted", "─".repeat(rule)),
    ` ${countsLine(panel)} `,
    ` ${tabBand(panel)} `,
  ];
  // The query stays visible after search mode is left, so the reader can see why
  // rows are missing; the counts above still cover every task.
  if (panel.query.length > 0) {
    lines.push(` ${theme.fg("muted", "search:")} ${theme.fg("accent", panel.query)} `);
  }
  return lines;
}

export function tabBand(panel: PanelView): string {
  const theme = panel.theme;
  const pages = PANEL_TABS.map((tab, index) => {
    const live = liveCount(panel, tab);
    const title = `${String(index + 1)} ${TAB_TITLE[tab]}`;
    const badge = theme.fg(live > 0 ? "accent" : "muted", String(live));
    return tab === panel.tab
      ? theme.bg(
          "selectedBg",
          `${theme.fg("text", ` ${title} `)}${theme.fg("accent", `${badge} `)}`,
        )
      : `${theme.fg("muted", ` ${title} `)}${badge} `;
  });
  const divider = theme.fg("borderMuted", "│");
  return `${pages.join(divider)}${theme.fg("muted", `· filter: ${panel.filter}`)}`;
}

export function liveCount(panel: PanelView, tab: PanelTab): number {
  return panel.allRows.filter(
    (row) =>
      inTab(row.task, tab) && (row.task.status === "running" || row.task.status === "paused"),
  ).length;
}

export function countsLine(panel: PanelView): string {
  const theme = panel.theme;
  const counts = { running: 0, succeeded: 0, failed: 0, timeout: 0, killed: 0 };
  for (const row of panel.allRows) {
    const task = row.task;
    switch (task.status) {
      case "running":
      case "paused":
        // A paused loop is still owed a turn, so it stands with the live work.
        counts.running += 1;
        break;
      case "completed":
        counts.succeeded += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "killed":
      case "interrupted":
        // Only a process carries a kill reason; a loop is never killed by a limit.
        if (task.kind === "process" && task.killReason === "timeout") counts.timeout += 1;
        else counts.killed += 1;
        break;
    }
  }
  const parts: readonly (readonly [ThemeColor, string, number])[] = [
    ["accent", "Running", counts.running],
    ["success", "Succeeded", counts.succeeded],
    ["error", "Failed", counts.failed],
    ["warning", "Timeout", counts.timeout],
    ["muted", "Killed", counts.killed],
  ];
  return parts
    .map(
      ([colour, label, count]) =>
        `${theme.fg(colour, "●")} ${theme.fg("muted", label)} ${theme.fg("text", String(count))}`,
    )
    .join("  ");
}

export function listFooter(_panel: PanelView, room: number): string {
  return fittedFooter(LIST_KEYS, room);
}

export function listFrame(panel: PanelView, body: string[], width: number): string[] {
  const theme = panel.theme;
  const inner = Math.max(1, width - 2);
  const edge = (glyph: string): string => theme.fg("borderAccent", glyph);
  const fitted = (text: string, room: number): string =>
    visibleWidth(text) > room ? truncateToWidth(text, room, "…", false) : text;
  const padded = (text: string, room: number): string => {
    const fit = fitted(text, room);
    return fit + " ".repeat(Math.max(0, room - visibleWidth(fit)));
  };
  const row = (content = ""): string => `${edge("│")}${padded(content, inner)}${edge("│")}`;

  const lines = [
    // The bands above the box are full-width lines of their own, so they are cut to
    // the terminal rather than padded to it: a tally that does not fit loses its
    // tail instead of pushing the panel wider (ticket #34).
    ...listHeader(panel, width).map((line) => fitted(line, width)),
    edge(`╭${"─".repeat(inner)}╮`),
  ];
  for (const line of body) lines.push(row(line));
  // The keys are chosen while still plain text: cutting a coloured string can slice
  // an escape in half and leave the border one column off.
  const footer = listFooter(panel, inner - 1);
  lines.push(row(), row(theme.fg("dim", ` ${footer}`)));
  lines.push(edge(`╰${"─".repeat(inner)}╯`));
  return lines;
}

export function listRow(
  panel: PanelView,
  row: PanelTaskView,
  selected: boolean,
  width: number,
  nameRoom: number,
): string {
  const theme = panel.theme;
  const task = row.task;
  const match = panel.matchScores.get(row);
  const lit = (field: MatchField): readonly number[] =>
    match?.field === field ? match.positions : [];
  const pointer = selected ? theme.fg("accent", "›") : " ";
  const dot = theme.fg(dotColour(task), "●");
  const id = highlight(panel, pad(task.id, ID_COLUMN_WIDTH), "dim", lit("id"));
  // A row `o` brought in says whose it is: the store names a session by a UUID, so
  // the row carries its first six characters and the detail the whole id.
  const tag =
    row.sessionId === undefined ? "" : theme.fg("muted", ` @${row.sessionId.slice(0, 6)}`);
  const tagPlain = row.sessionId === undefined ? "" : ` @${row.sessionId.slice(0, 6)}`;
  const separator = theme.fg("dim", "·");
  // Both kinds share one table, so the row has to say which it is: a loop runs
  // nothing and a process wakes nobody, and their numbers mean different things.
  const kind = highlight(panel, kindWord(task.kind), "muted", lit("kind"));
  const status = highlight(panel, pad(task.status, 11), STATUS_COLOUR[task.status], lit("status"));
  const exit = exitText(task) === "" ? "" : theme.fg("dim", ` ${exitText(task)}`);
  // A raised signal rides beside the status word: the loop is running, and the
  // check has something outstanding (ADR-0018).
  const signal = signalWord(task) === "" ? "" : theme.fg("warning", ` ${signalWord(task)}`);
  // A hit in a word the row does not print still finds the row; the row names
  // the word instead of leaving the reader to guess why it is here.
  const notePlain = match?.hidden === true ? ` via ${match.field}` : "";
  const note = notePlain === "" ? "" : theme.fg("muted", notePlain);

  // The name column is as wide as the longest name, not as wide as the terminal:
  // a fixed split leaves a canyon between the name and the id on a wide screen.
  // A chain spends the column on its steps instead of a name of its own (ADR-0012).
  const chain = task.kind === "chain" ? chainCells(panel, row, nameRoom) : undefined;
  const namePlain = pad(chain?.plain ?? task.name, nameRoom);
  const name =
    chain === undefined
      ? highlight(panel, namePlain, nameColour(task), lit("name"))
      : `${chain.themed}${" ".repeat(Math.max(0, nameRoom - visibleWidth(chain.plain)))}`;
  const growth = panel.growthText(row);
  const headPlain = ` ${pointer} ${dot} ${name} ${id}${tag} ${separator} ${kind} ${status}${exit}${signal}${note} `;
  // The numbers get the room the head leaves, minus one space of gap, so they can
  // shed their least important parts instead of pushing the row past the border.
  // The room is measured on the bare cells: a theme adds markup, and only the
  // characters a reader sees should cost a number its place.
  const headCells = ` ${selected ? "›" : " "} ● ${namePlain} ${pad(
    task.id,
    ID_COLUMN_WIDTH,
  )}${tagPlain} · ${kindWord(task.kind)} ${pad(task.status, 11)}${exitText(task) === "" ? "" : ` ${exitText(task)}`}${signalWord(task) === "" ? "" : ` ${signalWord(task)}`}${notePlain} `;
  const right = theme.fg(
    "dim",
    rightText(
      row,
      panel.now(),
      width - 2 - visibleWidth(headCells) - visibleWidth(growth) - 1,
      foreign(panel, row),
    ),
  );
  // The strip is a command loop's own column: the newest fires, oldest left, so a
  // failure count can never hide a run that never happened (ADR-0015). It drops
  // its oldest cells on a narrow row and disappears entirely before wrapping.
  const strip =
    task.kind === "cmd-loop"
      ? fireStrip(
          panel,
          task,
          width - 2 - visibleWidth(headPlain) - visibleWidth(right) - visibleWidth(growth) - 2,
        )
      : "";
  const head = strip === "" ? headPlain : `${headPlain}${strip} `;
  // The numbers sit against the right edge so a column of sizes can be compared
  // by eye, which is what a reader does with them.
  const tail = `${right}${growth}`;
  const gap = Math.max(1, width - 2 - visibleWidth(head) - visibleWidth(tail));
  const line = `${head}${" ".repeat(gap)}${tail}`;
  // A selected row is washed in one block of background, the way the panel this
  // replaces marks its cursor: the eye finds it without a colour of its own.
  return selected
    ? theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))))
    : line;
}

export function fireStrip(panel: PanelView, task: CmdLoopTask, room: number): string {
  const theme = panel.theme;
  // Manual fires are left out: the strip tracks the schedule, and a probe started
  // by hand never took a slot (ADR-0018).
  const newest = task.fireHistory.filter((fire) => fire.fire > 0).slice(-STRIP_CELLS);
  // Widths are counted on the bare glyphs, so a theme's escapes never cost a
  // cell its place in the strip.
  let cells = newest.map((fire) => {
    const plain = `#${String(fire.fire)}${FIRE_MARK[fire.outcome]}`;
    return { plain, themed: theme.fg(FIRE_COLOUR[fire.outcome], plain) };
  });
  const fitted = (): number =>
    cells.reduce((total, cell) => total + cell.plain.length, 0) + Math.max(0, cells.length - 1);
  while (cells.length > 0 && fitted() > room) cells = cells.slice(1);
  return cells.map((cell) => cell.themed).join(" ");
}

export function stepRecord(panel: PanelView, id: string): Task | undefined {
  // Both stores are searched: a chain `o` brought in still has to name its steps,
  // and those records live in the session that owns it (ticket #27).
  return [...panel.allRows, ...panel.otherRows].find((row) => row.task.id === id)?.task;
}

export function chainPlace(_panel: PanelView, task: ChainTask): string {
  if (task.steps.length === 0) return "no step queued";
  if (task.cursor >= task.steps.length)
    return `${String(task.steps.length)} of ${String(task.steps.length)} done`;
  return `step ${String(task.cursor + 1)} of ${String(task.steps.length)}`;
}

export function chainCells(
  panel: PanelView,
  row: PanelTaskView,
  room = Number.POSITIVE_INFINITY,
): {
  plain: string;
  themed: string;
} {
  const task = row.task;
  const match = panel.matchScores.get(row);
  const nameLit = (): readonly number[] => (match?.field === "name" ? match.positions : []);
  if (task.kind !== "chain")
    return {
      plain: task.name,
      themed: highlight(panel, task.name, nameColour(task), nameLit()),
    };
  if (task.steps.length === 0) {
    return {
      plain: task.name,
      themed: highlight(panel, task.name, nameColour(task), nameLit()),
    };
  }
  const cells = task.steps.map((id) => {
    const step = stepRecord(panel, id);
    const name = step?.name ?? id;
    const status = step?.status ?? "waiting";
    return { name, status };
  });
  const build = (from: number, to: number, markers = true): { plain: string; themed: string } => {
    const kept = cells.slice(from, to);
    // The ellipses stand for the steps that make way, and they are the first thing
    // to go when the column cannot hold them beside the step it must show.
    const lead = markers && from > 0 ? "… " : "";
    const trail = markers && to < cells.length ? " …" : "";
    const plain = `${lead}${kept.map((cell) => cell.name).join(" → ")}${trail}`;
    const themed =
      panel.theme.fg("dim", lead) +
      kept
        .map((cell, offset) => {
          const index = from + offset;
          const arrow = offset === 0 ? "" : panel.theme.fg("dim", " → ");
          const lit = match?.field === "step" && match.stepIndex === index ? match.positions : [];
          const name =
            index === task.cursor
              ? panel.theme.bold(highlight(panel, cell.name, "accent", lit))
              : highlight(panel, cell.name, stepColour(cell.status), lit);
          return `${arrow}${name}`;
        })
        .join("") +
      panel.theme.fg("dim", trail);
    return { plain, themed };
  };
  let from = 0;
  let to = cells.length;
  // The running step is the one fact the row may not lose, so shedding stops at it:
  // finished steps go first, then the waiting ones behind, whichever end is further.
  const fits = (): boolean => visibleWidth(build(from, to).plain) <= room;
  while (!fits() && to - from > 1) {
    if (task.cursor > from) from += 1;
    else to -= 1;
  }
  const shown = build(from, to);
  if (visibleWidth(shown.plain) <= room) return shown;
  const tight = build(from, to, false);
  if (visibleWidth(tight.plain) <= room) return tight;
  // Even the running step alone is too wide for the column: cut it like a name.
  const plain = truncateToWidth(tight.plain, Math.max(1, room), "…", false);
  return { plain, themed: panel.theme.fg(nameColour(task), plain) };
}

export function highlight(
  panel: PanelView,
  text: string,
  colour: ThemeColor,
  positions: readonly number[],
): string {
  if (positions.length === 0) return panel.theme.fg(colour, text);
  let themed = "";
  let at = 0;
  let index = 0;
  while (index < positions.length) {
    const start = positions[index] ?? 0;
    if (start > at) themed += panel.theme.fg(colour, text.slice(at, start));
    let end = start + 1;
    index += 1;
    while (positions[index] === end) {
      end += 1;
      index += 1;
    }
    themed += panel.theme.bold(panel.theme.fg("accent", text.slice(start, end)));
    at = end;
  }
  if (at < text.length) themed += panel.theme.fg(colour, text.slice(at));
  return themed;
}

export function selectedIndex(panel: PanelView): number {
  return panel.rows.findIndex((row) => row.task.id === panel.selectedId);
}

export function foreign(panel: PanelView, row: PanelTaskView | undefined): boolean {
  return row?.sessionId !== undefined && row.sessionId !== panel.source.sessionId;
}
