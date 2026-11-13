# pi-pretty-task

A pi extension that owns background processes and scheduled agent wake-ups behind one panel.

Two jobs, one package: run long-lived shell commands in the background (`Task`), and wake the LLM on a schedule so it keeps working (`Loop` / `Iteration`). Everything else was deliberately cut — see `docs/scope-v1.md`.

## Product model (read before changing anything)

- **Loop** — a schedule. On fire it sends a stored prompt into the session via `pi.sendMessage(prompt, { deliverAs: "followUp", triggerTurn: true })`. A Loop never spawns a process and holds no `command` field.
- **Iteration** — one agent turn produced by one Loop fire. It records every tool call made in that turn through `pi.on("tool_execution_start")` / `tool_execution_end`, keyed by tool call id.
- **Task** — one background process record, either started by the user's `bg_run` or by a tool call inside an Iteration (carrying `iterationId`).
- **Panel** — the `/tasks` overlay listing Iterations and Tasks; closing it leaves one status-line summary.

Decisions with rationale live in `docs/adr/`. `GLOSSARY.md` holds the vocabulary; use its terms in code, docs and replies.

The index page for these docs is the wiki synthesis page `pi-pretty-task 文档索引` under `.llm-wiki/wiki/syntheses/` — not a README. Add a row there when you add an ADR or a design doc; keep the repository markdown as the source of truth and the wiki page as the map.

## Non-goals

No subagent/delegate/fusion tools, no `Monitor*`, no `Workflow*`/`Orchestration*`/`Task*` families, no provider-attested runs, no persistent dock widget. Do not reintroduce these; if one becomes necessary, write an ADR first.

## Layout

```
src/extension.ts        entry: registers tools, commands, events, status line
src/tasks/              spawn, process-tree kill, output files, snapshots
src/loops/              schedule store, timers, fire → sendMessage, iteration recording
src/ui/                 /tasks overlay, detail view, message renderers
docs/                   scope + ADRs (prose docs in Chinese)
.llm-wiki/              project wiki; its synthesis page "pi-pretty-task 文档索引" is the docs index
```

Source references from the two upstream plugins are cloned under `.tmp/` (git-ignored). `.tmp/` is scratch: never import from it, never commit it, and treat a missing clone as "clone again", not "restore from memory".

## Conventions

- TypeScript, ESM, Node >= 22.19. Peer deps only: `@earendil-works/pi-coding-agent`, `pi-tui`, `typebox`.
- Code comments and doc comments in English; prose docs (this file's neighbours) in Chinese.
- `dist/` is build output: never commit it.
- Platform behavior is load-bearing. The Windows invocation shape (`cmd.exe /d /s /c`, `windowsVerbatimArguments`), POSIX process groups, `taskkill /PID <n> /T`, and the "SIGTERM → grace → SIGKILL → poll until the group is gone" sequence exist because upstream debugged them the hard way. Keep them, and keep the comment that says why.
- Every state file write is atomic (temp file + rename) and every read tolerates a corrupt file by falling back to `.prev`.
- Style is machine-enforced: `.editorconfig` (2 spaces, LF, final newline) plus Biome for both formatting and linting — one tool, so there is no Prettier/ESLint pair to keep in sync. `npm run lint` must be clean before a change is done; do not reformat files you did not otherwise touch.

## Verification

- `npm run check` — typecheck, no emit (`tsconfig.dev.json`, covers `src/` and `test/`).
- `npm run build` — emit to `dist/` (`tsconfig.json`).
- `npm run lint` — Biome check; `npm run lint:fix` applies safe fixes.
- `npm run test` — vitest, `--passWithNoTests` until the first test lands.
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
