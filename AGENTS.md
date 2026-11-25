# pi-pretty-task

A pi extension that owns background processes and scheduled agent wake-ups behind one panel.

Two jobs, one package: run long-lived shell commands in the background (`Task`), and wake the LLM on a schedule so it keeps working (`Loop` / `Iteration`). Everything else was deliberately cut — see `docs/scope-v1.md`.

## Product model (read before changing anything)

- **Loop** — a schedule. On fire it sends a stored prompt into the session via `pi.sendMessage(prompt, { deliverAs: "followUp", triggerTurn: true })`. A Loop never spawns a process and holds no `command` field.
- **Iteration** — one agent turn produced by one Loop fire. It records every tool call made in that turn through `pi.on("tool_execution_start")` / `tool_execution_end`, keyed by tool call id.
- **Task** — one background process record, either started by the user's `pretty_task_bg_run` or by a tool call inside an Iteration (carrying `iterationId`).
- **Panel** — the `/tasks` overlay listing Iterations and Tasks; closing it leaves one status-line summary.

Decisions with rationale live in `docs/adr/`. `GLOSSARY.md` holds the vocabulary; use its terms in code, docs and replies.

The index page for these docs is the wiki synthesis page `pi-pretty-task 文档索引` under `.llm-wiki/wiki/syntheses/` — not a README. Add a row there when you add an ADR or a design doc; keep the repository markdown as the source of truth and the wiki page as the map.
Work-in-flight notes live in one place: the wiki's `pi-pretty-task 交接…` synthesis page. `.tmp/` is scratch for one session only — nothing there survives as a handoff, and a second copy of "what is next" is a stale copy.

## Non-goals

No subagent/delegate/fusion tools, no `Monitor*`, no `Workflow*`/`Orchestration*`/`Task*` families, no provider-attested runs, no persistent dock widget. Do not reintroduce these; if one becomes necessary, write an ADR first.

## Layout

```
src/index.ts            entry: registers tools, commands, events, status line
src/tasks/base/         Task supertype: kind-tagged record, store, atomic writes, snapshots
src/tasks/process/      spawn, process-tree kill, output files, exit codes
src/tasks/loop/         interval scheduling, pump, fire → sendMessage, iteration recording
src/ui/                 /tasks overlay (both kinds), detail view, message renderers
docs/                   scope + ADRs + reviews (prose docs in Chinese)
test/unit/              tests whose subject never leaves the process
test/integration/       tests that spawn a real child and stop a real tree
test/support/           harness, temp directories, `waitFor`, process helpers
scripts/preview/        renders docs/preview* from the built panel (`npm run preview`)
.llm-wiki/              project wiki; its synthesis page "pi-pretty-task 文档索引" is the docs index
```

Source references from the two upstream plugins are cloned under `.tmp/` (git-ignored). `.tmp/` is scratch: never import from it, never commit it, and treat a missing clone as "clone again", not "restore from memory".

## Conventions

- TypeScript, ESM, Node >= 22.19. Peer deps only: `@earendil-works/pi-coding-agent`, `pi-tui`, `typebox`.
- Code comments and doc comments in English; prose docs (this file's neighbours) in Chinese.
- `dist/` is build output: never commit it.
- Platform behavior is load-bearing. The Windows invocation shape (`cmd.exe /d /s /c`, `windowsVerbatimArguments`), POSIX process groups, `taskkill /PID <n> /T`, and the "SIGTERM → grace → SIGKILL → poll until the group is gone" sequence exist because upstream debugged them the hard way. Keep them, and keep the comment that says why.
- Tests read the panel's filter list and key counts from the exported constants (`PANEL_FILTERS`, `DEFAULT_PANEL_FILTER`) instead of hard-coding presses, so a default that moves does not turn four cases red.
- Every state file write is atomic (temp file + rename) and every read tolerates a corrupt file by falling back to `.prev`.
- Style is machine-enforced: `.editorconfig` (2 spaces, LF, final newline) plus Biome for both formatting and linting — one tool, so there is no Prettier/ESLint pair to keep in sync. `npm run lint` must be clean before a change is done; do not reformat files you did not otherwise touch. The same run catches import cycles (`suspicious/noImportCycles`): a split that leaves two files importing each other fails `npm run lint`, so the direction of a dependency is enforced rather than remembered.
- `README.md` is the user-facing entry point, not a changelog: every user-visible capability change lands there in the same change (what it does, the call that uses it, and a regenerated screenshot when the panel changes). The key list and the preview images are test-guarded against panel drift, so edit the README when the panel moves rather than keeping a second copy somewhere else. Material a user never reads — ADRs, scope notes, handoff state — stays out of it.

### pi-lens hints

`pi-lens` reports warnings and errors, which must stay at zero, and `hint`s, which are advisory. Five of its ast-grep hint rules are turned off in `.pi-lens.json` because this codebase answers them by construction, and turning them on again would only produce comments that say so:

- `no-conditional-empty-object-spread` — a task record's optional fields are `readonly`, so a field can only be added where the literal is built; an explicit if/else would need one branch per combination of optional fields.
- `no-unknown-parameters`, `no-runtime-typeof`, `no-unsafe-dictionary-unknown` — a thrown value and a parsed JSON file are `unknown` until they are narrowed, and the narrowing *is* the decoder in `src/tasks/base/task-store.ts`. A parameter that arrives as `unknown` is the rule's own advice being followed.
- `long-parameter-list` — half of the hits are the pi tool interface's own `execute(_toolCallId, params, _signal, _onUpdate, ctx)` signature, which cannot change; the rest are cohesive internals whose parameters are each required.

`large-class` and `high-complexity` stay visible on purpose: they name real debt (the four stores and two panel classes) and a split is a design change that needs an ADR, not a lint fix.


## Verification

- A fresh clone has no `node_modules`: run `npm ci` first, or every script fails with an unhelpful `'tsc' 不是内部或外部命令`.
- `npm run check` — typecheck, no emit (`tsconfig.dev.json`, covers `src/` and `test/`).
- `npm run build` — emit to `dist/` (`tsconfig.json`). The installed package points pi at `./src/index.ts` (pi transpiles it), so this is a check-and-release step, not a deploy step; `dist/` stays out of git.
- `npm run lint` — Biome check; `npm run lint:fix` applies safe fixes.
- `npm run test` — vitest over both projects (`unit`, `integration`); `npm run test:unit` runs the pure half in seconds.
- `npm run verify` — check, lint and test in one run; CI (`.github/workflows/verify.yml`) runs the same three. Run the gates one by one and read each exit code: a chained `a && b` has already hidden a broken typecheck.
- Acceptance for v0.1 is the five lines at the bottom of `docs/scope-v1.md`. A change that breaks any of them is not done.

## Git

Personal/GitHub repository: Conventional Commits in English, author `mystery4f <40482524+mystery4f@users.noreply.github.com>`. Never commit `.tmp/`, `.pi/`, or `dist/`.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in this repo, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, label strings equal to their names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` plus `docs/adr/` at the root. See `docs/agents/domain.md`.
