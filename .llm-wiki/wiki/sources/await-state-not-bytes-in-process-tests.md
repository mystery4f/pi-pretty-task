---
type: source
title: 进程类测试要等状态，不要等字节
status: insight
category: bugfix
created: 2026-11-15
updated: 2026-11-15
slug: await-state-not-bytes-in-process-tests
---

# 进程类测试要等状态，不要等字节

在 pi-pretty-task 里抓到两个同源 flake，都不是产品 bug：

- `test/process-follow.test.ts` 断言 `details.finished === true`；字节到达常早于记录落 `ended`，全套并行时 3 次挂 2 次。
- `test/chain-tasks.test.ts` 一条用例同时断言「跳过步骤落盘」「子进程最后一行输出」「链结束回调」，三者时序不同步。

修法都是**等状态，不等字节**：先 `waitFor` 记录状态离开 `running`/到达终态，再断言输出与回调；每个断言各自 `waitFor`，不要一条用例押三个时点。

判据：一条用例里若出现两个以上「未来才成立」的断言，就该拆成多个 `waitFor`；`waitFor` 超时才算失败。

相关：[[syntheses/pi-pretty-task-文档索引]]、[[slow-suite-timings-not-workers]]


*Category: bugfix*

---
*Captured: 2026-11-15*

## Related

_Add links to related pages._
