---
type: synthesis
title: pi-background-tasks 源码调研
created: 2026-11-13
updated: 2026-11-13
---

# pi-background-tasks 源码调研

调研对象：`github.com/ismailsaleekh/pi-background-tasks`，v2.6.10，license **ISC**，已 2 个多月无维护。源码克隆在仓库 `.tmp/pi-background-tasks`（不入库）。

## 身份与依赖

- 运行依赖仅 `turndown@7.2.4`；peerDeps：`@earendil-works/pi-coding-agent` / `pi-ai` / `pi-tui` `^0.81.1 || ^0.82.1 || ^0.83.0 || ^0.84.0` 与 `typebox`。`engines.node >= 22.19.0`。
- 声明入口 `pi.extensions = ["./dist/extensions/anthropic-attribution.js", "./dist/extensions/background-tasks.js"]`（`package.json:88-93`）。

## 工具集

- `bg_run`（`src/extension.ts:127-160` schema，`:958` 注册）：必填 `name/command/isAgent`，可选 `description/timeoutSeconds/notifyOnCompletion/triggerOnCompletion/surviveReload`。
- `bg_run_pi_attested`（`:163-186`、`:1067`）：provider/model 校验跑法。
- `bg_status`（`:188`、`:1136`）、`bg_logs`（`:197`、`:1167`）、`bg_kill`（`:211`、`:1212`）。
- delegate 家族：`bg_delegate` / `bg_result` / `fusion_*`（`src/delegate-extension.ts:71-116`）。

## 执行层

- `registry.startTask` → Windows `cmd.exe /d /s /c "<cmd>"`，POSIX `bash|sh -c` → `child_process.spawn`，`shell:false`，POSIX `detached:true`，stdout/stderr 走 pipe 写入 `createWriteStream(..., {flags:'a'})`（`src/core/registry.ts:1738-1745`）。
- 落盘：`<cwd>/.pi/tasks/<sessionId>-<pid>/<taskId>.output` 与同名 `.json`（`registry.ts:1265-1267, 1457, 1635`）；task id = `b` + 4 字节 hex（`:258-260`）。
- 状态机 `running|completed|failed|killed`（`src/core/common.ts:9`）；kill 原因 `user|timeout|output_cap|shutdown`（`:14`）。
- kill：先 SIGTERM，`killGraceMs=3000` 后 SIGKILL；POSIX 向 `-pgid` 发信号并 `kill(-pgid,0)` 轮询确认整组消失；Windows 用 `System32\taskkill.exe /PID n /T`（`/F` 强杀）。`stopWaitMs=4500`。

## 面板与 UI

- 状态栏一行：`ctx.ui.setStatus('background-tasks', ...)`（`src/extension.ts:516-537`）；`setWidget` 恒清空、不用常驻 widget。
- `/tasks`、`/bg-tasks` 打开 `ctx.ui.custom` 浮层（底部居中、96% 宽、maxHeight 60%，`:582-610`）。行样式 `› ● name id · status exit=0 3m 12KB ...`，脚注 `↑/↓ select · Enter logs · k stop · a stop all · h history · R rerun · c path · x close`（`src/ui/background-tasks-manager.ts:595-690`）。
- 详情视图：Name/ID/Status/Runtime/Started/Output/Model/Context/Tokens/Tools/Command/Error + 12 行输出框；上滚即冻结 tail，`r` 恢复跟随，`←` 返回（`:691-745`）。
- 完成通知：`pi.registerMessageRenderer('background-task-notification', ...)`（`extension.ts:657-681`）+ `pi.sendMessage({...}, {deliverAs:'followUp', triggerTurn})`（`registry.ts:3948-3956`）。

## 配置

不读 `settings.json`，全走环境变量（`src/core/config.ts`）：`PI_BG_FEATURES`、`PI_BG_DOCK_SHORTCUT`、`PI_BG_MAX_OUTPUT_BYTES`（默认 20MiB）、`PI_BG_SHELL`/`PI_BG_SHELL_PATH`、`PI_BG_DISABLE_UPDATE_CHECK`、`PI_BG_REGISTRY_URL`、`PI_OFFLINE`。非法值抛 `pi_bg_config_invalid` 阻止加载。

## 已知硬伤

- **重启不恢复**：日志目录名带 pid，registry 不做 readdir 回读；README:210 明确不支持。
- `MAX_OUTPUT_BYTES = Number(env ?? 20MiB)` 无校验：非法串得 NaN，`nextBytes <= NaN` 恒 false，首字节即判超限并杀任务（`registry.ts:78`、`2846-2866`）。
- `.pi/tasks/**` 无 TTL，磁盘文件永不删除；模型可见日志上限硬编码 50KiB（`common.ts:498-499`）。
- 颜色硬编码 truecolor（`extension.ts:83-88`、`background-tasks-manager.ts:33-36`），绕过 theme；社区流传的“settings.json 可配颜色”实为本地手工补丁，上游从不支持。
- `dist/` 入库；`registry.ts` 4081 行、`extension.ts` 1247 行单文件过大；peer 上限锁 `^0.84`。

## 对 pi-pretty-task 的意义

沿用：执行层行为细节、状态栏 + 浮层交互、完成通知卡片。重构：文件划分、配置读取、重启恢复、输出上限校验、颜色走 theme。
