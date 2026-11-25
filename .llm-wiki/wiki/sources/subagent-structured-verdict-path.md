---
type: source
title: Subagent structured verdicts live in structured-output/output.json, not the artifact md
status: insight
category: tooling
created: 2026-11-25
updated: 2026-11-25
slug: subagent-structured-verdict-path
---

# Subagent structured verdicts live in structured-output/output.json, not the artifact md

Subagent verdicts are not in the artifact file. A reviewer's `*_output.md` can be replaced by its own compression marker (`📦 [ACP] Compressed … → N tokens saved`), and the notify's `structured` comes back `null` even when the child produced a full verdict.

The verdict lives at `C:\Users\…\Temp\pi-subagents-user-<user>\async-subagent-runs\<runId>\structured-output\<dir>\output.json`, and `output-0.log` in the same run directory confirms it with a `Structured output captured.` line. During a 7-ticket run, reading that path directly instead of the artifact saved roughly six extra round trips per review.

*Category: tooling*

---
*Captured: 2026-11-25*

## Related

_Add links to related pages._
