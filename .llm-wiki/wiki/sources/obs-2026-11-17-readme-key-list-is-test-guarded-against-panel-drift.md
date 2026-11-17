---
type: source
title: "Observation: README key list is test-guarded against panel drift"
tags:
  - readme
  - test-guard
  - keys
  - panel
status: observation
created: 2026-11-17
updated: 2026-11-17
slug: obs-2026-11-17-readme-key-list-is-test-guarded-against-panel-drift
relevance: high
observed_at: 2026-11-17T16:36:42.178Z
source_context: README restructure of pi-pretty-task
---

# ⭐ Observation: README key list is test-guarded against panel drift

README.md of pi-pretty-task is guarded by test/unit/readme-keys.test.ts: it asserts (a) a trimmed line starting with "↑/↓" must equal LIST_KEYS[0] verbatim from src/ui/panel/keys.ts:17, and (b) a line starting with "List keys:" must contain ≥5 backticked key tokens all belonging to LIST_KEYS[0] segments or DETAIL_KEYS ["←","c","x","1","2","3"]. Any README restructure must keep the footer line "↑/↓ · Enter logs · k stop · f filter · o others · 1/2/3 tabs · / search · R rerun · a stop all · alt+q close" and the "List keys:" sentence, or the unit suite goes red. Discovered while restructuring README 2026-11-17; fixed by re-adding the footer in a text fence under "The panel".

*Relevance: high*
*Context: README restructure of pi-pretty-task*
*Tags: readme test-guard keys panel*

---
*Observed: 2026-11-17T16:36:42.178Z*
