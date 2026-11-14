---
type: source
title: "Observation: Kill path skipped persist and notice in pi-pretty-task"
tags:
  - pi-pretty-task
  - review
  - bug
  - process-lifecycle
status: observation
created: 2026-11-14
updated: 2026-11-14
slug: obs-2026-11-14-kill-path-skipped-persist-and-notice-in-pi-pretty-task
relevance: high
observed_at: 2026-11-14T05:03:57.145Z
source_context: pi-pretty-task v0.1 whole-branch review and fixes
---

# ⭐ Observation: Kill path skipped persist and notice in pi-pretty-task

Review of pi-pretty-task v0.1 integration branch found four P1s a green suite missed. Root bug: in src/tasks/process/process-tasks.ts finish() the kill branch set status="killed" and returned early, skipping persist + onFinish, so killed/timed-out/capped tasks stayed "running" on disk (restart rewrote them to "interrupted", losing killReason) and no task-finished notice was ever sent. Other three: status line was only published after /tasks closed (now published on session start and after each finish/pump); list row needed 85 columns so an 80-column terminal wrapped (now drops last/iters columns by width); scope-v1's `a` (stop all) and `l` (loops only) shortcuts were never implemented. Lesson: a suite green on unit seams does not cover "does the terminal state reach disk and the user".

*Relevance: high*
*Context: pi-pretty-task v0.1 whole-branch review and fixes*
*Tags: pi-pretty-task review bug process-lifecycle*

---
*Observed: 2026-11-14T05:03:57.145Z*
