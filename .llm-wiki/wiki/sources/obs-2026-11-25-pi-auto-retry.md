---
type: source
title: "Observation: pi 扩展拿不到 auto_retry 事件，重试进度只能派生"
tags:
  - pi-extension
  - api-gap
  - retry
  - loop
status: observation
created: 2026-11-25
updated: 2026-11-25
slug: obs-2026-11-25-pi-auto-retry
relevance: high
observed_at: 2026-11-25T12:35:33.885Z
source_context: "pi-pretty-task 实现 ticket #47（重试可见）时子代理发现的 API 缺口"
---

# ⭐ Observation: pi 扩展拿不到 auto_retry 事件，重试进度只能派生

pi 1.5.2 的扩展 API 不转发 retry 事件到 extension：`ExtensionAPI.on`（`dist/core/extensions/types.d.ts:1229-1266`）里没有 `auto_retry_start` / `auto_retry_end`，`AgentSession._emitExtensionEvent`（`dist/core/agent-session.js:957`）只转发 `agent_*` / `turn_*` / `message_*` / `tool_*`；`auto_retry_*` 走 `this._emit`，只到达公开 session 监听器。扩展要在面板上显示重试进度，只能派生：统计当前 iteration 内 stopReason === "error" 的 assistant `message_end`，上限取 `pi.getSettings().retry.maxRetries`（缺省 3），turn 结束时清零。给 `pi.on()` 传未转发的事件名再 cast 会在生产里永远不触发，属于假实现。pi-pretty-task 的 ticket #47 因此改为派生方案，ticket #46 的「provider 是否放弃」也改为在 turn 结束时判定。

*Relevance: high*
*Context: pi-pretty-task 实现 ticket #47（重试可见）时子代理发现的 API 缺口*
*Tags: pi-extension api-gap retry loop*

---
*Observed: 2026-11-25T12:35:33.885Z*
