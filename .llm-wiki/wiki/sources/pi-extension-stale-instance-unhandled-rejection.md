---
type: source
title: pi 扩展实例失效后的 sendMessage 抛出会杀死进程
status: insight
category: pi-plugin
created: 2026-11-24
updated: 2026-11-24
slug: pi-extension-stale-instance-unhandled-rejection
---

# pi 扩展实例失效后的 sendMessage 抛出会杀死进程

## 机制

pi 在 `ctx.newSession()` / `ctx.fork()` / `ctx.switchSession()` / `ctx.reload()` 之后，把旧实例的整个 runtime `invalidate()`：此后旧实例里捕获的 `pi` 或命令 `ctx` 上任何 `pi.sendMessage(...)` 都抛

```
Error: This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload()
```

pi 内部由 `ExtensionRuntimeState.assertActive()` 实现，**没有公开的探活 API**，只能靠 `session_shutdown` 事件自己记。

## 危险形态：后台任务比实例活得长

`onFinish` 里写 `void notifyTaskFinished(pi, view)` —— 没有 await、没有 catch。`sendMessage` 的同步抛出让这个 async 函数返回 rejected promise，而 Node 默认 `--unhandled-rejections=throw`，于是整个 pi 进程退出。实际事故现场是 `src/ui/notification.ts:110` 的 `pi.sendMessage`，栈顶出现在 `notifyTaskFinished` 的调用行。

## 修法（pi-pretty-task 已落地）

通知层不再接收 `ExtensionAPI`，改成注入 sender，生命周期只在一处判断：

```ts
let live = true;
const sendNotice: NoticeSender = (notice) => {
  if (!live) return;
  pi.sendMessage({ ...notice, display: true }, { deliverAs: "steer", triggerTurn: true });
};
// session_shutdown 处理器第一行：live = false;

void notifyTaskFinished(sendNotice, view).catch(reportNoticeFailure);
```

失效后静默丢弃是对的：磁盘上的任务记录才是真相，接手的实例重新读面板就能看到结束。

同族陷阱：`pi.events.emit` 在失效实例上一样会抛，所以 fire-and-forget 的 `publish()` 必须自带 try/catch（`src/tasks/base/events.ts` 早已这么做）。

## 测试侧要能复现

回归不可断言就没有意义。测试 harness 需要模拟失效：`shutdownSession()` 先按注册顺序跑 `session_shutdown` 处理器，再把 `stale = true`，此后 `sendMessage` 抛出与生产同文的错误。

断言时机同样关键：任务记录先落盘、通知在一个微任务之后才发出，只轮询记录状态会在"还没抛"的时刻通过。用完成事件（bus 上的 `pi-pretty-task:task-finished`）加 ~200ms 沉降定位到抛出之后，测试才能在没有修复时变红。

相关：[[sources/obs-2026-11-17-pi-dev-gallery-index-misses-pi-pretty-task-publish-event]]


*Category: pi-plugin*

---
*Captured: 2026-11-24*

## Related

_Add links to related pages._
