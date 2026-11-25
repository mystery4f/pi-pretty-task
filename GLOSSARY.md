# pi-pretty-task

一个 pi 扩展包：用一个面板管理同一套 Task，按 kind 分四类——跑命令的后台进程（`process`）、定时唤醒 LLM 的循环（`prompt-loop`）、定时跑命令的循环（`cmd-loop`），以及把多个进程排成队列的链（`chain`）。

## Language

**Task**:
会话里一条可追踪的工作单位，有一个 id（带 kind 前缀）、名字、状态与时间线。四种 kind 共用这些字段，在面板里按页分开列，计数合在一起统计。
_Avoid_: job, bg item, background job, task list entry

**Process task**:
`kind: "process"` 的 Task。跑一条命令，有输出文件、退出码，以及被终止的原因（用户终止、超时、输出超限、进程关闭）。
_Avoid_: bg task, background job, subprocess, shell task

**Llm loop task**:
`kind: "prompt-loop"` 的 Task。不跑命令；到点把一段预置 prompt 送进会话，唤醒 LLM 跑一轮。有间隔或 cron 表达式、prompt（落盘为 Prompt file）、最大触发次数、下次触发时间。
_Avoid_: cron, timer, scheduler, job, watcher, loop（单独用时含义太宽）

**Prompt file**:
Llm loop task 的提示词落盘成的那一个文件：每一发从它读出正文送进会话，所以改它不必重建 loop 就生效，改文件对下一发生效、对正在跑的 turn 不生效。地址由 loop id 派生，用户与模型都不提供路径（ADR-0024）。记录上的 `prompt` 是创建时的原文兼重建源，不是真源——只有文件缺失或不可读时才用它重建。
_Avoid_: prompt path, prompt template, template file

**Cmd loop task**:
`kind: "cmd-loop"` 的 Task。到点跑一条命令，每次触发产生一个普通的 Process task 作为子记录。和 Llm loop task 共用一个调度器，区别只在触发后做什么。
_Avoid_: shell loop, cron job, monitor

**Fire**:
任一种 loop task 的一次触发：Llm loop task 落成一条 Iteration，Cmd loop task 落成一个子 Process task。落点不同，触发本身是同一个概念，所以代码（`LoopFire`）与面板（`fire 3`）对两种 loop 都用这个词。
_Avoid_: run, tick, execution, invocation

**Foreground run**:
本扩展替内置工具 spawn、正在被某个工具调用等待的那条命令。它还不是 Task，不在面板里、没有记录；只有被改道（或跑完）时才落地。同一时刻可以有多个（并行工具调用），所以「当前前台命令」这个说法只在恰好一条时才成立。
_Avoid_: running command, live process, session command

**Detached**:
一条前台命令被改道而成的那条 Process task：进程没重启，只是不再有人等它的结果。记录带 `origin: "foreground"`，在面板里与普通 Process task 同页同行，用 `pretty_task_bg_logs` / `bg_wait` / `bg_kill` 一视同仁。改道不是失败也不是取消：Esc 仍是「杀掉」，改道是「放它走」。
_Avoid_: promoted task, adopted task, transferred job, bg-ified

**Signal**:
一次 Fire 的结局 `signalled`：Cmd loop task 声明了 `notifyExitCodes`，而这一发退出的码在列表里——检查有话说，loop 本身没坏。它不移动下次触发时刻、不进失败连击，只在闩从落着变成立起时唤醒一轮。列表外的非零码仍是 `failed`，照旧退避。手动发（`pretty_task_loop_fire`）可以记成 `signalled`，但永不立闩——手动跑一次是探针，不代表到点那一发观测到了什么。注意两层说法不同：那一发的**子进程**仍记 `failed`（进程只看得见非零退出码），`pretty_task_bg_status` / `bg_wait` 报的就是这个；`signalled` 是 loop 层的判决，看它要读 `loop_list`。
_Avoid_: alert, notification, event, warning

**Latch**:
Cmd loop task 的 `signalRaised`：信号已经报过、还没被清除。落闩只有两条路——一发 `success`（`exit 0` 就是「条件已清除」），或人手动清（`action="clear-signal"`）。被 skip 的那一发不落闩，所以漏一格不会压住下一次报告。它挂在「观测到信号」这个事件上，不是「唤醒已被处理」的账本：脚本自己记住「已通知」、条件没变就 `exit 0` 的写法完全成立，那一发顺手落闩，之后条件再变才重新唤醒。
_Avoid_: flag, state, dedupe, suppress

**Chain task**:
`kind: "chain"` 的 Task。自己不跑任何进程，只持有一条队列（`steps`，按顺序的 Process task id 数组）和游标。一次只跑一格：当前格退出码为 0 才推进；非零则链失败，余下各格标为 `skipped`；用户终止则余下各格标为 `stopped`。
_Avoid_: pipeline, workflow, DAG, batch

**Step**:
Chain task 队列里的一格，本身就是一个普通 Process task，`parentId` 指向所属链。它不单独占面板一行。
_Avoid_: stage, phase, node, stage task

**Iteration**:
Llm loop task 的子记录。一次触发对应一条，记录那一轮里实际调用了哪些工具、跑了哪些命令。它不是 Task，不在列表里单独占一行，只在该 Llm loop task 的详情里展开。
_Avoid_: run, round, execution

**Empty fire**:
一次 Fire 的 turn 正常结束、却一个工具都没调用：花了一次模型调用，什么也没推动。面板把它当事实印出来（`0 calls`），只有连续两次才标记（`2 empty in a row`）——先读文件再动手的 turn 是合法的，第一次不该被当成卡住。被 abort 或被进程带走的 turn 不算：它没得到干活的机会。
_Avoid_: idle fire, no-op, quiet run

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
面板里按 `/` 进入的过滤状态：输入即按「子序列」匹配 Name、id、命令或 prompt、状态词与 kind 词（`dbg` 能命中 `deploy-bg`）。命中的字符在行内高亮；排序先看命中质量——连续命中和词首优先、字段越短越靠前——再按 `updatedAt` 降序，空查询只按时间不重排。命中的词不在行上（`command`、`prompt`，或链自己的 name 已被步骤取代）时，行尾注明 `via command` / `via prompt` / `via name`。`alt+q` 第一次退出搜索并保留过滤条件，再按一次关闭面板。
_Avoid_: filter box, query mode, find
