---
type: source
title: matt-implement sync reads merge SHA from a ticket's Comments section
status: insight
category: devops
created: 2026-11-25
updated: 2026-11-25
slug: matt-implement-sync-ticket-comments
---

# matt-implement sync reads merge SHA from a ticket's Comments section

`node scripts/ledger.js sync` (pi-matt-implement-flow) is what closes merged tickets after a run. It only finds the merge fact inside a ticket snapshot's `## Comments` section, written as `merge SHA: <sha>`.

A `Merge SHA: <sha>` line appended to the end of the ticket file — outside that section — is silently ignored: the first sync closed only the spec and reported `close 1`, with every merged ticket left open. Adding a `## Comments` section with the merge SHA and re-running sync closed all seven, and the idempotency markers (`<!-- matt-implement:<runId>:<kind> -->`) kept it from duplicating the earlier comment.

Check each ticket file's `## Comments` before syncing; the skip is silent, not a warning.

*Category: devops*

---
*Captured: 2026-11-25*

## Related

_Add links to related pages._
