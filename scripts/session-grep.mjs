#!/usr/bin/env node
/**
 * Read the real session record: the tool results, the cards and the entries a turn
 * actually produced, instead of the source that was supposed to produce them.
 *
 *   node scripts/session-grep.mjs bg-nkrja                 # newest session of this project
 *   node scripts/session-grep.mjs "moved to" --limit 5
 *   node scripts/session-grep.mjs task-detached --session 01a21b4a
 *   node scripts/session-grep.mjs customType --dir ~/.pi/agent/sessions/--other--
 *
 * A match prints its line number, the record's kind, the tool or customType it
 * belongs to, and the text it carries — enough to quote a claims's evidence without
 * writing a throw-a-way JSON parser every time.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const pattern = argv.find((value, index) => !value.startsWith("--") && !argv[index - 1]?.startsWith("--"));
if (pattern === undefined) {
  console.error("usage: session-grep.mjs <pattern> [--session <id-prefix>] [--dir <path>] [--limit <n>]");
  process.exit(2);
}
const limit = Number(flag("limit") ?? 20);
const sessionsRoot = join(homedir(), ".pi", "agent", "sessions");

/** The directory pi names after the working directory: separators and the drive
 *  colon become one dash each, so `C:\a\b` maps to `--C--a-b--`. */
function projectDir(cwd) {
  const mangled = [...cwd].map((character) => (/[A-Za-z0-9._]/.test(character) ? character : "-")).join("");
  return join(sessionsRoot, `--${mangled}--`);
}

function newestSession(dir, prefix) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .filter((name) => prefix === undefined || name.includes(prefix))
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((left, right) => right.at - left.at);
  const first = files[0];
  if (first === undefined) throw new Error(`no session matching ${prefix ?? "(any)"} in ${dir}`);
  return join(dir, first.name);
}

/** The text a record carries, whichever shape it uses. */
function textOf(record) {
  const parts = [];
  const content = record.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block?.text === "string") parts.push(block.text);
      if (typeof block?.content === "string") parts.push(block.content);
      if (Array.isArray(block?.content)) {
        for (const inner of block.content) if (typeof inner?.text === "string") parts.push(inner.text);
      }
    }
  }
  if (typeof record.text === "string") parts.push(record.text);
  if (record.data !== undefined) parts.push(JSON.stringify(record.data));
  if (typeof record.output === "string") parts.push(record.output);
  return parts.join(" ").replaceAll(/\s+/g, " ").trim();
}

const dir = flag("dir") ?? projectDir(process.cwd());
const file = flag("session") === undefined && flag("dir") !== undefined
  ? newestSession(dir, undefined)
  : newestSession(dir, flag("session"));

const matcher = new RegExp(pattern, "u");
const lines = readFileSync(file, "utf8").split("\n");
let shown = 0;
let matched = 0;
for (const [index, line] of lines.entries()) {
  if (line.trim() === "") continue;
  if (!matcher.test(line)) continue;
  matched += 1;
  if (shown >= limit) continue;
  shown += 1;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    console.log(`${String(index + 1)}  (unparsable)  ${line.slice(0, 160)}`);
    continue;
  }
  const kind = record.customType ?? record.toolName ?? record.message?.role ?? record.type ?? "?";
  const text = textOf(record);
  console.log(`${String(index + 1)}  [${String(kind)}]  ${text.slice(0, 400)}${text.length > 400 ? " …" : ""}`);
}
console.log(`\n${String(matched)} match(es) in ${file}${matched > shown ? `, ${String(shown)} shown` : ""}`);
