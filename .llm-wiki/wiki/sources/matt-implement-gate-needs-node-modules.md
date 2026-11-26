---
type: source
title: A typed workflow gate returns null when its worktree lacks node_modules
status: insight
category: devops
created: 2026-11-25
updated: 2026-11-25
slug: matt-implement-gate-needs-node-modules
---

# A typed workflow gate returns null when its worktree lacks node_modules

A typed `gate` on a pi-subagents workflow child (`gate: { command, output: "json", schema }`) fails with `Acceptance verification 'gate' failed: … validationOutput: must be string` and `structured: null` when the child's worktree has no `node_modules` — `mechanical-report.js` cannot run the test command, so the report is incomplete. The code work itself is usually finished at that point.

The orchestrator's recovery, applied three times in one run: take the head SHA from the child's report, `npm ci` in that worktree, run the three gates by hand (`npm run test`, `npm run check`, `./node_modules/.bin/biome check .`), record `add anomaly --note …` with the evidence, then continue to review. A missing `node_modules` in a fresh worktree is the norm here, so treat a gate schema error as infrastructure, not a code failure.

*Category: devops*

---
*Captured: 2026-11-25*

## Related

_Add links to related pages._
