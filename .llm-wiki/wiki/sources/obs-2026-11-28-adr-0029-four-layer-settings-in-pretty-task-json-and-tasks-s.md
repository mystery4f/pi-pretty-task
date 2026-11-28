---
type: source
title: "Observation: ADR-0029 four-layer settings in pretty-task.json and /tasks settings view"
tags:
  - settings
  - configuration
  - tui
  - adr-0029
status: observation
created: 2026-11-28
updated: 2026-11-28
slug: obs-2026-11-28-adr-0029-four-layer-settings-in-pretty-task-json-and-tasks-s
relevance: high
observed_at: 2026-11-28T13:22:13.728Z
source_context: ADR-0029 four-layer settings and /tasks panel settings view
---

# ⭐ Observation: ADR-0029 four-layer settings in pretty-task.json and /tasks settings view

Implemented ADR-0029 four-layer configuration hierarchy (process.env > <project>/.pi/pretty-task.json > $PI_CODING_AGENT_DIR/pretty-task.json > built-in defaults) and /tasks TUI settings mode (mode = "settings", opened with `s` from the list). The 10 existing PI_PRETTY_TASK_* environment variables are frozen in AGENTS.md and docs/configuration.md (no new env vars will be added; future settings belong only in pretty-task.json under "settings"). Editing settings in the TUI persists atomically via writeSettingsFile (writeAtomic) while preserving "templates" in the same file, displays provenance badges ([env]/[project]/[agent]/[default]) and env-shadowing warnings, and live-updates outputCapBytes, maxRunningTasks, notify, foregroundTimeoutSeconds, and shell policy while marking adoptForeground and retentionDays as requiring /reload.

*Relevance: high*
*Context: ADR-0029 four-layer settings and /tasks panel settings view*
*Tags: settings configuration tui adr-0029*

---
*Observed: 2026-11-28T13:22:13.728Z*
