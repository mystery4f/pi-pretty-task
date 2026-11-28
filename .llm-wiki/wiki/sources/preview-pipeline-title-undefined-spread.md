---
type: source
title: pi-preview writePage spread title:undefined over default
status: insight
created: 2026-11-28
updated: 2026-11-28
slug: preview-pipeline-title-undefined-spread
---

# pi-preview writePage spread title:undefined over default

## 症状
`npm run preview`（任何 `--only`）在 `scripts/preview/page.mjs` 的 `escapeHtml(title)` 抛 `TypeError: Cannot read properties of undefined (reading 'replace')`，一张图都出不来。

## 根因
`scripts/preview/preview.mjs` 的 `writePage(name, page)` 写的是 `terminalPage({ title: TITLE, ...page })`。静图走 `{ lines: shot.lines, title: shot.title }`，而 `shots` 表里只有 `detach`/`cards`/`status` 三项带 `title`，其余全是 `shot.title === undefined` —— 对象展开时 `title: undefined` 会**覆盖**前面的默认值 `TITLE`。`page.mjs` 的 `terminalPage({ lines, rows, title, ... })` 解构没有默认值，`undefined` 一路传到 `escapeHtml`。

## 时间线
提交 `120aaa3`（2026-11-28，`feat(preview): play the tour from a real session…`）动了 `page.mjs`/`preview.mjs`，之后 `docs/preview*.png` 没再重渲染过（最后一张是 11-27 的 `f7d5246`），所以坏掉没人发现。`readme-coverage.test.ts` 只比对「README 引用的图 ↔ 磁盘上的图」的文件名集合，不跑渲染管线。

## 修复（`adce0e7`）
```js
writeFileSync(path, terminalPage({ title: TITLE, ...page, title: page.title ?? TITLE }));
```
展开之后再补一次 `??`，`undefined` 落回默认，gif 路径（本来就传 `title: tourTitle(frame)`）不受影响。

## 教训
- 对象展开 + 默认值的顺序坑：`{ a: X, ...obj }` 在 `obj.a === undefined` 时默认值失效。要默认值就写成 `{ ...obj, a: obj.a ?? X }`。
- 截图管线不在测试覆盖里：`readme-coverage` 只看文件名，`gif-check` 只看字节。改 `page.mjs`/`preview.mjs` 后要手跑一次 `node scripts/preview/dump.mjs --only <label>`（不起浏览器）或 `preview -- --only <最小的一张>` 当冒烟。

相关：[[syntheses/pi-pretty-task-文档索引]]、`docs/previews.md`



---
*Captured: 2026-11-28*

## Related

_Add links to related pages._
