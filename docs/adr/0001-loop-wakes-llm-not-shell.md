# Loop 唤醒 LLM，不执行 shell 命令

Loop 到点时通过 `pi.sendMessage(prompt, { deliverAs: "followUp", triggerTurn: true })` 把一段预置 prompt 送进会话，唤醒 agent 跑一轮。Loop 自身不持有 `command` 字段，也不 spawn 任何进程；命令只可能来自被唤醒的这一轮里 agent 调用的工具。

## Considered Options

- **cron 化的后台命令**：Loop 直接跑一条 shell 命令。实现简单、命令天然可见，但那是进程调度器，不是 agent 调度器，与“让 agent 定时继续工作”的诉求不同。
- **唤醒 LLM（采用）**：Loop 是唤醒器，执行内容由 agent 决定。

## Consequences

“看到具体执行了什么命令”不再是 Loop 的字段问题，而必须在 Iteration 层解决（见 ADR-0002）。这也意味着一个 Loop 的一轮可能一条命令都不跑，Iteration 必须能表示“只有推理、无工具调用”。
