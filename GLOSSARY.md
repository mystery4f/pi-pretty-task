# pi-pretty-task

一个 pi 扩展包，用同一个视图管理后台任务（bg）与定时任务（loop）。

## Language

**Task**:
一条后台进程的执行记录，从启动到结束（或被终止）为止。
_Avoid_: job, bg item, background job

**Loop**:
一条调度定义，到点时把一段预置的 prompt 送进会话，唤醒 LLM 跑一轮。Loop 本身不执行命令。
_Avoid_: cron, scheduler, timer, job

**Iteration**:
Loop 的一次触发所唤醒的那一轮执行，记录这一轮里实际调用了哪些工具、跑了哪些命令。
_Avoid_: fire, run, round

**Panel**:
打开在一屏之上的任务列表视图，可进入单条任务的详情页。
_Avoid_: dock, dashboard, overlay

**Status line**:
面板关闭时，状态栏上表示当前在跑多少任务的一行摘要。
_Avoid_: header, footer, ticker
