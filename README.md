# pi-pretty-task

Background processes and scheduled agent wake-ups for [pi](https://github.com/earendil-works/pi), behind one panel.

> **Status: early work in progress.** Nothing is runnable yet — the repository holds the design, the vocabulary and the toolchain. The first usable version covers background tasks only.

## What it does

Two jobs, one package:

- **Task** — run a long-lived shell command in the background, watch it from a panel, kill its whole process tree.
- **Loop / Iteration** — wake the LLM on a schedule with a preset prompt, and record every tool call of the turn that follows, so "what did that loop actually run?" has an answer.

The panel is a `/tasks` overlay plus a one-line status summary — no persistent widget. Keys: `↑/↓` select, `Enter` logs, `k` stop, `a` stop all, `h` history, `R` rerun, `c` path, `l` loops, `x` close.

Deliberately not here: subagent/delegate/fusion tools, monitors-with-shell, workflow/orchestration families, provider-attested runs. See [docs/scope-v1.md](docs/scope-v1.md).

## Documentation

Start at [AGENTS.md](AGENTS.md) for the product model and rules, and [GLOSSARY.md](GLOSSARY.md) for the vocabulary. Scope and decisions live in [docs/](docs/); the index for all of it is the wiki page `.llm-wiki/wiki/syntheses/pi-pretty-task-文档索引.md`.

## Development

```bash
npm install
npm run check   # typecheck
npm run lint    # biome
npm run test    # vitest
npm run build   # emit dist/
```

Style is machine-enforced by `.editorconfig` + Biome. `dist/` is build output and is never committed.

## License

MIT
