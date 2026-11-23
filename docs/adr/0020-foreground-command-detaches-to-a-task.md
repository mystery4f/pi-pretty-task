# 0020 — 前台命令改道为 Process task

## 状态

已接受（2026-11-22）

## 背景

今天只有一条路进后台：先决定用 `pretty_task_bg_run`，再起进程。跑起来以后没有第二条路——agent 的内置 `bash` 把这一轮卡住，`!cmd` 把你盯着的屏幕卡住，中途想放它去后台只能等它结束或把它杀掉。

内置 `bash` 只有两个参数 `command`、`timeout`，没有后台模式；超时到点用 `taskkill /T` / 组信号杀整棵树（`pi-coding-agent/dist/core/tools/bash.js:95-115`）。一条跑到 8 分钟的构建，被超时或 Esc 打断就是这 8 分钟白烧，而且很多命令（迁移、发版脚本）不能重跑。

技术上只有一种做法：**改道只对「我们自己 spawn 的进程」成立**。`tool_call` 事件在工具执行之前触发，一条 MCP 或自定义工具的 `execute()` 一旦开始，扩展手里没有任何句柄——中途接管不可能。内置 `bash`/`powershell` 能被接管，是因为官方允许用同名 `registerTool` 顶掉它（`docs/extensions.md`「Overriding Built-in Tools」），配 `createBashTool(cwd, { operations })` 自带 spawn，子进程句柄归我们；`!` 命令同理，`user_bash` 事件可拦截并交出我们自己的 `operations`。

## 决策

**前台命令由本扩展 spawn，改道只是「不再等待它」。**

- **覆盖范围**：`bash` 与 `user_bash`；`powershell` 在 Windows 上仍由本扩展注册，但自 ADR-0022 起跑 pi 自带的 PowerShell 操作、不改道。覆盖默认关闭，`PI_PRETTY_TASK_ADOPT_FOREGROUND=on` 才生效——所有 bash 调用都要经过我们的 spawn，一个 bug 就砸在 agent 最主要的工具上，不该是默认行为。
- **改道语义**：进程不重启、不复制、不换 PID。改道那一刻起不再把输出当作工具结果等待，输出继续写入任务输出文件，原工具立即返回。Esc 取消仍按 pi 的老规矩杀整棵树——快捷键与超时是「放它走」，Esc 是「让它死」，两件事不混。
- **记录形态**：改道后是一条普通的 `kind: "process"` Task，带来源字段 `origin: "foreground"`。不新增 kind，面板不加页，`pretty_task_bg_logs` / `bg_wait` / `bg_kill` 照常可用。术语见 `GLOSSARY.md` 的 `Detached`。
- **上限**：计入 `maxRunningTasks`（20）。撞上限时改道失败、命令继续在前台跑——上限的意思是「不许再开」，不是「必须死」。
- **快捷键只认唯一一条**：并行工具调用会让「当前前台命令」不唯一。此时按键只给一条提示（有 N 条在跑，去 `/tasks` 挑），不替你选；选错一条改道比不改道更贵。
- **超时**：`PI_PRETTY_TASK_FOREGROUND_TIMEOUT`，单位秒，`0` 为关（默认）。到点自动改道而不是杀掉；与内置 `timeout` 参数是两件事，后者仍是「到点就杀」。更大的值会被拒绝：Node 把超过 2147483 秒的延时钳到 1ms，「到点改道」就成了「每条命令瞬间改道」。
- **回执**：agent 侧拿到一条成功结果的变体——已捕获输出（同样受 20MiB 上限）、任务 id、「用 `pretty_task_bg_logs`/`bg_wait` 跟进」的提示，不给退出码（它还没退出）。`!` 侧输出框保留已捕获内容，末尾一行 `↪ moved to bg-xxx`。两边都不许把改道渲染成失败。
- **不做**：任意外来工具转后台（被否决的 idea B）。没有句柄就没有改道；`docs/scope-v1.md` 的延后表记下它与解锁条件。

## 代价

- 覆盖生效时，每一条 bash 调用都多一层我们的 spawn 与输出缓冲；这一层有 bug，agent 的日常工具就不可用。
- 改道前的前台命令不在任何记录里。`session_shutdown` 会把仍在前台的命令逐个放走、落成记录，所以重载能按 id 追；进程崩溃或断电没有关停事件，仍然什么都不留（不更差，但也没更好）。
- 改道后没有 pi 的实时输出块，只有任务输出文件；盯着屏幕等最后一行的人要改用面板。
- 快捷键与超时两条路径共用改道接缝，任何一边的 bug 都影响另一边。

## 相关

- 术语与派生记录的关系：[`GLOSSARY.md`](../../GLOSSARY.md)（`Detached`、`Process task`、`Fire`、`Step`）
- shell 选择与解码：[ADR-0008](0008-shell-choice-and-output-decoding.md)
- 上限与终止原因：[`docs/configuration.md`](../configuration.md)
- 范围与延后项：[`docs/scope-v1.md`](../scope-v1.md)
