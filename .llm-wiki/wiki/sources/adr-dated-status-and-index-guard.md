---
type: source
title: An undated ADR cannot be checked for staleness
status: insight
category: docs
created: 2026-11-27
updated: 2026-11-27
slug: adr-dated-status-and-index-guard
---

# An undated ADR cannot be checked for staleness

Twelve of twenty-four ADRs in pi-pretty-task had no `## 状态` section at all: a title, a paragraph, and Considered Options. That made "when was this decided" unanswerable and any staleness check impossible, which is why the ADR list read as a permanent chore.

Repair was mechanical, not editorial: each missing status carries the date of the commit that added the file (`git log --diff-filter=A --format=%ad --date=short -- <file>`), so the date is evidence rather than a guess. `test/unit/adr-index.test.ts` now holds four lines instead of one — every ADR on disk is named by the index; every ADR has `## 状态` plus `已接受（YYYY-MM-DD）`; every `adr/NNNN-*.md` link in `docs/`, `README.md`, `AGENTS.md`, `GLOSSARY.md` and the index resolves to a file that exists; and the index frontmatter's `updated:` is never older than the newest ADR's date, which is what catches an ADR added without its row.

The lesson generalizes: a documentation rule that lives only in prose drifts one file at a time, and the fix is to make the shape (a dated status line, an index row, a resolvable link) something a test reads — not to write a longer instruction. The index rows themselves also went stale in the usual way (it still described `previews.md` as "four images" and `configuration.md` as two keys), so the newest-date check earns its place.

Related: [[pi-pretty-task 文档索引]].


*Category: docs*

---
*Captured: 2026-11-27*

## Related

_Add links to related pages._
