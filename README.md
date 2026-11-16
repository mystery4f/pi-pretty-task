# pi-pretty-task

Background processes and scheduled agent wake-ups for [pi](https://github.com/earendil-works/pi), behind one panel.

> **Status: 1.0.1 on npm.** Install with `pi install npm:pi-pretty-task`; see [Install](#install) and [Releasing](#releasing).

## What it does

Three kinds of record, one panel:

- **Task** — run a long-lived shell command in the background, watch it, kill its whole process tree. Output goes to a file, so "what did it print?" survives the turn.
- **Chain** — queue a command behind another task or chain instead of starting it now. A step is recorded as `waiting` and starts only after the step ahead ends with exit 0; a failing step leaves the ones behind it `skipped`.
- **Loop / Iteration** — wake the LLM on a schedule with a preset prompt (`30s`/`10m`/`2h`, or five-field cron such as `0 9 * * 1-5`), and record every tool call of the turn that follows, so "what did that loop actually run?" has an answer. Wakes wait for an idle agent instead of interrupting a turn.

The panel opens with `/tasks` or `shift+down` and has three tabs — processes, loops, chains. One summary line above the editor stays after it closes; the footer row is shared with every other extension, so the count lives where it can be read.

List keys: `↑/↓` select, `Enter` open, `←` back, `k` stop, `a` stop all, `f` cycle filter (`all`/`running`/`failed`/`done`), `o` toggle other sessions' records, `R` rerun, `c` show the output path, `/` search, `x` close from the list, `alt+q` close from anywhere (the first press leaves search mode). An id says its kind on sight: `bg-` runs a command, `lp-` wakes the assistant, `ch-` is a chain.

Deliberately not here: subagent/delegate/fusion tools, monitors-with-shell, workflow/orchestration families, provider-attested runs. See [docs/scope-v1.md](docs/scope-v1.md).

## Tools

| Tool | What it answers |
|---|---|
| `pretty_task_bg_run` | Start a command; also starts a chain step with `after`, or a named template with `template` |
| `pretty_task_bg_status` | Status, elapsed time, working directory, kill reason |
| `pretty_task_bg_logs` | The output tail, or `follow` for only what arrived since the last read |
| `pretty_task_bg_grep` | Matching lines of the whole output file |
| `pretty_task_bg_wait` | Wait for a task to end, up to 600 seconds |
| `pretty_task_bg_kill` | Stop the task and every process it started |
| `pretty_task_loop_create` / `_list` / `_update` / `_delete` | A schedule, its fires, and its recorded iterations |

## Configuration

Every key is read once at load; a value it cannot use fails the extension with the key name instead of silently falling back.

| Key | Default | Meaning |
|---|---|---|
| `PI_PRETTY_TASK_OUTPUT_CAP_BYTES` | `20971520` (20 MiB) | Output file cap; crossing it kills the tree with reason `output_cap` |
| `PI_PRETTY_TASK_MAX_RUNNING_TASKS` | `20` | Running process records per session, children and steps included |
| `PI_PRETTY_TASK_NOTIFY` | `on` | Write an OSC 9 notification to the terminal when a task ends |
| `PI_PRETTY_TASK_RETENTION_DAYS` | `7` | Session directories older than this are pruned at startup |
| `PI_PRETTY_TASK_SHELL` / `_SHELL_PATH` | `cmd` | Windows shell and its absolute path |
| `PI_PRETTY_TASK_POSIX_SHELL` / `_POSIX_SHELL_PATH` | `inherit` | POSIX shell (`inherit`, `bash`, `sh`) and its path |

Command templates live in `<project>/.pi/pretty-task.json` and `~/.pi/agent/pretty-task.json`, project first, and are read once at load — a file edited mid-session applies after `/reload`. Adding or changing one is covered by the bundled `pretty-task-templates` skill.

Full detail, including the shell rules, decoding order and per-call `cwd`/`env`: [docs/configuration.md](docs/configuration.md).

## Documentation

Start at [AGENTS.md](AGENTS.md) for the product model and rules, and [GLOSSARY.md](GLOSSARY.md) for the vocabulary. Scope and decisions live in [docs/](docs/) — [docs/scope-v1.md](docs/scope-v1.md) and the ADRs under [docs/adr/](docs/adr/) — and the index for all of it is the wiki page [`.llm-wiki/wiki/syntheses/pi-pretty-task-文档索引.md`](.llm-wiki/wiki/syntheses/pi-pretty-task-文档索引.md).

## Install

Requires [pi](https://github.com/earendil-works/pi) and Node >= 22.19.

```bash
pi install npm:pi-pretty-task
```

A local checkout works too: `pi install ./path/to/pi-pretty-task`. The published package carries `src/`, `skills/` and `dist/`, because `pi.extensions` points at `./src/index.ts` and pi transpiles it.

## Development

```bash
npm install
npm run check     # typecheck, no emit
npm run lint      # biome
npm run test      # vitest, both projects
npm run test:unit # the pure half only, seconds
npm run build     # emit dist/
npm run verify    # check + lint + test
npm pack          # prepack builds dist/ automatically
```

Style is machine-enforced by `.editorconfig` + Biome. `dist/` is build output and is never committed.

## Releasing

Versions are published to npm by [.github/workflows/publish.yml](.github/workflows/publish.yml) whenever a GitHub Release is published.

- Bump and commit the version: `npm version <x.y.z> --no-git-tag-version`, then commit `package.json` and `package-lock.json` and push to `main`.
- Create a GitHub Release with tag `v<x.y.z>` and publish it. The workflow verifies that the tag matches `package.json`, checks that the tarball carries `src/`, `skills/` and `dist/`, runs `npm publish`, and then polls the registry until the version is live. Prereleases go to the `next` dist-tag instead of `latest`.
- The publish step authenticates with the `NPM_TOKEN` repository secret (Settings → Secrets and variables → Actions), set with `gh secret set NPM_TOKEN --repo mystery4f/pi-pretty-task`.
- The token must have **Read and write** and **Bypass 2FA**: npm rejects a CI publish without the bypass, with `403 … Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.`
- A **first** publish under a new name also needs **All packages**, because the package cannot be selected before it exists (a too-narrow token fails with a misleading `E404 Not Found`). After that, narrow the token to this one package.
- Bypass-2FA tokens cannot unpublish, and npm is deprecating them. Migrating to [trusted publishing](https://docs.npmjs.com/trusted-publishers/) removes the secret entirely.
- A brand-new package name can be held for a few minutes behind a `0.0.0-stage` placeholder version; the release job's registry poll is what tells you when the real version replaces it.

## License

MIT
