#!/usr/bin/env node
/**
 * The run-choice rule, counted on real sessions (ADR-0028).
 *
 * Two numbers decide whether the rule works. `wait: true` share says how often a
 * start held the call open on purpose. The adjacency rate says how often a run is
 * followed by a wait the same session did not ask for in the run itself — the
 * pattern the guideline and the nudge exist to remove. Both are counted from the
 * session records, never from an impression: a session file is the only honest
 * witness of what the model called.
 *
 * A third block counts the cost of the rule: per-turn prompt-cache hit rate, where
 * a hit is `cacheRead / (input + cacheRead)`. Guidelines are compile-time text, so
 * only a session's first turn should miss; a rise in misses afterwards means
 * something per-turn slipped into the prompt.
 *
 * Usage:
 *   node scripts/wait-stats.mjs                      # the last 10 days
 *   node scripts/wait-stats.mjs --days 3
 *   node scripts/wait-stats.mjs --since 2026-11-28T10:00:00Z
 *   node scripts/wait-stats.mjs --session 01a22      # path or id substring
 *   node scripts/wait-stats.mjs --json
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RUN = "pretty_task_bg_run";
const WAIT = "pretty_task_bg_wait";
/** The session store, in the shape `pi` writes it: one directory per project. */
const SESSION_ROOT = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");

function parseArgs(argv) {
  const options = { days: 10, since: undefined, session: undefined, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--json") options.json = true;
    else if (arg === "--days" && next !== undefined) {
      options.days = Number(next);
      index += 1;
    } else if (arg === "--since" && next !== undefined) {
      options.since = next;
      index += 1;
    } else if (arg === "--session" && next !== undefined) {
      options.session = next;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option ${arg}. See --help.`);
    }
  }
  return options;
}

function usage() {
  return [
    "node scripts/wait-stats.mjs [--days N] [--since ISO] [--session SUBSTRING] [--json]",
    "",
    "Counts, over the sessions in " + SESSION_ROOT + ":",
    "  sessions, bg_run calls, wait: true share, waitSeconds calls,",
    "  bg_wait calls, and waits whose previous call in the same session was a run.",
    "",
    "Then prints the per-turn prompt-cache hit rate of those sessions.",
  ].join("\n");
}

/** Every session file on disk, newest first. */
function sessionFiles(root) {
  const files = [];
  for (const project of readdirSync(root)) {
    const directory = join(root, project);
    let entries;
    try {
      if (!statSync(directory).isDirectory()) continue;
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(directory, name);
      files.push({ file, project, mtimeMs: statSync(file).mtimeMs });
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function readSession(file) {
  const events = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A half-written last line is a crash, not a call: skip it and keep the rest.
    }
  }
  return events;
}

/** The session's own header: id, start time and the directory it ran in. */
function header(events) {
  const first = events.find((event) => event.type === "session");
  return {
    id: first?.id,
    startedAt: first?.timestamp,
    cwd: first?.cwd,
  };
}

/** The calls a session made, in order, with the arguments the model passed. */
function calls(events) {
  const found = [];
  for (const event of events) {
    if (event.type !== "message") continue;
    const message = event.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type !== "toolCall" && part?.type !== "tool_use") continue;
      found.push({ name: part.name, arguments: part.arguments ?? {}, timestamp: message.timestamp });
    }
  }
  return found;
}

/** One assistant message's usage, as the hit rate this decision is judged on. */
function turns(events) {
  const found = [];
  for (const event of events) {
    if (event.type !== "message") continue;
    const message = event.message;
    if (message?.role !== "assistant" || message.usage === undefined) continue;
    const usage = message.usage;
    const input = Number(usage.input ?? 0);
    const cacheRead = Number(usage.cacheRead ?? 0);
    const cacheWrite = Number(usage.cacheWrite ?? 0);
    const denominator = input + cacheRead;
    found.push({
      input,
      cacheRead,
      cacheWrite,
      hitRate: denominator === 0 ? 0 : cacheRead / denominator,
    });
  }
  return found;
}

function countSession(calls) {
  let runs = 0;
  let waited = 0;
  let bounded = 0;
  let waits = 0;
  let adjacent = 0;
  let previous;
  for (const call of calls) {
    if (call.name === RUN) {
      runs += 1;
      if (call.arguments.wait === true) waited += 1;
      if (call.arguments.waitSeconds !== undefined) bounded += 1;
    } else if (call.name === WAIT) {
      waits += 1;
      if (previous?.name === RUN) adjacent += 1;
    }
    previous = call;
  }
  return { runs, waited, bounded, waits, adjacent };
}

function percent(part, whole) {
  if (whole === 0) return "0.0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function sinceOf(options) {
  if (options.since !== undefined) return Date.parse(options.since);
  return Date.now() - options.days * 24 * 60 * 60 * 1000;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const since = sinceOf(options);
  if (Number.isNaN(since)) throw new Error("--since is not a date this script can read.");

  const rows = [];
  for (const { file, project } of sessionFiles(SESSION_ROOT)) {
    if (options.session !== undefined && !file.includes(options.session)) continue;
    const events = readSession(file);
    const { id, startedAt, cwd } = header(events);
    const started = Date.parse(startedAt ?? "");
    if (Number.isNaN(started) || started < since) continue;
    const sessionCalls = calls(events);
    const counted = countSession(sessionCalls);
    rows.push({ file, project, id, startedAt, cwd, ...counted, turns: turns(events) });
  }

  const total = rows.reduce(
    (sum, row) => ({
      runs: sum.runs + row.runs,
      waited: sum.waited + row.waited,
      bounded: sum.bounded + row.bounded,
      waits: sum.waits + row.waits,
      adjacent: sum.adjacent + row.adjacent,
    }),
    { runs: 0, waited: 0, bounded: 0, waits: 0, adjacent: 0 },
  );

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          since: new Date(since).toISOString(),
          totals: { sessions: rows.length, ...total },
          sessions: rows.map(({ file, id, startedAt, runs, waited, bounded, waits, adjacent, turns }) => ({
            file,
            id,
            startedAt,
            runs,
            waited,
            bounded,
            waits,
            adjacent,
            turns,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const lines = [
    `window since ${new Date(since).toISOString()} · ${String(rows.length)} sessions`,
    `runs            ${String(total.runs)}`,
    `wait: true      ${String(total.waited)} (${percent(total.waited, total.runs)} of runs)`,
    `waitSeconds     ${String(total.bounded)}`,
    `bg_wait         ${String(total.waits)}`,
    `run → wait      ${String(total.adjacent)} (${percent(total.adjacent, total.runs)} of runs, ${percent(total.adjacent, total.waits)} of waits)`,
    "",
    "prompt cache (per turn, cacheRead / (input + cacheRead)):",
  ];
  const withTurns = rows.filter((row) => row.turns.length > 0);
  for (const row of withTurns) {
    const rates = row.turns.map((turn) => (turn.hitRate * 100).toFixed(1)).join(" ");
    const misses = row.turns.filter((turn) => turn.hitRate === 0).length;
    lines.push(`  ${(row.id ?? row.file).slice(-12)}  ${String(row.turns.length)} turns, ${String(misses)} miss: ${rates}`);
  }
  const allTurns = withTurns.flatMap((row) => row.turns);
  const cached = allTurns.reduce((sum, turn) => sum + turn.cacheRead, 0);
  const billed = allTurns.reduce((sum, turn) => sum + turn.cacheRead + turn.input, 0);
  lines.push(
    `  all sessions: ${String(allTurns.length)} turns, ${percent(cached, billed)} of tokens read from cache`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
