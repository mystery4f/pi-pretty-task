---
type: source
title: "Observation: pi-pretty-task：改道通知带触发器，静默分支以负断言固化"
tags:
  - pi-pretty-task
  - foreground
  - detach
  - adr-0020
  - testing
status: observation
created: 2026-11-27
updated: 2026-11-27
slug: obs-2026-11-27-pi-pretty-task
relevance: high
observed_at: 2026-11-27T06:22:28.603Z
source_context: Making foreground detach announce its trigger to model and user
---

# ⭐ Observation: pi-pretty-task：改道通知带触发器，静默分支以负断言固化

pi-pretty-task 的前台改道（ADR-0020）原先两条触发路径——ctrl+shift+b 与 PI_PRETTY_TASK_FOREGROUND_TIMEOUT 到点——给模型的文案逐字节相同，且计时器路径零端到端覆盖。改造（提交 cfbfff7，main，9 files +268/−32）：`DetachedResult { kind:"detached"; taskId; trigger: "shortcut"|"timeout"|"shutdown"; afterSeconds }`，一个 `detachedNotice(detached)` + 共享从句 `detachReason()`，不新增第二套文案（避免漂移）；`ForegroundRunnerOptions.onDetached` 只在成功改道时回调，src/index.ts 用它发一次性 toast 并立刻 `publishStatusLine()`，快捷键处理器改为 `result.kind !== "detached"` 才 notify，避免重复提示。exitCode 仍返回 0：pi 的 BashOperations 会把 null 渲染成 "Command terminated without an exit code"，ADR 原意的「不给退出码」在这个缝上不可达。有意静默的四个失败分支（nothing/ambiguous/refused/pending）、shutdown、`!!` 保持不变，用 `harness.notifications` 空断言与 `harness.messages` 空断言固化；test/support/extension-harness.ts 的 notify 从空实现改为记录器。真实记录对照：sessions/--C--…pi-pretty-task--/2026-11-24T01-10-26-066Z_01a20b1a…jsonl 行 531 toolCall / 532 toolResult（唯一真实改道）/ 533 bg_wait / 542 task-finished（用户原记 541 有误）。

*Relevance: high*
*Context: Making foreground detach announce its trigger to model and user*
*Tags: pi-pretty-task foreground detach adr-0020 testing*

---
*Observed: 2026-11-27T06:22:28.603Z*
