# Task 是 process 与 loop 的上位概念

`bg`（跑命令的后台任务）与 `loop`（定时唤醒 LLM）从用户视角是同一件事：一条被命名的、有状态、可以查看和终止的工作单位。因此把 `Task` 定为上位概念，用 `kind` 区分两个子类型：`process` 与 `loop`。两者共用 id、名字、状态、时间线与同一张面板表格。

## Considered Options

- **两个并列概念，各自一套列表**（最初的写法）：模型简单，但面板要么两个页签、要么一个列表里塞两种语义不同的行，用户得先学两套词。
- **Task 统一、Loop 是 Task 的一种（采用）**：一个词、一张表、一套查看动作；代价是 Task 的记录里有一部分字段只对其中一种 kind 有意义（命令/输出/退出码只属 process，间隔/下次触发只属 loop），需要按 kind 收窄类型而不是塞进一个大对象。迭代是 Loop 的子记录，不进列表，避免刷屏把 process 任务挤走。

## Consequences

- 记录按 `kind` 判别联合类型，`process` 与 `loop` 各自只带自己的字段；共字段（id、name、status、createdAt、endedAt）在上层。
- 面板只有一张表、一套键位（`Enter` 详情、`k` 终止、`x` 关闭）；`k` 对 process 是杀进程组，对 loop 是停这条调度。
- 目录跟着模型走：`src/tasks/base` 放共用类型与存储，`src/tasks/process` 与 `src/tasks/loop` 各放自己的实现，`src/ui` 只读共用类型。
- 工具名不跟着改：`bg_*` 保持与上游一致（卸载上游后无缝），`loop_*` 保持调度语义。
