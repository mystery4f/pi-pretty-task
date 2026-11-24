---
type: source
title: 全量 integration 套件在 8 worker 下间歇超时，串行才是确定性证据
status: insight
category: testing
created: 2026-11-24
updated: 2026-11-24
slug: pi-pretty-task-full-suite-parallel-flake
---

# 全量 integration 套件在 8 worker 下间歇超时，串行才是确定性证据

## 观测

pi-pretty-task 在本机（20 核，同时跑着 pi 自身）连跑两遍全量套件：

- 第一次 5 failed / 495 passed，挂的是 `test/integration/process-stop.test.ts` 等时序用例；
- 第二次 1 failed / 499 passed，挂的是 `test/integration/terminal-notification.test.ts > does not write for a task that is still running`；
- 两个失败文件单独重跑全绿；
- `vitest run --no-file-parallelism` 串行：42 files / 500 tests 全绿，4 分 03 秒（并行约 95 秒）。

## 判读

这批 integration 用例断言真实 `taskkill` 与子进程时序（"三秒宽限后强制"、"还在跑就不写通知"），负载一高时间断言就过线。`vitest.config.ts` 已把 `maxWorkers` 压到 `min(8, availableParallelism())` 并注释了默认 19 worker 曾挂 4 个——但套件从 425 涨到 500 之后，8 也不够。

## 规则

- 全量跑出现"每个失败单独重跑都过"的形态，先怀疑负载，不要动代码。
- 要确定性结论：`vitest run --no-file-parallelism`，代价约为并行耗时 2.5 倍。
- 别用"全量跑一次绿了"当证据，除非它是串行的。


*Category: testing*

---
*Captured: 2026-11-24*

## Related

_Add links to related pages._
