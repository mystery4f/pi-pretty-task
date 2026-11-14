# 唤醒只交给空闲的 agent，Iteration 绑定它唤醒的那一轮

`pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` 在 agent 正在跑的时候不会立刻进入会话：pi 把它排进自己的 follow-up 队列，等这一轮没有更多工具调用时才投递，而 pi 没有提供撤回这条队列的接口。于是「记在 Loop 上的一次触发」和「模型真正被唤醒」之间隔着一段扩展看不见、也控制不了的时间。测试会话里出现过两种后果：一条已记录为 `fires 2/2 status completed` 的 Loop 又送来了第三次 `[loop-test 触发]`；一条 `* * * * *` 的 Loop 在 05:56:07 完成，唤醒却在 05:56:32 送到。`loop_update action=complete`、`loop_delete` 或 `maxFires` 到顶之后，那次唤醒照样到达，记录和实际执行对不上。

因此唤醒不再直接交给 pi。扩展自己维护一个待发队列：`pump` 只记录触发（`fires` 加一、写盘、打开一条待定的 Iteration）并入队，从不调用 `sendMessage`；只有 agent 空闲时才清空队列。空闲状态用 `agent_start` / `agent_settled` 跟踪，`session_start` 视为空闲。清空发生在三处：`agent_settled` 的处理器里（先 `settle` 上一轮，再发唤醒，这样每条唤醒都属于它自己唤醒的那一轮）、`session_start`、以及 `pump` 之后（空闲时同一次调用内投递，忙碌时只入队）。投递与否在**清空时**判断，不在入队时判断：Loop 仍是 `running` 才发；用掉最后一个 `maxFires` 的那次触发虽然已经把 Loop 标成 `completed`，但它正是模型该被唤醒的理由，仍然发出。其余已停止的 Loop（pause、complete、过期、delete）的唤醒静默丢弃，`loop_update` / `loop_delete` 在返回前就把它从队列里摘掉。

同一时刻只能有一轮执行，所以一条 Iteration 必须绑定到它唤醒的那一轮，而不是「触发时最新的那条」。`open(fire)` 先落一条待定记录（状态仍是 `running`，调用为空）；唤醒真正交给 pi 之后调用 `bind(fire)`，`recordStart` 只把调用记进已绑定且仍打开的 Iteration，`settle` 只关闭已绑定的那些。唤醒被取消时待定记录一并删除——没有发生的那一轮不该留下记录；进程崩溃留下的待定记录在加载时和已绑定的 `running` 记录一样被修成 `interrupted`（ADR-0007）。`pump` 本身也串行化：定时器和 `turn_end` 可能同时到达，两次 `pump` 读到同一个 `nextFireAt` 会把同一条 Loop 触发两次。

## Considered Options

- **维持现状，发出去就不管（不采用）**：pi 的 follow-up 队列不可撤回，Loop 停止后唤醒仍会到达，记录与执行永久对不上。
- **忙碌时根本不 pump（不采用）**：省掉队列，但触发时刻被推迟到下一轮结束，`lastFireAt` 与 Iteration 的 `startedAt` 都不再是计划到点的时间，倒计时和列表会跟着说谎；过期判断也会被推迟到下一次空闲。
- **自己排队、只对空闲 agent 投递（采用）**：触发在到点时如实记录，投递等空闲；取消能真正生效，代价是最多延迟一轮的时间。
- **把队列持久化（不采用）**：进程重启时正在跑的那一轮已经随进程消失，持久化的唤醒没有可唤醒的对象；重启修复只需把记录标成 `interrupted`。
- **给 Iteration 增加持久化的 `pending` 状态（不采用）**：`IterationStatus` 是面板颜色与文案的键，新增状态会把改动推到面板；「待定」只是本进程内的绑定标志，落盘后仍由 `running` + 重启修复表达。
- **把唤醒塞进 `turn_end` 而非 `agent_settled` 发出（不采用）**：`turn_end` 之后还可能有重试、压缩或队列中的续跑，pi 仍会把消息排进同一轮，等于没有等待空闲。

## Consequences

- 忙碌的 agent 会延迟唤醒，而不是丢掉唤醒：倒计时是墙钟数字，到点就记 `fires`，投递等 `agent_settled`。延迟期间面板与 `loop_list` 显示的是真实触发次数。
- 延迟也可能让唤醒失效：如果 Loop 在投递前过期或被暂停、完成、删除，那次唤醒被丢弃，Loop 的记录按它自己的状态收尾——读者不会看到一个已完成的 Loop 又醒来。
- `maxFires` 的最后一次触发一定送达且只送一次；之后 `pump` 不再触发它，重复的 `agent_settled` 也不会重发。
- Iteration 的归属仍然受 pi 事件不带 loop id 的限制（ADR-0002、ADR-0007）：一次清空可能同时投递多条 Loop 的唤醒，它们排进 pi 的 follow-up 队列后若被合并进同一轮执行，这一轮的调用仍只会记进最新绑定的那条 Iteration。要彻底解决需要 pi 的事件带上归属，而不是在这里猜。
- 唤醒已发出、进程随即崩溃时，那条 Iteration 在盘上仍是 `running`，加载时被修成 `interrupted`：记录说的是「这一轮没跑完」，不会伪装成完成。
- `pump` 串行化是单飞链：后来者等待前一次结束后再读 `nextFireAt`，同一时刻两次 `pump` 只产生一次触发。代价是 pump 的延迟会顺延到下一次，但触发次数不会重复。
- 测试通过扩展边界驱动这条路径：`pump(at)` 返回本次记录的触发，`flushWakes()` 执行一次清空；工具面对调用者不变，仍然只有 `loop_create` / `loop_list` / `loop_update` / `loop_delete`。
