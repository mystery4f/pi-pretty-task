---
type: source
title: 慢测试先治写死的时长，再谈并行度
status: insight
category: devops
created: 2026-11-15
updated: 2026-11-15
slug: slow-suite-timings-not-workers
---

# 慢测试先治写死的时长，再谈并行度

实测数字（pi-pretty-task，#32）：Windows 上 30 个测试文件、130 秒墙钟。两条候选杠杆：

- 提高并行度：`--maxWorkers=2` 只把 **81.48s → 85.63s 文件合计 148.3 → 135.9s**，几乎无效——瓶颈在真实子进程与固定等待，不在 CPU。
- 把时间从代码里拿掉：杀进程宽限、确认轮询、follow 轮询、存活重试全部可注入（`killGraceMs` / `killConfirmMs` / `followPollMs` / `survivedRetryMs`），再按成本拆 project（`test/unit` 3.3s、`test/integration`），全套 **46s**。

结论：慢测试的第一嫌疑是**产品码里写死的时长**，不是调度。可注入时长改完，并行才有意义。

相关：[[syntheses/pi-pretty-task-文档索引]]、[[windows-taskkill-t-needs-force-for-console-node]]


*Category: devops*

---
*Captured: 2026-11-15*

## Related

_Add links to related pages._
