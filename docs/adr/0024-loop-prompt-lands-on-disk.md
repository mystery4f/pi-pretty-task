# 0024 — Loop 的提示词落盘，路径由 id 派生

## 状态

已接受（2026-11-25）。实现见 [#44](https://github.com/mystery4f/pi-pretty-task/issues/44)。

## 背景

Prompt loop 的提示词是创建时冻结在记录里的一个字符串（`src/tasks/base/task.ts:194-201` 的 `readonly prompt: string`），整条触发链上没有任何一处碰磁盘：pump 在 `src/tasks/loop/loop-tasks.ts:823-836` 造 `LoopFire`，`src/ui/loop-wake.ts:35-46` 的 `sendLoopWake` 把 `fire.task.prompt` 原样当作消息体发出去。

对无人值守的长跑，这带来一个具体痛点：跑完一晚发现提示词措辞不对（漏了一句"先读进度文件"，或多了一句会带偏的话），唯一的改法是删掉 loop 重建，而 iteration 历史挂在 loop 记录上（`ITERATION_HISTORY_LIMIT = 50`，`src/tasks/loop/iteration.ts:21`），一删全没。改写提示词不该以丢失历史为代价。

同时必须挡掉一个诱惑：让用户或模型传一个路径进来（`promptFile` 参数）。那会引入"两份来源二选一"的校验、相对路径基准、以及一个可以从任意位置读文件的口子——需要向用户解释的接口是坏接口，且这是 AI 自己也会调的工具，路径不该由它指定。

## 决策

**提示词落盘为文件，路径完全由 loop id 派生，任何一方都不提供路径。**

- **唯一根**：`sessionTaskDirectory(scope.cwd, scope.sessionId)`，即 `<cwd>/.pi/tasks/<safeSegment(sessionId)>/`（`src/tasks/base/runtime-state.ts:27-29`）。与任务记录、进程输出文件同一个目录，不新增目录层级，不落进源码树，不落进 home，绝不触碰 `.git`。`.pi/` 已在 git 忽略范围内。
- **文件名由 id 派生**：`<safeSegment(loopId)>.prompt.md`，与 `<taskId>.output` 同形（`src/tasks/base/runtime-state.ts:57-60`）。`safeSegment` 已消掉 `..`、前导点和非法字符（`runtime-state.ts:13-20`），因此不存在穿越、不存在碰撞、不跟随 loop 的 `name`。
- **不提供路径参数**：没有 `promptFile`，没有 `--from`。对外的 API 一个字都不变，用户仍然只传 `prompt`。想要仓库里的某份文本，就把内容粘进来，不要给它一条路径。
- **AI 侧没有任何路径权力**：文件由插件创建，地址由 loop id 派生；工具参数里不存在「路径」这一项，因此模型无从选择写到哪里。模型从 `pretty_task_loop_create` 的返回值与 loop 详情的 `prompt: <path>` 得知唯一生效地址，用普通编辑工具改它。写到别处的文本对 loop 零效果——每一发只读派生出来的那一条路径，写错地方只是白写，不存在"生效了一半"。模型能造成的唯一损坏是改坏或删掉这一个文件，由记录副本重建兜住。
- **插件只在两个时刻写**：创建 loop 时把 `prompt` 原样写入一次（原子写，临时文件 + rename，与记录文件同一手法）；文件缺失或不可读时，用记录里的 `prompt` 重建一次，并记一条 warning。其余时刻只读。
- **每一发读一次**：pump 在触发时 `readFile`，把文本放进 `LoopFire.prompt`；`sendLoopWake` 改用 `fire.prompt`，不再读记录上的字段。改动对**下一发**生效，对正在排队或正在跑的 turn 不生效。
- **读失败不暂停**：文件丢了、权限变了、内容不是合法 UTF-8，都照常发一发——能重建就用重建后的文本，重建失败就发一条诊断（"读不到 `<path>`：<原因>"）并让 loop 继续跑。无人值守最坏的结果是"悄无声息地停了"，不是"多发了一条诊断"。
- **记录里的 `prompt` 保留**，语义变成"创建时的原文 + 最后一次可用的文本"，作为重建源与旧记录兼容路径：老 loop 没有对应文件，第一次触发时补落盘。详情页 `src/tasks/loop/tools.ts:173` 由 `prompt: <全文>` 改为 `prompt: <path>`，面板 detail 同源，人能看见地址，AI 也用普通 `write` 改同一个地址。
- **地址出现在模型会读的每一处**：`describeLoop`（`src/tasks/loop/tools.ts:150-197`）是 `create`（:435）、`list`（:489）、`update`（:526）共用的唯一投影，改 `tools.ts:173` 一行即可让三处都印出绝对路径；结构化 `loopDetails` 同时带上 `promptFile` 字段供程序化取用。压缩或换会话之后，模型只靠 `pretty_task_loop_list id=<id>` 就能重新拿到地址，不依赖创建时的返回。
- **生命周期**：删除 loop 连带删除文件；`pruneOldSessions` 已按目录清扫，无需另写清理逻辑。改名不影响路径。

## 代价

- 同一段文本存在两份副本（文件与记录），人以编辑器改文件后，记录里那份 `prompt` 会变旧。这是有意的：副本是重建源，不是真源；代价是详情页必须显式给出路径，且在用了重建副本时说明"当前内容来自记录副本"。
- 因为路径不可由外部指定，删掉了"指向仓库里那份提示词"的用法。这是换取"没有路径校验、没有穿透面"的代价，属于故意更窄。
- 每一次触发多一次 `readFile`。对分钟级以上的调度，这是噪声。
- 老 loop 第一次触发会多一次落盘写入，属于一次性迁移。

## 被否决的方案

- **加 `promptFile` 参数**：把路径交给用户/模型 → 需要归一化包含性校验、相对路径基准、以及一条新的失败态。否决。
- **wrapper 每次读文件再重建 loop**：能改提示词，但重建会清掉 `fires` 计数与 iteration 历史。否决。
- **把某段固定的无人值守提示词烤进工具当 preset**：把内容塞进机制，只有作者一人用且会腐坏。否决。（内容改由 `skills/pretty-task-unattended/SKILL.md` 承载：流程留在 skill，机制留在插件。）

## 相关

- 提示词的发送路径：[`src/ui/loop-wake.ts`](../../src/ui/loop-wake.ts)
- 运行时目录与文件名约定：[`src/tasks/base/runtime-state.ts`](../../src/tasks/base/runtime-state.ts)
- Iteration 历史上限：[ADR-0007](0007-iteration-history-cap-and-restart-repair.md)
- Loop 语义：[ADR-0001](0001-loop-wakes-llm-not-shell.md)、[ADR-0006](0006-cron-alongside-intervals.md)
