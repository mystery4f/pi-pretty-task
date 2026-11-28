---
type: source
title: Tool-choice guidance ships as promptGuidelines, not config
status: insight
category: architecture
created: 2026-11-28
updated: 2026-11-28
slug: tool-choice-guidance-belongs-in-promptguidelines
---

# Tool-choice guidance ships as promptGuidelines, not config

A pi plugin that needs the model to make a *selection* decision (here: wait inside the call vs. start in the background) cannot rely on a hand-written rule file: the user installs the plugin and nothing else. The carrier must be something every request sees.

Verified seams in `@earendil-works/pi-coding-agent` (1.5.2 local, 1.6.1 global): `ToolDefinition.promptGuidelines?: string[]` is collected in `_refreshToolRegistry` (`dist/core/agent-session.js:3012`), passed into `_rebuildSystemPrompt` (`:1358`) as `toolGuidelines`, and rendered by `buildRules(selectedTools, toolGuidelines, promptGuidelines)` (`dist/core/system-prompt.js:31`) into the Guidelines section. Bundled tools already use it.

Cache safety is the design constraint, not a nicety: guidelines must be **compile-time constants**. Changing them in a `before_agent_start` handler is appended as a delta system message through `diffSystemPromptSections`, so the cached prefix survives; returning `systemPrompt` or `forceSystemPrompt` replaces the head and guarantees a miss. Measured on this project: 93.9% / 95.6% / 98.2% of input tokens came from cache, first turn always 0%, and after the injection every probe session sat at 99.0–99.7% from turn two.

Reload semantics decide when an edited rule reaches the model: only `reload()` calls `_resourceLoader.reload()` (`dist/core/agent-session.js:3122`), and extension modules are imported through jiti with `moduleCache: false`; `/new` builds a fresh `AgentSession` from the already-loaded extensions, so it shows the current in-memory text and never re-reads the file. Pin this with a unit test asserting the guideline array equals a literal and contains no date, counter or task id — that is what keeps a future "let's add the running count" edit from silently costing a cache miss per turn.

Related: [[sources/obs-2026-11-28-full-test-suite-flakes-at-6-workers-green-at-2]]

*Category: architecture*

---
*Captured: 2026-11-28*

## Related

_Add links to related pages._
