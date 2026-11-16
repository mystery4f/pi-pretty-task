---
type: synthesis
title: "verify 红测修复交接（5 个 integration 用例）"
slug: verify-red-tests-handoff
created: 2026-11-16
updated: 2026-11-16
status: open
---

# verify 红测修复交接（5 个 integration 用例）

目标：把 `verify` 工作流里 pre-existing 的 5 个红测修绿。这些失败只在 Linux runner 上出现；Windows 本地只有另外 2 个无关的 8.3 短路径失败（`C:\Users\ADMINI~1\…`，见 `test/integration/bg-run-templates.test.ts:71`、`:235`）。本机无 WSL 发行版、无 docker，无法本地复现，因此改完要靠推 CI 验证。

## 失败清单与已有判断

- `test/integration/process-shell.test.ts:383-410`「rejects a shell this platform does not have and names the ones it does」
  断言 `expect(message).toContain(onWindows ? "bash" : "inherit")`，而真实消息里 POSIX 的允许列表是 `default, bash, sh`。`src/tasks/process/shell.ts:266` 的注释明确说 `inherit` 是策略、不是每调用的值。
  判断：断言过时，改测试即可（POSIX 分支改成断言 `bash` 或 `sh`）。这跟产品行为无关。

- `test/integration/process-stop.test.ts:110-125`「waits out the grace period before forcing a command that ignores the polite signal」
- `test/integration/process-stop.test.ts:~190-205`「gives the polite signal three seconds before forcing when nothing asks otherwise」
  两个用例都 `process.on('SIGTERM', () => {})` + `setInterval`，然后**立刻** `running.stop()`。CI 报 `tookMs` = 50 / 51ms。`KILL_POLL_MS = 50`（`src/tasks/process/supervisor.ts:244`），也就是第一次轮询就判定进程树已消失。
  调用链：`supervisor.ts:196-215` `stopTree` → `signalTree(platform, "polite", pid, …)`（POSIX 用 `process.kill(-pid, "SIGTERM")`）→ `waitForTreeGone(platform, pid, graceMs)` → `isTreeAlive` = `process.kill(-pid, 0)`。
  最可能的原因（未证实）：SIGTERM 在脚本装好 handler 之前就到了（spawn → stop 几乎 0ms，node 启动约 40-80ms），于是默认动作直接终止，树瞬间消失。Windows 上同用例能过是因为 `taskkill`（不带 `/F`）对无窗口控制台程序无效，所以必然等满 3s。
  验证方向：让子脚本先写一个 ready 文件（或输出一行），测试 `waitFor` 到它之后再 `stop()`；若加了 ready 等待仍然只有 ~50ms，则是 `isTreeAlive`/`signalTree` 的真 bug，需要查 `-pid` 的组是否被 shell exec 掉。

- `test/integration/chain-tasks.test.ts:218-243`「stops the running step and marks the steps behind it stopped, not skipped」
  CI 报 `ENOENT … /tmp/pi-pretty-task-*/steps.log`。该用例 `await stores.chainTasks.stop(...)` 之后**直接** `readFile(log)` 断言 `"start long"`，而 `STEP_SCRIPT` 是异步写这一行的，所以文件可能还没创建。
  修法：先用 `waitFor("…", async () => (await readFile(log,"utf8").catch(() => "")).includes("start long"))` 收住，再做同步断言。同文件相邻用例已经在用这个模式（`waitFor("the last line of build's output", …)`），照抄即可。

- `test/integration/process-tasks.test.ts:654-675`「stops the command, records it as killed by the user…」
  断言 `resultText(await harness.call("pretty_task_bg_logs", …)).toContain("waiting")`，CI 实际拿到的是被截断的状态行 `name: long job · bg-xbnfi · process ·…`，没有 `waiting`。脚本第一行就 `process.stdout.write('waiting\n')`，但 kill 紧跟 start，node 很可能还没写出这一行就被终止。
  同样是 spawn 竞态：kill 前先 `waitFor` 到这个输出落到 log 文件，再断言。

## 结论

5 个里至少 4 个是测试自身的时序/断言问题，1 类（process-stop 两个）需要先在 Linux 上确认到底是测试竞态还是 `isTreeAlive` 的真实缺陷。改完必须推 CI（`verify`）验证，本机 Windows 只能保证不回归那 2 个既有的短路径失败。

## 关联

- [[pi-pretty-task-文档索引]]
- [[release-1-0-0-publish-support]]
- [[await-state-not-bytes-in-process-tests]]
