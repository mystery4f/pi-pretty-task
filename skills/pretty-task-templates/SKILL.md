---
name: pretty-task-templates
description: Add, change or remove a named command template in pretty-task.json for the pi-pretty-task plugin. Use when the user wants `bg_run` to run a command by name, or asks why a template they just wrote is missing.
---

# Command templates

A template is a name for a command `bg_run` can run without re-typing it:
`bg_run({ template: "test" })` is the same call as `bg_run({ command: "npm test" })`
with the template's `cwd` and `timeoutSeconds` filled in.

## Where the file lives

Two files, whole-template override by name, project first:

- `<project>/.pi/pretty-task.json` — the one to edit for project work.
- `<agentDir>/pretty-task.json` — the machine-wide default (`~/.pi/agent`, or
  `$PI_CODING_AGENT_DIR` when set). Edit it only for templates that are not about
  this project.

Both are optional. `templates` is the only key:

```json
{
  "templates": {
    "test": { "command": "npm test", "timeoutSeconds": 300 },
    "lint": { "command": "npm run lint", "cwd": "packages/core" },
    "build": { "command": "npm run build" }
  }
}
```

A template accepts `command` (required), `cwd` (relative to the project) and
`timeoutSeconds`. `env` is deliberately not templatable: environment belongs to the
call, not to the file, so a template carrying `env` is rejected as malformed.

## Add or change one

- Read the file first, then merge. The whole entry is replaced by name, so a `cwd`
  you leave out disappears.
- Keep the file valid JSON with 2-space indent and a final newline; the rest of the
  repository is formatted that way.
- Prefer a short, verb-like name (`test`, `build`, `migrate`) — the names are shown
  to the model in the `bg_run` description, sorted, with each command cut to 60
  characters. A long name wastes that budget.
- Do not delete or rewrite entries the user did not mention.

## Remove one

Delete its key and leave the file valid JSON. If the file ends up with an empty
`templates` object, that is fine; with none at all, the description says so and
`template` is rejected.

## Verify before saying it is done

1. Re-read the whole file and parse it: `node -e "JSON.parse(require('fs').readFileSync('.pi/pretty-task.json','utf8'))"`.
2. Check every entry has a `command` and no `env`.
3. Tell the user the reload rule below — this is the part people get wrong.

## The reload rule

The file is read **once, when the extension loads**. An edit made during a session
changes nothing in that session: the old names, the old commands and the old tool
description all stay until pi reloads.

- The new template becomes usable after `/reload` or in a new session. Write that in
  the reply; do not claim a template works because the file now contains it.
- The `bg_run` description is part of the prompt prefix a provider caches. A changed
  file changes that text on the next load, so the cached prefix is paid again once.
  Editing templates is therefore a deliberate, occasional action, not something to do
  per turn.
- Same file content always produces a byte-identical description, so reloading with
  no edit costs nothing.

## What the model sees

```
Command templates available here: build (npm run build), lint (npm run lint), test (npm test).
```

Unknown names answer with the names that do exist:

```
Unknown template "tset". Known templates: "build", "lint", "test". The task was not started. Templates are read when the extension loads, so a file edited during this session applies only after /reload or a new session.
```

If a name is still missing after a reload, re-read the file: a malformed file is
reported as `template configuration <file>: …` at load and that file is ignored as a
whole, while the other file keeps working.
