---
type: source
title: "Observation: pi-plugin six-phase skill chain created"
tags:
  - skills
  - pi-plugin
  - chain
  - context-broker
status: observation
created: 2026-11-16
updated: 2026-11-16
slug: obs-2026-11-16-pi-plugin-six-phase-skill-chain-created
relevance: high
observed_at: 2026-11-16T13:48:56.542Z
source_context: Turning pi-pretty-task experience into reusable skill chain
---

# ⭐ Observation: pi-plugin six-phase skill chain created

Created a six-phase pi plugin development chain under C:\Users\10781\.agents\skills\: pi-plugin-spec → pi-plugin-scaffold → pi-plugin-tools → pi-plugin-process → pi-plugin-ui → pi-plugin-verify, sharing the state file `.pi-plugin-chain-state.md` (chain_version 1, real YAML frontmatter, atomic temp+rename, status sequence spec-done → scaffold-done → tools-done → process-done → ui-done → complete). Content is distilled from the pi-pretty-task build: src/index.ts as the manifest entry because git installs run `npm install --omit=dev`; Biome 2 uses linter.rules.preset; Windows cmd.exe /d /s /c + windowsVerbatimArguments and taskkill /T needing /F for console node; decode strict UTF-8 then GB18030 on win32; atomic rename without fsync plus newest-generation coalescing (FlushFileBuffers is slow on scanned volumes); running→interrupted on load, never adopt a pid; theme tokens instead of truecolour, summary line above the editor via setWidget rather than setStatus; test waits on state not bytes; CI matrix ubuntu+windows because the platform branches only exist there. Validated with pi-skill-system-creator's validate-chain.py: entry point pi-plugin-spec, no cycles, no orphans.

*Relevance: high*
*Context: Turning pi-pretty-task experience into reusable skill chain*
*Tags: skills pi-plugin chain context-broker*

---
*Observed: 2026-11-16T13:48:56.542Z*
