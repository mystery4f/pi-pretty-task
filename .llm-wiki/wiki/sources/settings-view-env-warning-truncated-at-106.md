---
type: source
title: pi-pretty-task settings view env warning truncated at 106 columns
status: insight
created: 2026-11-28
updated: 2026-11-28
slug: settings-view-env-warning-truncated-at-106
---

# pi-pretty-task settings view env warning truncated at 106 columns

## 症状
`/tasks` 设置页（`src/ui/panel/settings-view.ts`，ADR-0029）里，被环境变量遮蔽的那一行 APPLY 列显示 `live · shadowed by PI_PR…`，变量名被省略号吃掉；选中行下面的警告行 `⚠ Shadowed by PI_PRETTY_TASK_MAX_RUNNING_TASKS in process.env — file edits save to project (<完整路径>) but stay inactive while PI_PRETTY_TASK_MAX_RUNNING_TASKS is set.`（164+ 列）在 106 列下面同样只剩半句。读者恰恰看不到该去 unset 的那个变量名。

## 根因
列宽是常量：`KEY_COL_WIDTH=26 + VALUE_COL_WIDTH=22 + SOURCE_COL_WIDTH=10 + FILE_COL_WIDTH=18` 加 3 列前缀 = 79 列，106 列面板只剩 27 列给 APPLY。`live · shadowed by PI_PRETTY_TASK_MAX_RUNNING_TASKS` 54 列，根本放不下。`TasksPanel.frame()` 按 ADR-0017 超宽即 `truncateToWidth(…, "…")`，不会报错，所以单元测试在 `panel.render(130)` 下一直绿——130 列刚好够，掩盖了真实宽度下的截断。

## 修复（`adce0e7`）
- 行内标签缩成 `⚠ env`（13 列，`live · ⚠ env`）。
- 选中行详情改成一行：`⚠ ${VAR} is set in process.env: ${scope} edits save but stay inactive.`，变量名只出现一次，去掉完整路径（路径已在标题行和 `Target file (t):` 行）。
- `test/unit/settings.test.ts` 的 TUI 用例改在 `panel.render(106)` 下断言，并把光标先移到 `notify` 行（详情行只画选中行）。

## 教训
- 面板 UI 测试要用**真实宽度**（README/截图用的 106）渲染，不要为了断言方便放大到 130；放大就等于把截断 bug 一起放过。
- 截图脚本的 `capture()` 会抛错 if 一行超宽，但 `frame()` 已经先截断了，所以脚本永远看不到原始意图——宽度 bug 要靠「在目标宽度下断言关键短语完整出现」来抓。

相关：[[syntheses/pi-pretty-task-文档索引]]、`docs/adr/0029-settings-in-config-files-and-panel.md`



---
*Captured: 2026-11-28*

## Related

_Add links to related pages._
