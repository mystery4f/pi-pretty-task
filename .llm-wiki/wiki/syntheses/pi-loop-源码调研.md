---
type: synthesis
title: pi-loop 源码调研
created: 2026-11-13
updated: 2026-11-13
---

# pi-loop 源码调研

调研对象：`@trevonistrevon/pi-loop` v0.7.20，license **MIT**，零 runtime 依赖。克隆在仓库 `.tmp/pi-loop-git`（git 5f58fad）。文中 `src/...:行` 均指该克隆内文件。

## 身份

- peerDeps：`@earendil-works/pi-coding-agent`、`pi-tui`、`typebox`；`"pi": {"extensions": ["./dist/index.js"]}`；入口是默认导出工厂 `export default function (pi: ExtensionAPI)`（`src/index.ts:57`）。

## 工具家族

- Loop*：`LoopCreate/List/Update/Delete`（`src/tools/loop-tools.ts:227/387/460/531`）。`LoopCreate(prompt, trigger, triggerType[cron|event|hybrid|idle], recurring, autoTask, taskBacklog, debounceMs, readOnly, maxFires, expiresIn)`。
- Monitor*：`src/tools/monitor-tools.ts:85/244/292/322`。
- 另有 Workflow*、Orchestration*、Task*（Task* 仅在 pi-tasks 扩展缺失时作为 fallback）。

## 持久化

- loops → `.pi/loops/loops-<sessionId>.json`（`src/runtime/scope.ts:22`），无常驻会话状态时落 `.pi/loops/loops.json`；tasks → `.pi/tasks/tasks-<sessionId>.json`；**Monitor 纯内存、不落盘**。
- 上限：25 个 loop（`src/store.ts:198`）、25 个 running monitor。
- 写盘是 reducer-backed store：目录锁 `.lock/owner-<pid>-<uuid>`、`O_EXCL` 临时文件 + rename + fsync（`src/reducer-backed-store.ts`）。

## 调度器

- **没有 per-entry 定时器**。`CronScheduler` 只维护 `fireTimes`/`expiryTimes` 两个 Map（`src/scheduler.ts:80-82`），由 `pump(now)` 统一派发（`:200`）。
- 泵源：30 秒 `setInterval`（`src/runtime/session-runtime.ts:13` `HEARTBEAT_MS = 30_000`，`:96-108`，`unref()`），外加 `turn_start` / `agent_end` 两个时机各 pump 一次。
- 30s 不是性能权衡：全仓库没有任何“CPU/开销”注释，`:93` 的注释只说 `unref` 是为了不让一次性 `pi -p` 挂住进程。按真实开销算，几十个 unref 定时器测不出差别。
- 唤醒 agent：`pi.sendMessage({...}, { deliverAs: "steer", triggerTurn: true })`（`src/runtime/notification-runtime.ts:446-464`）。pi-pretty-task 改用 `followUp`。

## 为什么 `/loop` 看不到具体命令

- `LoopEntry` 结构里根本没有 command 字段，只有 id/prompt/trigger/status/recurring/maxFires/fireCount（`src/types.ts:322-340`）——loop 本身就不执行命令，它只是把 prompt 送进会话。
- `/loop` 列表只显示 `prompt.slice(0, 50)`（`src/commands/loop-command.ts:209-211`）。
- 全插件里唯一带 `command` 的是 `MonitorEntry.command`（`src/types.ts:353`）。

结论：要让用户看到“这一轮实际执行了什么”，唯一出路是**记录触发那一轮的工具调用**，而不是给 loop 加 command 字段。这直接引出 ADR-0002（Iteration 记录该轮全部工具调用）。

## UI（用户不满意，需重写）

- 状态栏 `setStatus("loops", ...)`（`src/ui/widget.ts:70`）。
- 进度面板 `ProgressPanelOverlay` 用 `ui.custom(...)`（`src/ui/progress-panel-overlay.ts:123-140`），`/loop panel on|off` 切显隐（`src/commands/loop-command.ts:296-306`）。
- 可复用的是纯逻辑，不是 UI：`src/scheduler.ts`、`src/loop-parse.ts`、`src/trigger-system.ts`、`src/reducer-backed-store.ts`、`src/loop-reducer.ts`、`src/store.ts`、`src/loop-expiry.ts`（`DEFAULT_LOOP_EXPIRY_MS = 7*24*3600*1000`）。

## 工程约定（可直接照抄的部分）

- tsconfig：target/module ES2022、`moduleResolution: "bundler"`、`strict`、`noUncheckedIndexedAccess`；biome 2.x + vitest。
- `.gitignore`：`node_modules/`、`dist/`、`coverage/`、`.artifacts/`、`*.tsbuildinfo`、`.pi/`、`.DS_Store`。
