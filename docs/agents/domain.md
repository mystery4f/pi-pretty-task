# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **single-context**: one `GLOSSARY.md` and one `docs/adr/` at the root.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.
- **`AGENTS.md`**: the product model and the rules that constrain the code.

If any of these files don't exist, proceed silently. The `/domain-modeling` skill (reached via `/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── AGENTS.md            product model, rules, layout
├── GLOSSARY.md          domain vocabulary — Task, Loop, Iteration, Panel
├── docs/
│   ├── adr/             numbered decisions
│   ├── agents/          these consumer rules
│   └── scope-v1.md      what is in and out of v0.1
└── src/
```

The index page for these docs is the project wiki page `pi-pretty-task 文档索引` under `.llm-wiki/wiki/syntheses/`. The repository markdown is the source of truth; the wiki page is the map. Do not turn a README into a second index.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a test name, a refactor proposal), use the term as defined in `GLOSSARY.md`. In particular: a **Loop** wakes the LLM with a prompt and never runs a command; the **Iteration** is the turn that follows; a **Task** is a background process.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding — e.g. proposing a persistent widget contradicts ADR-0003:

> _Contradicts ADR-0003 (panel is a status line plus overlay), but worth reopening because…_
