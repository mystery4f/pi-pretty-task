---
type: source
title: 并行索引应当塌回记录上的一个字段
status: insight
category: architecture
created: 2026-11-16
updated: 2026-11-16
slug: pi-pretty-task-side-index-to-field
---

# 并行索引应当塌回记录上的一个字段

`src/tasks/loop/iterations.ts` 曾维护 `private readonly openFires: OpenFire[]`，专为回答"这次 fire 有没有开着的 iteration"：push 在 `open()`、find 在 `findOpenFire()`、删除在 `forget()`，还要处理 session 结束的残留。

把 `bound` 放回 `Iteration` 记录本身（iteration 自己知道自己绑了哪次 fire）之后，这份并行索引连同三个 helper 与所有陈旧条目分支一起消失，容量上限与重启修复（ADR-0007）照旧。

判据：一个只被本类读写的第二数据结构，若它的每个字段都能从记录推导，就是"带延迟的 bug"而不是索引。

相关：[[syntheses/pi-pretty-task-交接v02-收尾状态]]、[[pi-pretty-task-one-projection-and-formula]]

*Category: architecture*

---
*Captured: 2026-11-16*

## Related

_Add links to related pages._
