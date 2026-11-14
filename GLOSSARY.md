# pi-pretty-task

一个 pi 扩展包：用一个面板管理同一套 Task，按 kind 分四类——跑命令的后台进程（`process`）、定时唤醒 LLM 的循环（`llm-loop`）、定时跑命令的循环（`cmd-loop`），以及把多个进程排成队列的链（`chain`）。

## Language

**Task**:
会话里一条可追踪的工作单位，有一个 id（带 kind 前缀）、名字、状态与时间线。四种 kind 共用这些字段，在面板里按页分开列，计数合在一起统计。
_Avoid_: job, bg item, background job, task list entry

**Process task**:
`kind: "process"` 的 Task。跑一条命令，有输出文件、退出码，以及被终止的原因（用户终止、超时、输出超限、进程关闭）。
_Avoid_: bg task, background job, subprocess, shell task

**Llm loop task**:
`kind: "llm-loop"` 的 Task。不跑命令；到点把一段预置 prompt 送进会话，唤醒 LLM 跑一轮。有间隔或 cron 表达式、prompt、最大触发次数、下次触发时间。
_Avoid_: cron, timer, scheduler, job, watcher, loop（单独用时含义太宽）

**Cmd loop task**:
`kind: "cmd-loop"` 的 Task。到点跑一条命令，每次触发产生一个普通的 Process task 作为子记录。和 Llm loop task 共用一个调度器，区别只在触发后做什么。
_Avoid_: shell loop, cron job, monitor

**Fire**:
Cmd loop task 的一次触发，落在一个子 Process task 上。它有自己的输出文件与退出码，不是独立记录类型，只在所属 Cmd loop task 的详情里列出。
_Avoid_: run, tick, execution

**Chain task**:
`kind: "chain"` 的 Task。自己不跑任何进程，只持有一条队列（`steps`，按顺序的 Process task id 数组）和游标。一次只跑一格：当前格退出码为 0 才推进；非零则链失败，余下各格标为 `skipped`；用户终止则余下各格标为 `stopped`。
_Avoid_: pipeline, workflow, DAG, batch

**Step**:
Chain task 队列里的一格，本身就是一个普通 Process task，`parentId` 指向所属链。它不单独占面板一行。
_Avoid_: stage, phase, node, stage task

**Iteration**:
Llm loop task 的子记录。一次触发对应一条，记录那一轮里实际调用了哪些工具、跑了哪些命令。它不是 Task，不在列表里单独占一行，只在该 Llm loop task 的详情里展开。
_Avoid_: fire, run, round, execution

**Schedule**:
一次触发的时间规则，两种写法归一成一个「下次触发时刻」函数：间隔简写（`30s`、`10m`、`2h`）与五段 cron 表达式（`0 9 * * 1-5`，本地时区）。六段（含秒）明确拒绝，秒级改用间隔。
_Avoid_: trigger, timer, recurrence

**Name**:
一条 Task 的用途描述，人写给未来的自己看，例如“为 CI 生成 changelog”。它不承担区分职责（那由 id 前缀承担），也不重复命令原文；缺省时回退到派生值（进程取命令首行，循环取 prompt 首行，链取第一格的名字）。
_Avoid_: label, title, description, 任务名

**Panel**:
打开在一屏之上的 `/tasks` 视图，三个标签页：`Processes`、`Loops`、`Chains`。每页只列根（链的步骤与命名循环的触发布单独成行），展开根才看到它的步骤、触发或 Iteration。
_Avoid_: dock, dashboard, overlay, task manager

**Summary line**:
面板关闭时，编辑器上方那一行：有多少 Task 在跑、多少已结束，以及怎么再打开面板。它不占状态栏那一行，因为状态栏是与其它扩展共用的。
_Avoid_: status line, header, footer, ticker

**Search mode**:
面板里按 `/` 进入的过滤状态：输入即按子串匹配 Name、id、命令或 prompt、状态词与 kind 词；`alt+q` 第一次退出搜索并保留过滤条件，再按一次关闭面板。
_Avoid_: filter box, query mode, find
