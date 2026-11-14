# Iteration 有历史上限，重启时把未完成的标记为 interrupted

Iteration 与它的 Loop task 存在同一份状态文件里，所以“记多少”不只是展示问题，还是文件体积问题。ADR-0002 只给单条 Iteration 的子记录设了上限；一个每 10 秒触发的 Loop 一天会积累 8640 条 Iteration，每条还带着自己的工具调用，状态文件会被历史撑大，每次写入都变慢、损坏时回退的代价也变大。因此历史本身也设上限：一条 Loop task 只保留最近 50 条 Iteration，被丢掉的数量累加在 `droppedIterations` 里。同时，进程重启后不可能还有“正在跑”的一轮执行：加载时把仍是 `running` 的 Iteration 标成 `interrupted`，并把其中仍在 `running` 的调用一并标成 `interrupted`，与 process task 重启后的语义一致。

## Considered Options

- **历史不设上限**：读起来最完整，但状态文件随触发次数无界增长，一次秒级 Loop 就能让每次写入付出全部历史的代价。
- **按时间 TTL 清理**：更贴近“只想看最近一天”，但 `docs/scope-v1.md` 已把 TTL 清理列为延后项，先做等于提前引入未批准的范围。
- **按条数保留最近 N 条并计数（采用）**：与子记录上限同一套思路，超出只计数；读者永远知道自己看到的是不是全量，也不需要额外的清理任务。
- **重启时把 Loop 下所有 Iteration 一起结束**：会让“Loop 没有进程、重启不结束它”这条规则失效，也会抹掉上一轮真实完成过的记录——只修 `running` 的那条边界最窄。

## Consequences

- 两条上限都是常量：单条 Iteration 最多 100 次调用（`ITERATION_CALL_LIMIT`），单条 Loop 最多 50 条 Iteration（`ITERATION_HISTORY_LIMIT`）。要变成可配置，需要另立 ADR，并说明配置错误的文案与启动校验方式。
- 截断必须被说出来，不能静默少几条：`droppedCalls` 说明这一轮少了几次调用，`droppedIterations` 说明这条 Loop 的历史少了多少轮。面板与 `loop_list` 都要把它们显示出来，否则读者会把截断当成全部事实。
- 重启修复只碰 Loop task 的 Iteration：Loop 本身没有进程，重启不会结束调度；但那一轮执行已经随进程消失，留着 `running` 只会让状态说谎。
- Iteration 不再单独生成随机 id：`fire` 编号在同一条 Loop 内唯一，足以标识一轮，也省掉了生成与校验 id 的成本。跨 Loop 引用一条 Iteration 时必须带上 Loop 的 task id。
- 归属仍然依赖事件顺序：`tool_execution_start` 不带 loop id，只能记进该 session 里最新打开的那条 Iteration。同一 session 同时有两条 Loop 在跑时，后触发的一轮会拿走先触发那轮尚未结束的调用——要修得先让 pi 的事件带上归属，而不是在这里猜。
