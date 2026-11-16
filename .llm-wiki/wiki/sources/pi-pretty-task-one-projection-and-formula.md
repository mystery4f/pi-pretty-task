---
type: source
title: 一个形状一处投影，一个式子一处实现
status: insight
category: architecture
created: 2026-11-16
updated: 2026-11-16
slug: pi-pretty-task-one-projection-and-formula
---

# 一个形状一处投影，一个式子一处实现

`PanelTaskView` 的组装原本在四处各写一遍（`tasks-command.ts` 的 `loopRow`、`chainRow`、`rerun()` 内联一份、以及 stores 的 `view()`），三处都算 `Math.max(0, (endedAt ?? now) - createdAt)`，只差 `untilNextFireMs`。

合并后有两处唯一：`rowOf(task, now, extras)` 造行（可选字段用条件展开，不写入 `undefined`），`elapsedOf(task, now)` 算时长（`src/tasks/base/format.ts`）。面板行、重跑返回、工具详情、进程与链的 `view()` 全部调它们。

验收靠新增的 7 例单测把每条规则钉住：跑着按 now、结束按 endedAt、时钟回拨不出负数、字节默认 0、可选键不凭空出现、extras 原样带出、两种 kind 形状一致——页面级测试看不出时长算错和列宽错的区别。

相关：[[syntheses/pi-pretty-task-交接v02-收尾状态]]、[[pi-pretty-task-side-index-to-field]]

*Category: architecture*

---
*Captured: 2026-11-16*

## Related

_Add links to related pages._
