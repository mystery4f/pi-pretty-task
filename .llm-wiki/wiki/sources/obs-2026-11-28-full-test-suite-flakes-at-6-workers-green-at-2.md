---
type: source
title: "Observation: Full test suite flakes at 6 workers, green at 2"
tags:
  - pi-pretty-task
  - vitest
  - flake
  - windows
status: observation
created: 2026-11-28
updated: 2026-11-28
slug: obs-2026-11-28-full-test-suite-flakes-at-6-workers-green-at-2
relevance: high
observed_at: 2026-11-28T08:17:11.314Z
source_context: Verifying the run-choice rule change in pi-pretty-task
---

# ⭐ Observation: Full test suite flakes at 6 workers, green at 2

pi-pretty-task: `npm run test` at the configured `maxWorkers: min(6, cpus)` flakes on this Windows machine under load — full suite reported 4 files / 5 tests failed (kill-path assertions like `expected 'tree-survived' to be 'killed'` in test/integration/process-tasks.test.ts:727 and waitForStatus timeouts in process-limits.test.ts:60). Clean-tree baseline failed 10 tests / 7 files (process-stop, process-limits, terminal-notification, foreground-detach, chain-tasks, bg-run-templates, bg-run-blocking). The same suite with `npx vitest run --maxWorkers=2` passes 52 files / 643 tests, exit 0, in 227 s. Gate evidence must therefore quote worker count, and a single full-suite failure at 6 workers is not proof the change broke anything — compare against the clean-tree baseline first.

*Relevance: high*
*Context: Verifying the run-choice rule change in pi-pretty-task*
*Tags: pi-pretty-task vitest flake windows*

---
*Observed: 2026-11-28T08:17:11.314Z*
