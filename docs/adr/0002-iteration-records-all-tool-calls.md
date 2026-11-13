# Iteration 记录该轮全部工具调用

Iteration 是 Loop task 的子记录，不是 Task：它不进面板的列表行，只在该 Loop task 的详情里展开。一次 Loop 触发唤醒的那一轮执行记为一条 Iteration，通过 `pi.on("tool_execution_start")` / `pi.on("tool_execution_end")` 把该轮内**所有**工具调用记入 Iteration，而不只是 `bg_run` 起的后台任务。

## Considered Options

- **只记后台任务**：数据量小，但 agent 用前台 `bash` 跑的命令依然不可见 —— 那正是要修的缺口。
- **记录全部工具调用（采用）**：命令可见性完整，代价是每条 Iteration 可能带着几十条子记录。

## Consequences

- 列表行只突出命令类工具（`bash`、`bg_run`）的首行，其余折叠进详情页，避免噪音。
- 需要为子记录设上限（单 Iteration 保留最近 N 条，超出只计数），否则一条长跑的 Iteration 会拖大状态文件。
- 工具调用与 Iteration 的归属依赖事件顺序：并行工具模式下 `tool_execution_start` 按助手源码顺序发出、`tool_execution_end` 按完成顺序发出，配对必须用 tool call id，不能靠位置。
