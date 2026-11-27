---
type: source
title: What the model saw is in the session record, not the source
status: insight
category: debugging
created: 2026-11-27
updated: 2026-11-27
slug: session-record-not-source-is-the-evidence
---

# What the model saw is in the session record, not the source

Twice in one session the honest answer to "did the model know this happened?" came from the session jsonl and nowhere else: a source reading of `detachedNotice` said both detach triggers produced the same text, and only the real record showed the actual tool result the model received, down to the em dash. The one-line bash at the time was a five-line JSON parser.

`scripts/session-grep.mjs` is that parser, kept: it derives the project's session directory from the cwd (`C:\a\b` → `--C--a-b--`), takes the newest `.jsonl` or `--session <id-prefix>`, and prints each match as line number, tool or customType, and the carried text. The first command to reach for when a claim is about what a model or a user actually saw.

One design fact the same investigation pinned down, worth remembering: in pi, `sendMessage` accepts only `triggerTurn` and `deliverAs` — there is no `excludeFromContext`, so any custom message card enters model context. A persistent, display-only card is a session entry (`pi.appendEntry<T>` + `pi.registerEntryRenderer<T>`), which reload redraws and the model never reads.

Related: [[pi-pretty-task 文档索引]].


*Category: debugging*

---
*Captured: 2026-11-27*

## Related

_Add links to related pages._
