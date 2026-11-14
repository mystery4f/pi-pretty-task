---
type: source
title: "Observation: Loop wake backlog storms after a long turn"
tags:
  - pi-pretty-task
  - loop
  - wake-queue
  - scheduling
status: observation
created: 2026-11-14
updated: 2026-11-14
slug: obs-2026-11-14-loop-wake-backlog-storms-after-a-long-turn
relevance: medium
observed_at: 2026-11-14T09:44:52.888Z
source_context: Supervising pi-pretty-task v0.2 implementers with the plugin's own loop feature
---

# 🔍 Observation: Loop wake backlog storms after a long turn

In pi-pretty-task, a 5-minute loop whose fires land while the agent is busy queues every wake (ADR 0009) and delivers the whole backlog the instant the agent goes idle. Live evidence: one 18-minute turn collected four wakes at 09:25/09:30/09:35/09:40 and they arrived back-to-back, three of them 10–20 minutes stale, each burning a full turn.

Fix chosen at the session level for now: replace the 5-minute supervisor loop with a 15-minute one (loop_create ixhomm, loop_delete xbpr85). The product fix belongs to ticket #24: a queued wake older than one schedule interval should be dropped and counted as `missedFires` instead of delivered.

Related: this is the same phenomenon the external tester reported as "唤醒排队后延迟可达分钟级" — correct behaviour by design, wasteful when the interval is short relative to turn length.

*Relevance: medium*
*Context: Supervising pi-pretty-task v0.2 implementers with the plugin's own loop feature*
*Tags: pi-pretty-task loop wake-queue scheduling*

---
*Observed: 2026-11-14T09:44:52.888Z*
