# pi-pretty-task

Background processes and scheduled agent wake-ups for [pi](https://github.com/earendil-works/pi), behind one panel.

> **Status: 1.0.0.** The first npm release; see [Install](#install) and [Releasing](#releasing).

## What it does

Two jobs, one package:

- **Task** — run a long-lived shell command in the background, watch it from a panel, kill its whole process tree.
- **Loop / Iteration** — wake the LLM on a schedule with a preset prompt (`30s`/`10m`/`2h`, or five-field cron such as `0 9 * * 1-5`), and record every tool call of the turn that follows, so "what did that loop actually run?" has an answer. Wakes wait for an idle agent instead of interrupting a turn.

The panel is a `/tasks` overlay plus one summary line above the editor — the footer row is shared with every other extension, so the count lives where it can be read. Keys: `↑/↓` select, `Enter` logs, `/` search, `alt+q` close (first press leaves search mode), `k` stop, `a` stop all, `h` history, `R` rerun, `c` path, `l` loops. Rows sort by when they last changed, and an id says its kind on sight: `bg-` runs a command, `lp-` wakes the assistant.

Deliberately not here: subagent/delegate/fusion tools, monitors-with-shell, workflow/orchestration families, provider-attested runs. See [docs/scope-v1.md](docs/scope-v1.md).

## Documentation

Start at [AGENTS.md](AGENTS.md) for the product model and rules, and [GLOSSARY.md](GLOSSARY.md) for the vocabulary. Scope and decisions live in [docs/](docs/); the index for all of it is the wiki page `.llm-wiki/wiki/syntheses/pi-pretty-task-文档索引.md`.

## Install

Requires [pi](https://github.com/earendil-works/pi) and Node >= 22.19.

```bash
pi install npm:pi-pretty-task
```

## Development

```bash
npm install
npm run check   # typecheck
npm run lint    # biome
npm run test    # vitest, both projects
npm run test:unit  # the pure half only, seconds
npm run build   # emit dist/
npm pack        # prepack builds dist/ automatically
```

Style is machine-enforced by `.editorconfig` + Biome. `dist/` is build output and is never committed.

## Releasing

Versions are published to npm by [.github/workflows/publish.yml](.github/workflows/publish.yml) whenever a GitHub Release is published.

1. Bump and commit the version: `npm version <x.y.z> --no-git-tag-version`, then commit `package.json` and `package-lock.json` and push to `main`.
2. Create a GitHub Release with tag `v<x.y.z>` (for example `v1.0.0`) and publish it. The workflow verifies that the tag matches `package.json`, checks the tarball contents and runs `npm publish`. Prereleases go to the `next` dist-tag instead of `latest`.
3. The publish step authenticates with the `NPM_TOKEN` repository secret (Settings → Secrets and variables → Actions). Create it with `gh secret set NPM_TOKEN --repo mystery4f/pi-pretty-task`.

For the **first** publish, the npm granular access token must use **All packages / Read and write / Bypass 2FA**: `pi-pretty-task` does not exist on npm yet, so it cannot be selected in "Only select packages" (a too-narrow token fails with a misleading `E404 Not Found`). Once 1.0.0 is live, replace it with a token scoped to `pi-pretty-task` only, or migrate to npm trusted publishing (OIDC) and delete the token entirely.

## License

MIT
