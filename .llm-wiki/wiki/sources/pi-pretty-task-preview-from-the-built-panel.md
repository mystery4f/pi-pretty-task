---
type: source
title: README 截图从 dist 里的真面板渲染，三处状态陷阱
status: insight
category: design
created: 2026-11-21
updated: 2026-11-21
slug: pi-pretty-task-preview-from-the-built-panel
---

# README 截图从 dist 里的真面板渲染，三处状态陷阱

README 的四张图改成由 `scripts/preview/` 生成：`render.mjs` 用脚本按键驱动 `dist/ui/panel/tasks-panel.js` 的 `TasksPanel`，每按一键 `await panel.settle()` 后 `render(106)` 抓帧；`page.mjs` 把 ANSI 转成 HTML span 套一个终端窗口；`shoot.mjs` 用 `playwright-core` 驱动本机 Edge 截图、`pngjs` + `gifenc` 编码 GIF。这样改 `src/ui/panel/` 后重跑 `npm run preview` 图就跟着变，不会和代码漂开。

三处只有真的驱动组件才会撞上的状态陷阱：

- `tasks-panel.ts` 的 `rememberedTab` 是模块级变量，面板实例之间共享且**只能由 tab 键改变**。因此渲染函数每次都先调 `rememberPanelTab("processes")`，否则这次截图的内容取决于上一次哪个渲染函数跑过（我先渲染 loop 迭代，结果 process 详情里出现的是 cmd-loop）。
- 搜索模式下 `Enter` 不打开详情：`handleSearchInput` 只处理输入与退格。必须先 `alt+q` 退出搜索（查询保留）再 `Enter`。
- 搜索是模糊子序列且连 loop 的 prompt 正文一起匹配：输入 `web` 会命中 `hourly-review` 的 prompt（"…Revie**w**… brok**e**n" 之外的 w-e-b 顺序）。要点名某一行用 `↓`，不要靠搜索。

GIF 另有两条版面经验：各帧必须补到同一高度（用框内补空行，不要用 stage 里的 spacer 撑画布，否则短帧留 2/3 空白）；`pre { font-variant-ligatures: none }`，否则 `--`、`->` 会被渲染成连字，终端味全丢。

相关：[[sources/obs-2026-11-17-readme-key-list-is-test-guarded-against-panel-drift]]（README 的键位行同样由测试守护）、[[sources/pi-pretty-task-panel-intents-and-view]]。


*Category: design*

---
*Captured: 2026-11-21*

## Related

_Add links to related pages._
