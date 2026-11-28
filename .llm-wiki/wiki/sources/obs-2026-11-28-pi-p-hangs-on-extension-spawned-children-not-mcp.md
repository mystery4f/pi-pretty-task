---
type: source
title: "Observation: `pi -p` hangs on extension-spawned children, not MCP"
tags:
  - pi
  - -p
  - hang
  - extension
  - child
  - process
  - qmd
  - llm-wiki
  - messenger-swarm
status: observation
created: 2026-11-28
updated: 2026-11-28
slug: obs-2026-11-28-pi-p-hangs-on-extension-spawned-children-not-mcp
relevance: high
observed_at: 2026-11-28T08:41:17.931Z
source_context: Diagnosing why probe loops of `pi -p` never advanced
---

# ⭐ Observation: `pi -p` hangs on extension-spawned children, not MCP

`pi -p` hanging after its final answer is caused by extension-spawned long-lived child processes, not MCP. Measured on this machine 2026-11-28: `pi -p … --no-mcp` still printed its answer and then sat for 121 s until `timeout` killed it (exit 124), while `pi -p … --no-mcp --no-extensions --no-skills` exited in 4 s with exit 0. Listing the hung process tree with `Get-CimInstance Win32_Process` (match the CommandLine, then walk `ParentProcessId`) showed the pi node process (pid 44580) owning two children: `node ~/.pi/agent/npm/node_modules/pi-messenger-swarm/dist/harness/cli.js --start` and `node ~/.pi/agent/npm/node_modules/@tobilu/qmd/dist/cli/qmd.js embed` (llm-wiki's background embedding job, the one that may download ~2 GB of models). Those children hold the loop open. Practical rule for batch automation: run `pi -p` with `--no-extensions` when the task needs no plugin, otherwise wrap it in `timeout -k 5 <seconds>` and read the session JSONL rather than the exit code. Note that killing must go through `taskkill /PID <pid> /T /F`, or the orphans survive.

*Relevance: high*
*Context: Diagnosing why probe loops of `pi -p` never advanced*
*Tags: pi -p hang extension child process qmd llm-wiki messenger-swarm*

---
*Observed: 2026-11-28T08:41:17.931Z*
