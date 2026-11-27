#!/usr/bin/env node
/**
 * Freeze one real session's task store into `scripts/preview/record/session.json`,
 * so the previews quote ids, exit codes and output lines a reader can check instead
 * of inventing them.
 *
 *   node scripts/preview/capture-record.mjs                     # newest session here
 *   node scripts/preview/capture-record.mjs --session 01a21cdb   # an older one
 *   node scripts/preview/capture-record.mjs --tasks .pi/tasks/<id>/tasks.json
 *
 * The store is copied verbatim (`tasks`), and each task's output file contributes
 * its last `MAX_LINES` lines (`outputs`). Nothing is renamed and no path is
 * rewritten: a frame that prints `output file:` prints the path the store holds.
 *
 * Re-run it when the snapshot must follow a newer session; the committed file is
 * what the previews read, so a machine without `.pi/tasks/` still renders the same
 * images.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "scripts", "preview", "record", "session.json");
/** A tail long enough for every frame, short enough to read in a diff. */
const MAX_LINES = 200;
const MAX_BYTES_PER_FILE = 32 * 1024;

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

function tasksFile() {
  const explicit = flag("tasks");
  if (explicit !== undefined) return resolve(explicit);
  const store = join(ROOT, ".pi", "tasks");
  if (!existsSync(store)) {
    console.error(`no task store at ${store}: pass --tasks <path> to point at one`);
    process.exit(2);
  }
  const prefix = flag("session");
  const sessions = readdirSync(store)
    .filter((name) => (prefix === undefined ? true : name.startsWith(prefix)))
    .map((name) => join(store, name, "tasks.json"))
    .filter((path) => existsSync(path))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  const first = sessions[0];
  if (first === undefined) {
    console.error(`no tasks.json under ${store}${prefix === undefined ? "" : ` for ${prefix}`}`);
    process.exit(2);
  }
  return first;
}

/** The last `MAX_LINES` lines of one output file, or nothing when it is gone. */
function readOutput(path) {
  if (path === undefined || !existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  const text = bytes.subarray(Math.max(0, bytes.length - MAX_BYTES_PER_FILE)).toString("utf8");
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-MAX_LINES);
}

const file = tasksFile();
const document = JSON.parse(readFileSync(file, "utf8"));
const outputs = {};
const missing = [];
for (const task of document.tasks) {
  const lines = readOutput(task.outputPath);
  if (lines === undefined) {
    if (task.outputBytes > 0) missing.push(task.id);
    continue;
  }
  outputs[task.id] = lines;
}

const sessionId = dirname(file).split(/[\\/]/u).at(-1);
/** The project the store belongs to: `<cwd>/.pi/tasks/<sessionId>/tasks.json`. */
const capture = {
  source: {
    sessionId,
    capturedAt: new Date().toISOString(),
    tasksFile: file.slice(ROOT.length).replaceAll("\\", "/"),
  },
  version: document.version,
  tasks: document.tasks,
  outputs,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(capture, undefined, 1)}\n`);

console.log(
  `captured ${String(document.tasks.length)} tasks and ${String(Object.keys(outputs).length)} output files from ${sessionId}`,
);
if (missing.length > 0) console.log(`output files not on disk: ${missing.join(", ")}`);
console.log(`wrote ${OUT.slice(ROOT.length + 1)}`);
