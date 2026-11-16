---
type: source
title: 面板：键盘说意图，渲染方拿只读视图
status: insight
category: architecture
created: 2026-11-16
updated: 2026-11-16
slug: pi-pretty-task-panel-intents-and-view
---

# 面板：键盘说意图，渲染方拿只读视图

`src/ui/panel/input.ts` 原本直接写 `panel.selectedId`、`panel.listTop` 再 `panel.paint()`，全文件 84 处字段直写；改成 18 个意图方法（`moveCursor(1)`、`openPage()`、`showFire(fire, i)`、`scrollTail(delta)`）后，键盘文件只剩方法调用，626 行降到 452 行，2580 行 / 107 例的面板回归网一次没错。

第二步才是可见性：新增 `src/ui/panel/view.ts` 的 `interface PanelView`（27 个 readonly 成员），`list.ts`、`detail.ts` 的参数类型改用它。效果有两层——写进去编译不过；渲染方不再 import 面板本体，`list.ts ↔ tasks-panel.ts` 的反向依赖消失，`detail.ts` 里那条 `import { chainPlace, foreign, renderList, stepRecord } from "./list.js"` 也不再牵着面板。

迁移拆成两个提交（先加方法、字段仍公开；再收窄可见性），每步全绿，bisect 能分清"键盘挪了"与"状态坏了"。

相关：[[syntheses/pi-pretty-task-交接v02-收尾状态]]、[[pi-pretty-task-session-hub-required]]

*Category: architecture*

---
*Captured: 2026-11-16*

## Related

_Add links to related pages._
