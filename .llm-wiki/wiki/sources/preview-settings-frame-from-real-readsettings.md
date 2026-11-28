---
type: source
title: pi-preview settings frame built from a real readSettings snapshot
status: insight
created: 2026-11-28
updated: 2026-11-28
slug: preview-settings-frame-from-real-readsettings
---

# pi-preview settings frame built from a real readSettings snapshot

## 做法
`scripts/preview/render.mjs` 新增 `renderSettings()`，数据不是手写的 `Settings` 字面量，而是在模块加载时 `mkdtempSync` 两个临时目录，写两份真实的 `pretty-task.json`（项目级带 `settings` + `templates`，全局级带 `settings`），再调 `dist/tasks/base/settings.js` 的 `readSettings({ env: { PI_PRETTY_TASK_MAX_RUNNING_TASKS: "6" }, projectDir, agentDir, platform, probe: () => true })`。这样图里的 `[env]`/`[project]`/`[agent]`/`[default]` 四种徽标、`⚠ env` 标签和 `Layers: env=6 · project=10 · agent=— · default=20` 都是真正的四层合并结果，不是配文。

## 两个细节
- **路径回写**：面板会把 `templatePaths.projectFile`/`agentFile` 打在标题和 `Target file (t):` 行，临时目录的随机名对读者是噪音。`readSettings` 返回后用 spread 覆盖 `templatePaths` 为 `/home/mystery/work/storefront/.pi/pretty-task.json` 与 `/home/mystery/.pi/agent/pretty-task.json`（与其他截图用的 `HOME` 一致）。**不能**用 `path.join(HOME, ".pi", …)`——Windows 下会把 POSIX 路径拼成 `\home\mystery\…`，要直接写字符串。
- **临时目录清理**：`process.on("exit", () => rmSync(dir, { recursive: true, force: true }))`；验证 `ls -d "$TEMP"/pi-pretty-task-preview-*` 为 0。
- `.mjs` 不能写 `import { readSettings, type Settings }`（Node 原生 ESM 不认内联 `type` 修饰符，报 `SyntaxError: Unexpected identifier 'Settings'`），类型用 JSDoc `/** @returns {import("../../dist/tasks/base/settings.js").Settings} */`。

## 挂图三处缺一不可
README 图段 + `docs/previews.md` 表格行 + `package.json` 的 `files`（否则 npm 包里没有这张图）。`readme-coverage.test.ts` 比对前两者的文件名集合；`preview-tour.test.ts` 读 `previews.md` 的 gif 行。`docs/previews.md` 里「十二张静图」和 `preview.mjs` 注释里的 "all twelve" 是手数，加图要跟着改。

相关：[[syntheses/pi-pretty-task-文档索引]]、`docs/previews.md`



---
*Captured: 2026-11-28*

## Related

_Add links to related pages._
