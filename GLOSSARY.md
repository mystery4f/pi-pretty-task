# pi-pretty-task

一个 pi 扩展包，用一个视图管理两种 Task：跑命令的后台任务（process）和定时唤醒 LLM 的循环（loop）。

## Language

**Task**:
会话里一条可追踪的工作单位，有两种 kind：`process` 与 `loop`。两者共用 id、名字、状态与时间线，在面板里同列一张表，一起统计、一起查看。
_Avoid_: job, bg item, background job, task list entry

**Process task**:
`kind: "process"` 的 Task。它跑一条命令，有输出文件、退出码，以及被终止的原因（用户终止、超时、输出超限、进程关闭）。
_Avoid_: bg task, background job, subprocess, shell task

**Loop task**:
`kind: "loop"` 的 Task。它不跑命令；到点把一段预置的 prompt 送进会话，唤醒 LLM 跑一轮。它有间隔、prompt、最大触发次数和下次触发时间。
_Avoid_: cron, timer, scheduler, job, watcher

**Iteration**:
Loop task 的子记录。一次触发对应一条，记录那一轮里实际调用了哪些工具、跑了哪些命令。它不是 Task，不在列表里单独占一行，只在该 Loop task 的详情里展开。
_Avoid_: fire, run, round, execution

**Panel**:
打开在一屏之上的 `/tasks` 视图，两种 kind 混排。进入详情后，process 显示输出，loop 显示它的 Iteration 列表。
_Avoid_: dock, dashboard, overlay, task manager

**Status line**:
面板关闭时，状态栏上表示当前有多少 Task 在跑（或多少 Loop 在等下一次触发）的一行摘要。
_Avoid_: header, footer, ticker
