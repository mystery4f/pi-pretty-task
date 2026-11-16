---
type: source
title: "Windows CI: fsync per state write outran the record wait"
status: insight
category: bugfix
created: 2026-11-16
updated: 2026-11-16
slug: windows-ci-slow-fsync-record-write
---

# Windows CI: fsync per state write outran the record wait

pi-pretty-task 的 verify.yml 在 windows-latest 上反复红：

- run 43870187817：`test/integration/task-persistence.test.ts > history across a restart` 报 `timed out after 15000ms waiting for task bg-nplly to be recorded as completed`（test/support/processes.ts:96 的 `waitFor`）。
- run 43869604468：同族症状，`waiting for the final record to reach the disk`、`waiting for the rewritten file to carry the fire history`。

根因不是测试等太久，而是 `src/tasks/base/task-store.ts` 的 `writeAtomic()` 每次写都做 `handle.sync()`（Windows 上是 FlushFileBuffers）：CI 机器上有实时扫描，一次写代价被放大，一轮任务生命周期里十几次写入（每代还写 `.prev`）叠起来，最新一代落到磁盘时已经超过等待窗口。

修法（commit 06bfc33 `fix(store): keep the rename's atomicity and drop the per-write flush`）：去掉 `handle.sync()`，只保留 temp + rename 的原子性——这才是这类记录文件唯一承诺的语义；掉电丢最新一代时 loader 本来就当"无记录"重建。同 commit 把 `waitFor` 默认超时 15s→30s。

教训：Windows 上的 fsync 不是"便宜的正确性"，是每秒级代价；状态文件的承诺要写清是原子性还是持久性。

*Category: bugfix*

---
*Captured: 2026-11-16*

## Related

_Add links to related pages._
