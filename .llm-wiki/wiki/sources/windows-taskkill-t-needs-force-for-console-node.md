---
type: source
title: Windows 上 taskkill /T 不加 /F 停不下控制台 node
status: insight
category: bugfix
created: 2026-11-15
updated: 2026-11-15
slug: windows-taskkill-t-needs-force-for-console-node
---

# Windows 上 taskkill /T 不加 /F 停不下控制台 node

实测（pi-pretty-task 的 `src/tasks/process/supervisor.ts`）：Windows 终止后台任务整棵树时，`taskkill /PID <n> /T` 对「控制台型」子进程（`node -e "setInterval(...)"`）返回 128 并打印「只能强制终止」，优雅终止从未成功。

后果：每次停止都要先等满宽限期（默认 3000ms）再 `/F` 强杀，所以**任何** Windows 停止路径都是 3 秒起步；测试里 25 次 stop 直接付掉 ~75 秒，这也是测试套件慢的主因之一。

判据：`/F` 之后仍要轮询确认整组消失，不能凭 `taskkill` 退出码；`tree-survived` 时保留 `running` 并重试，而不是静默改状态。

相关：[[syntheses/pi-pretty-task-文档索引]]


*Category: bugfix*

---
*Captured: 2026-11-15*

## Related

_Add links to related pages._
