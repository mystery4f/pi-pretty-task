---
type: source
title: 会话 hub 必须由入口注入，默认值会分裂写入权
status: insight
category: architecture
created: 2026-11-16
updated: 2026-11-16
slug: pi-pretty-task-session-hub-required
---

# 会话 hub 必须由入口注入，默认值会分裂写入权

`ProcessTasks` 与 `ChainTasks` 各自写过 `options.sessions ?? new TaskSessions()`：同一目录被两份缓存读到，谁后写谁覆盖，且没有任何测试会红。改成必填参数后（`this.hub = options.sessions`），编译器就能证明全进程只有一个写入者，`src/index.ts` 是唯一构造点。

第二层是类型：`TaskSession` 拆成 `OwnedTaskSession`（带 `store`）与 `PeekedTaskSession`（不带），`read()` 只能返回 peeked，于是"对着只看过的 session 写"从运行期丢更新变成编译错误。`LoopTasks.readSession()` 的三条规则（owned 用 session、否则 read）也随之收进 `TaskSessions`。

ADRs 0010（recency 落盘）与 0011（id 带前缀）都隐含"一个目录一支笔"，这条默认值正是把它们的前提悄悄打破的地方。

相关：[[syntheses/pi-pretty-task-交接v02-收尾状态]]、[[pi-pretty-task-panel-intents-and-view]]

*Category: architecture*

---
*Captured: 2026-11-16*

## Related

_Add links to related pages._
