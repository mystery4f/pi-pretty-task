---
type: source
title: 模板字面量里的 CSS 没有语法检查，坏了只出一个丑图
status: insight
category: bugfix
created: 2026-11-27
updated: 2026-11-27
slug: css-inside-a-js-template-literal-has-no-syntax-check
---

# 模板字面量里的 CSS 没有语法检查，坏了只出一个丑图

`scripts/preview/page.mjs` 里 `pre { … }` 少了一个右花括号，整块 `.legend` 规则被吞进 `pre` 里，于是图例用 16px Times New Roman、左边被裁、底边被窗口切掉——**构建不报错、单测全绿、字节级 gif 检查也只抓到画布高度差了 3 px**。真正定位靠 playwrigh 的 `getBoundingClientRect`/`getComputedStyle` 探针：`font-size: 16px`、`font-family: Times New Roman` 一眼就露。

三条可复用的做法：

- 写在 JS 模板字符串里的 CSS 等于没有 linter，改完必须渲染一次看图，别只信 `tsc`/`biome`。
- 几何守卫（读 gif 字节比画布高）只守尺寸，不守样式；要守样式就在页面里断言 DOM 事实（图例文本存在、`getComputedStyle` 的 `font-family`/`font-size`），否则"尺寸对、样式错"的图会被判绿。
- 高度公式要写成常量共享（`CANVAS_CHROME`/`LINE_HEIGHT`/`STRIP_LINES` 从 `page.mjs` 导出、`gif-check.mjs` 引用），我用 `LINE_HEIGHT - 1` 猜了一次就错了 1 px，被测到的正是这个猜。

相关：[[sources/pi-pretty-task-preview-from-the-built-panel]]

*Category: bugfix*

---
*Captured: 2026-11-27*

## Related

_Add links to related pages._
