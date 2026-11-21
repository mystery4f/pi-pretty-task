# 0018 — 订阅型 cmd loop：第三种结局与最小触发间隔

## 状态

已接受（2026-11-21）

## 背景

另一台机器上的团队用 `cron "*/10 * * * *"` 的 cmd loop 做巡检：脚本比对远端列表与本地快照，有变化就打印清单并 `exit 1`，没变化 `exit 0`，靠 `wakeOnFailure: true` 把 `exit 1` 变成一次唤醒。非零退出因此是他们唯一的事件通道，而 ADR-0017 只认两种结局：成功、失败。

三个实测现象（同一 loop 58 发、cron `*/10`）：

- **报警即降速**：`exit 1` 记 `failed`，`noteFailure` 把 `nextFireAt` 推到 `本次触发 + 间隔 × 2^min(streak,4)`（封顶一小时），实测 `18:10:00 → 18:30:02.914`。表达式仍写 `*/10`，真实节奏已与它无关。
- **离格后整点塌陷**：`advanceSchedule` 用 `recurrence.nextFire(实际触发时刻)` 取下一边界，离格时刻到整点可以任意近。`#57 05:40:38.492Z`（这一发跑了 1m32s）之后，`#58` 被算成 `05:50:00.706Z`，两发起跑只隔 9m22s；同 loop `#39 00:30:00.648Z` 有跑 19.1s 的先例。老化的一例是 17:29:55 与 17:30:00 相隔 5 秒，前一发还在跑，后一发记 `skipped`，那一轮报告因此没发出。
- **补发也离格**：pump 停 2h20m 后恢复（`#56 03:20:00.672Z` → `#57 05:40:38.492Z`），逾期即当刻触发，于是下一个整点只剩 9 分钟。塌陷不需要先失败一次，一次 resume 就够。

根因两条：把「状态为真」编码成了「任务坏了」；以及调度器的下一个时刻以实际触发时刻为基准，没有下限。

## 决策

**cmd loop 认第三种结局，并为下一次触发设最小间隔。它不是新的 kind。**

退出码三分，由 `notifyExitCodes?: number[]` 声明：

- 命中列表的退出码记 `FireOutcome: "signalled"`：唤醒一次，`consecutiveFailures` 不变、`nextFireAt` 不动、不退避。不清零 streak——信号不是健康运行，否则一个坏脚本只要偶尔 `exit 1` 就能把退避洗掉。
- 未命中的非零退出码仍是 `failed`：退避与唤醒照旧。真实故障必须降速，这条不因新结局放松。
- `0` 仍是 `success`：清零 `consecutiveFailures`，按档期推进。
- `wakeOnFailure` 只管失败：`signalled` 永远唤醒，即使它写着 `false`。静音一个使用者明确列出的退出码等于把工具变哑，两者同时出现不报错。

去抖用记录上的一个闩 `signalRaised?: boolean`：

- `signalled` 而闩未立 → 立闩、唤醒一次。
- 闩已立时再来 `signalled` → 只记这一发（面板与摘要标注 repeat），不唤醒。条件持续为真不刷屏。
- `success` → 落闩。下一次 `signalled` 才是新的边沿。
- 落闩只有两条路：`success`，或手动 `pretty_task_loop_update action="clear-signal"`。不给闩设过期时间——没人能给出那个时长的理由；也不在 `skipped` 上落闩，跳过意味着没有观测。

唤醒走 loop 级卡片，不复用子进程的完成卡：`signalled` 与故障在用户眼前必须是两件事，否则「不降速的失败」和「失败」看起来一样。卡片标题带 loop 名与 `#N`，正文带清单前 10 行、总数与输出路径；行数写死不做配置项——看护场景的清单通常短，超过 10 条时人本来就要去文件里看。
最小触发间隔 `MIN_FIRE_GAP_MS = 30_000`：`advanceSchedule` 取第一个距本次触发不早于该值的时间边界，cron 与补发路径因此生效。间隔表达式取 `min(30_000, 表达式周期)`——固定 30 秒会把 `10s` 这类短间隔直接改成 30 秒，那不是防塌陷，是改频率。这是下限，不是策略旋钮，不做成配置。

类型面（`src/tasks/base/task.ts`）：

- `CmdLoopTask` 加 `notifyExitCodes?: number[]`、`signalRaised?: boolean`。模式由列表的存在推出，不另存 `trigger`：`trigger: "signal"` 却没有列表、或有列表却写着 `trigger: "schedule"`，都是允许自相矛盾的状态，而列表本身已经说明一切。
- `FireOutcome` 加 `"signalled"`（`src/tasks/base/task.ts:114`）。
- `LoopBase` 一个字段不加：两种 loop 仍然共用同一个 pump。

## 为什么不新开一个 kind

调度器只驱动 `LoopBase`——`pumpOnce` 的第一道筛子就是 `record.kind !== "prompt-loop" && record.kind !== "cmd-loop"`。任何按钟点触发的记录都得落在 `LoopBase` 上，否则拿不到 pump，得自己复制一套调度、一轮 kill 路径与一份输出文件处理。巡检场景是 cron 驱动的，所以它先天属于 loop 家族的**类型**；再立一个 `SubscriptionTask` 接口，等于让它继承 `LoopBase` 之后再加一个只起标签作用的判别字段。fire 的行为也和 cmd loop 一致（按档期起一个孩子），ADR-0005 定的分类标准正是「一次 fire 做什么」。

反过来的界线写在这里：出现**不靠时钟也不靠退出码**的触发源（文件变化、webhook、idle）时，它没有 `nextFireAt`、没有 `fires`，也不该借 `LoopBase`——那时才需要自己的类型模型和自己的 ADR。这正是 scope 里「event / idle 触发」那条延后项的解锁条件，本 ADR 不预判它。

## Considered Options

- **新 kind `subscription`**：语义最干净，但 store、调度器、kill 路径、输出处理、面板行与一族工具都要共用或复制；删除测试反过来不过——删掉它，复杂度没消失，只是回到 `cmd-loop` 加三个字段。
- **粗粒度 `wakeOn: "nonzero-exit"`**：会把「脚本自己挂了」也算成正常报警。使用者要的正是把这两种分开（他们把 `exit 2` 留给脚本故障）。
- **重叠时排队而不是跳过**：ADR-0017 已否，理由（队列无上限、恢复瞬间涌出）不变。
- **只加最小间隔、不改结局**：治不了「报一次就降速」，退避仍在。
- **闩做成外部状态**（脚本自己存「报过了」）：正是使用者现在手搓的东西，把去抖留在工具外面，每个用例都要重写一遍。
- **脚本每行数据各算一次触发**：一次 fire 只有一个退出码，逐条判定无从谈起；输出文件本身已经是一条队列，逐行触发会让唤醒轮数随条目数增长，还要在插件里维护一个随业务增长、永不收缩的键集合。

## 后果

- 漂移消失：`signalled` 不移动 `nextFireAt`，档期只由 `success` 与退避两条路改写。重新对齐因此从「每次唤醒后必做的补丁」降级为便利动作。
- 跳过不再等于丢报告：状态型检查幂等，被跳过那一格只要闩没立，下一格仍会报。代价是「条件为真但恰好跨过一格」的观察空档——这是跳过策略固有的，属于 ADR-0017 的代价，不改。
- 面板要露出信号：行上一栏状态词（`signal: raised` / `clear`），条带第三种格子 `⚑`（ADR-0015 的 `#43✓ #44✗` 之外），`PANEL_FILTERS` 加 `"signal"`——闩立着的 loop 空闲着等下一发，落不进 `running` 也不落进 `failed`，默认视图会把它藏掉，而把 raised 算成 `running` 是撒谎；详情页只加配置与状态（`signal on: exit 1`、`latch: raised since …`、`backoff: N in a row`），历史仍归条带；状态栏那行在有闩立着时多一个 `· 1 signal`，否则看护的人不看面板就看不见。
- 最小间隔改变了 resume 后的第一发：补发照旧立刻发生，但紧随其后的整点会被推开到不少于 30 秒，短间隔表达式不受影响。
- 语义代价：`notifyExitCodes` 一旦声明，`exit 0` 就不再只是「没失败」，而是「条件已清除」——它落闩。用列表来表达这条因果，比再开一个 `resetSignalOnSuccess` 之类的开关更诚实。
- 落地分两步：最小间隔先落（只动 `advanceSchedule` 加测试，零 API 变化，能立刻止住丢报告），信号语义随后；面板与 `loop_list` 的字段跟第二步一起走，否则半个结局没人看得见。

## 手动动作

- **run-now**：`pretty_task_loop_fire` 按需跑一发，写成普通 fire 记录并标 `manual`。不推进 `nextFireAt`、不占 `fires` 序号、不动 `consecutiveFailures`——手动跑一次常常就是为了试错，试错不该罚这条 loop；失败原因仍落在那一发的记录与输出文件里。手动发不进面板条带：条带的 `#43✓` 只画到点的发，序号来自 `fires`（ADR-0015），硬塞进去会留空洞；它只出现在详情页的历史里，标 `manual`。
- **rearm**：`pretty_task_loop_update` 加 `action="rearm"` 与 `action="clear-signal"`，与本 ADR 同批实现。`rearm` 与「只改档期」共用一条实现（`recurrence.nextFire(now)`），差别只是不换表达式——对面是读源码才发现这件事的，说明这个动作早该有名字。
- **重设档期与闩**：`retune`、`rearm` 都清掉 `signalRaised`。人主动改写节奏就是宣布重新观察，闩留着会让「刚对齐就再也不报」；清掉的代价只是已报过的条件可能再报一次，而那正是人自己能判断的事。
