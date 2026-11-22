# 0021 — 任务结束通知用 steer 投递

## 状态

已接受（2026-11-22）

## 背景

每条前台任务结束都会往会话里发一条通知（`src/ui/notification.ts` 的 `notifyTaskFinished`，issue #15）。它原来的投递方式是 `{ deliverAs: "followUp", triggerTurn: true }`，理由和 Loop 唤醒一致：不打断正在跑的一轮。

ADR-0009 已经记下 `followUp` 的一个代价——排队之后 pi 没有撤回接口。2026-11-22 实测时撞上第二个代价：**这条通知会丢**。

三条任务的实际时序（同一会话，日志 `2026-11-22T10-18-44-558Z`）：

- `bg-uznhw` 14:24:37 结束，当时 agent 空闲 → 通知在 14:24:42 到达，会话里落下一条 `custom_message`。
- `bg-4321x` 14:27:23 结束，当时 agent 正在一轮里跑工具 → 通知等这一轮结束才到（14:28 之后那条 `mid-turn probe` 通知）。可见 `followUp` 在轮内会被正确排队。
- `bg-kqtt9` 14:12:42 结束，当时 agent 正在一轮里（该轮到 14:13:15 才结束），用户在 14:13:16 发来新消息。**通知从此消失**：会话日志里既没有 `custom_message`，也没有 `read more: pretty_task_bg_logs id=bg-kqtt9`——同一会话里其他任务的同类通知都在。

也就是说，丢的窗口只有一秒：`followUp` 等到「本轮没有更多工具调用」那一刻投递，用户输入恰好在这之前落地时，这条排队消息就没了。扩展侧无法感知、也无法补发——pi 不告诉我们队列里发生过什么。

## 决策

**任务结束通知改用 `{ deliverAs: "steer", triggerTurn: true }`。**

- `steer` 在「当前助手回合的工具调用执行完、下一次 LLM 调用之前」投递。这正是通知有用的时刻：模型下一步动作之前就知道某条任务已经结束，而不是等整轮跑完才被告知。
- 线程安全上没有新问题：通知内容本来就短（几行状态 + 尾部输出），投递时点比 `followUp` 早，语义不变。
- `triggerTurn: true` 保留：agent 空闲时结束的任务照样立即唤醒一轮。

**Loop 唤醒仍然用 `followUp`**（ADR-0001、ADR-0009、ADR-0017 不动）。区别是意图：一次唤醒可能带一段要模型立刻执行的 prompt，赶在一轮中间插进去会打断正在进行的工作；而任务结束通知只是陈述一件已经发生的事，「晚一点知道」比「打断」便宜。ADR-0009 记录的那些排队代价（记录与实际触发对不上）针对的也是唤醒，与这里无关。

## 代价

- 一轮里连续跑工具时，任务结束通知会在下一次 LLM 调用前插进来。模型可能因此提前结束手头的工作去看那条任务；对一个正在写文件的流程来说，这是新出现的一次打断。
- 通知不再和「本轮结束」对齐，连续结束多条任务时它们会分别插进同一轮的不同间隙，而不是攒到轮末一起出现。

## 相关

- `src/ui/notification.ts`：`notifyTaskFinished` 的 `deliverAs`。
- `test/integration/completion-notice.test.ts`：断言投递方式的那条用例。
- `docs/adr/0009-wakes-wait-for-idle-and-bind-their-turn.md`：`followUp` 排队的原始代价，针对 Loop 唤醒。
- `docs/adr/0001-loop-wakes-llm-not-shell.md`：Loop 唤醒用 `followUp` 的出处。
