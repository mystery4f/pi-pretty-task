---
type: source
title: pi 的 git 安装不带 devDeps，入口要写 .ts 而不是靠 prepare 构建
status: insight
category: devops
created: 2026-11-15
updated: 2026-11-15
slug: pi-git-install-omits-dev-deps-so-ship-ts-entry
---

# pi 的 git 安装不带 devDeps，入口要写 .ts 而不是靠 prepare 构建

实测（pi-pretty-task，2026-11-15）：

1. `pi install git:github.com/<owner>/<repo>` 用 `npm install --omit=dev --legacy-peer-deps --no-audit --no-fund` 装到 `~/.pi/agent/git/<host>/<owner>/<repo>`，**不带 devDependencies**。所以用 `prepare: npm run build` 让安装时编译是死路：`tsc` 不在，安装直接失败（`'tsc' 不是内部或外部命令`，npm error code 1）。
2. 正解是让 entry 指向源码：`package.json` 的 `"pi": {"extensions": ["./src/index.ts"]}`，pi 自己转译 TS。这样 `dist/` 只当本地发布产物，安装路径不需要任何构建，`/reload` 也能直接热更。

判据：凡是要走 `git:` 分发的 pi 包，入口写 `.ts`，别依赖 `prepare`；要验证就直接看 `~/.pi/agent/git/.../package.json` 与 `pi list` 的输出。

相关：[[syntheses/pi-pretty-task-文档索引]]


*Category: devops*

---
*Captured: 2026-11-15*

## Related

_Add links to related pages._
