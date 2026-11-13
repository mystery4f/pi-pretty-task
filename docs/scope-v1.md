# pi-pretty-task · v1 范围

第一版只做一种 Task 的两个 kind：`process`（后台进程）与 `loop`（定时唤醒，带子记录 Iteration），共用同一个 Panel。
本文档回答三个问题：**做了什么、没做什么、没做的以后怎么开**。任何“延后”都必须写明原因与解锁条件，不允许无声缺失。

## 已定的事实前提

- pi 扩展提供 `pi.on("tool_execution_start")` / `tool_execution_end`（`docs/extensions.md:788-810`），可观测每一轮里的全部工具调用。
- 唤醒 LLM 用 `pi.sendMessage(payload, { deliverAs: "followUp", triggerTurn: true })`；pi-loop 用的是 `deliverAs: "steer"`（`src/runtime/notification-runtime.ts:446-464`），我们改用 `followUp` 排队。
- TUI 能力：`ctx.ui.setStatus`（状态栏一行）、`ctx.ui.setWidget`（编辑器上方常驻区）、`ctx.ui.custom`（浮层）、`pi.registerMessageRenderer`（自定义消息卡片）。

## 做（v0.1）

### Task · `kind: "process"`（后台进程）

| 能力 | 说明 | 复杂度 | 风险 |
|---|---|---|---|
| `bg_run` | 起后台进程，返回 id/PID/输出路径 | 中（Windows `cmd.exe /d /s /c` + POSIX `bash -c`、进程组、输出流） | 中：Windows 参数转义 |
| `bg_status` | 单条或全部快照 | 低 | 低 |
| `bg_logs` | 尾部输出拉取（供无 UI 场景与 agent 自查） | 低 | 低：需自带上限，防上下文被灌 |
| `bg_kill` | 先 SIGTERM/`taskkill /T`，宽限后强杀整棵进程树 | 中 | 中：残留后代进程 |
| 输出落盘 | `.pi/tasks/<sessionId>-<pid>/<taskId>.output` + `.json` | 低 | 低 |
| 输出上限 | 单任务 20MiB 后截断并终止 | 低 | 低（上游此处有 NaN 缺陷，我们做校验） |
| 完成通知 | `registerMessageRenderer` 渲染完成卡片 | 低 | 低 |

### Task · `kind: "loop"`（定时唤醒）与其子记录 Iteration

| 能力 | 说明 | 复杂度 | 风险 |
|---|---|---|---|
| `loop_create` | 间隔触发（`10s`/`5m`），投 prompt 唤醒 LLM | 中（定时器 + 唤醒投递） | 中：与 agent 忙碌状态交错 |
| `loop_list` / `loop_update` / `loop_delete` | 增删查改、暂停/恢复、`maxFires`/`expiresIn` | 低 | 低 |
| Iteration 记录 | 每次唤醒生成一条 Iteration，挂该轮全部工具调用（命令、起止时间、结果） | 中（事件订阅 + 归属判定） | 中：并行工具调用顺序 |
| 排队投递 | 到点时 agent 忙 → 排队到本轮结束（`followUp`） | 低 | 低 |
| 上限 | Loop ≤ 50、running Task ≤ 20 | 低 | 低 |

### Panel 与 Status line

| 能力 | 说明 | 复杂度 | 风险 |
|---|---|---|---|
| 状态栏摘要 | `pi-pretty-task · 1 running · 2 loops` | 低 | 低 |
| `/tasks` 浮层 | 一张表混排两种 kind，行内显示 kind 标记、名字、状态、耗时，process 额外显示输出大小、loop 额外显示下次触发 | 中（`ctx.ui.custom` + 键盘交互） | 中：终端尺寸与滚动 |
| 详情页 | process：完整命令、输出尾部、退出码，`↑/↓` 滚动、`r` 恢复跟随、`←` 返回；loop：prompt、下次触发、Iteration 列表，进入 Iteration 看该轮工具调用 | 中 | 中 |
| 快捷操作 | `k` 停止、`a` 全部停止、`x` 关闭、`l` 按 Loop 过滤 | 低 | 低 |

### 持久化与恢复

| 能力 | 说明 | 复杂度 | 风险 |
|---|---|---|---|
| 只读历史恢复 | 启动时回读 `.pi/tasks/*.json`，历史任务进面板；残留 `running` 标 `interrupted` | 中（回读 + 去重 + 时间戳） | 中：跨会话归属 |
| 不接管进程 | 绝不尝试复活或接管上次遗留的进程 | — | — |

## 不做（明确移除）

| 移除项 | 来源 | 原因 |
|---|---|---|
| `bg_delegate` / `bg_result` / `fusion_*` | pi-background-tasks | subagent 能力已由其他插件承担，本插件不做第二套 |
| `bg_run_pi_attested` | pi-background-tasks | 依赖 provider/model 校验链路，与两个核心目标无关 |
| `anthropic-attribution` 扩展 | pi-background-tasks | 与本插件目标无关的独立扩展 |
| 自动更新检查 | pi-background-tasks | 引入网络请求与注册表依赖 |
| `Monitor*` 全家 | pi-loop | 被 Task + Iteration 取代；且它不落盘，正是要修掉的问题 |
| `Workflow*` / `Orchestration*` / `Task*` | pi-loop | 多控制器领域逻辑，与“看得到命令”的目标无关 |
| 常驻 dock widget | — | 见 ADR-0003 |

## 延后（有解锁条件）

| 延后项 | 原因 | 解锁条件 | 预估复杂度 |
|---|---|---|---|
| Loop 直接执行 shell 命令（不唤醒 LLM） | 与“Loop = 唤醒 LLM”的模型冲突；先做对一种 | 第一版 Iteration 模型稳定后，作为 `kind: "shell"` 另开 ADR | 中 |
| 严格 cron 表达式 | 需要 cron 解析器 + 秒级语义边界；间隔触发已覆盖 90% 用法 | 出现“必须整点跑”的真实需求 | 中 |
| event / idle 触发 | 事件源语义（哪些事件、怎么去抖）需要单独设计 | 定时触发验证完成后 | 中 |
| 重启后进程接管/复活 | 跨会话接管进程的收益低、误杀风险高 | 明确出现“长任务跨重启”刚需 | 高 |
| `.pi/tasks/` TTL 自动清理 | 只读恢复已能消除“面板消失”的痛点；清理涉及误删风险 | 磁盘目录体量成为实际困扰时 | 低 |
| 重叠执行策略（`overlap: skip｜queue｜allow`） | 唤醒型 Loop 没有“上一次还在跑”的命令并发问题，只有排队 | 引入 shell 型 Loop 时一并设计 | 中 |
| 亚秒级 / 最小 1s 边界 | 唤醒 LLM 的最小有意义周期远大于 1s | 无（属于无意义优化） | — |

## v0.1 验收（五条）

- Windows 上跑通一条 10 分钟长任务，进程不掉。
- `/tasks` 能看到输出持续滚动。
- `k` 能杀掉整棵进程树，含子进程，无残留。
- 一个 `10s` 间隔的 Loop 连续触发 5 次，每次在面板里作为一条 Iteration 可见，且能看到该轮执行的命令。
- 重启后历史任务仍在面板中，残留 `running` 显示为 `interrupted`。
