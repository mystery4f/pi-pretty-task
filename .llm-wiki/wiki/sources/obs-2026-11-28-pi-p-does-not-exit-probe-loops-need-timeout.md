---
type: source
title: "Observation: `pi -p` does not exit; probe loops need timeout"
tags:
  - pi
  - -p
  - probe
  - harness
  - hang
  - timeout
status: observation
created: 2026-11-28
updated: 2026-11-28
slug: obs-2026-11-28-pi-p-does-not-exit-probe-loops-need-timeout
relevance: medium
observed_at: 2026-11-28T08:17:11.323Z
source_context: Running six deepseek-flash probe sessions for the wait-rule measurement
---

# 🔍 Observation: `pi -p` does not exit; probe loops need timeout

A probe harness that runs `pi -p` in a loop hangs: on this machine the pi node process stays alive after its final answer (verified 10+ minutes, session JSONL complete, no further turns), so a pipeline like `pi -p ... | tail -40` never sees EOF and `bash script.sh` never advances past session 1. Fix used: redirect each run to its own file and wrap it in `timeout -k 5 200 pi -p ...`; exit 124 is expected and the session JSONL plus the log file are complete. Kept as scripts/wait-stats.mjs measurement practice: evidence is the session files, not the process exit code.

*Relevance: medium*
*Context: Running six deepseek-flash probe sessions for the wait-rule measurement*
*Tags: pi -p probe harness hang timeout*

---
*Observed: 2026-11-28T08:17:11.323Z*
