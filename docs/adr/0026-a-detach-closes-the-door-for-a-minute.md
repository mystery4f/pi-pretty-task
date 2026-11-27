# 改道之后的短窗口里，拒绝再起前台命令与 `wait: true`

## 状态

已接受（2026-11-28）

## 背景

改道（ADR-0020）把一个正在前台跑的命令交给后台，可它只解决了那一条命令。模型紧接着完全可能再起一条长命令——前台命令，或者 `wait: true` 的阻塞调用——把刚腾出来的前台又占住，用户就得再按一次 `ctrl+shift+b`。所以提醒必须落在模型真正读得到的地方。

这条仓库里模型能读到的通道只有三条：

- **卡片**：`pi.appendEntry`（`src/index.ts:404-412`），是会话条目，存得住、重载还在，但**模型读不到**——那行代码自己的注释也这么说。
- **回执**：`detachedNotice`（`src/tasks/process/foreground.ts:97`），写在工具结果里，改道当次就进模型上下文；阻塞调用被放走那条在 `src/tasks/process/tools.ts:698-712`。它是同一轮的回答，不多花一次模型调用。
- **通知**：`sendNotice`（`src/index.ts:213-229`）走 `pi.sendMessage({...}, { deliverAs: "steer", triggerTurn: true })`，会**直接开一轮**，因此每次提醒都要付一次模型调用，而且与回执重复。

## 决策

- 提醒用「拒绝」承载：改道之后 60 秒内，再起前台命令（`ForegroundRunner.operations().exec`）或 `wait: true` 调用（`pretty_task_bg_run`）直接被拒，**拒绝文案本身就是那句提醒**，并报出还剩多少秒。模型在下一次动作的裁决点上读到它，那是它唯一一定读、也一定在思考下一步的地方。
- 回执末尾也加一句同义的提醒（`detachedNotice` 的最后一句话），因为改道当次模型读的就是这条回执——它先把边界说清楚，拒绝只兜住忘记的那次。
- 不用 `sendNotice` 开轮承载这条规则：一次模型调用换一句重复的话，且会在用户没要求时插入一轮。
- 不用卡片承载规则：模型读不到（`appendEntry` 的事实）。卡片继续只做给人看的那一页，一个字节不动。
- 窗口取 60 秒（`DETACH_QUIET_MS`）。模型的下一步在秒级，60 秒足够覆盖整轮；窗口自己由注入的时钟判定，测试可以把钟往前拨。代价写在这里：这 60 秒里连 `ls` 这种短命令也会被拒，拒绝文案要说明还剩多久；要立刻在前台跑东西，等这一分钟，或者用 `pretty_task_bg_run`。
- 窗口状态只存内存，不落盘：它约束的是「这一轮别再来」，重启或换会话之后模型已经不是同一个上下文，旧窗口没有意义。
- 任务记录补 `detached: { trigger, heldSeconds }`（写在 `origin: "foreground"` 的记录上）。事实基础：本机 `.pi/tasks/*/tasks.json` 里 14 条 `origin: "foreground"` 的记录只有 `origin`，既看不出是谁放的（`ctrl+shift+b`、`PI_PRETTY_TASK_FOREGROUND_TIMEOUT` 还是关会话），也看不出它在前台占了多久，其中 3 条 `killed` 无从解释。字段可选，旧记录照旧可读。

## 代价

- 误伤：窗口里一条无害的短命令也会被拒，代价是一分钟或一次 `pretty_task_bg_run`。
- 窗口不可配：没有新配置项，想改就得改常量——这是故意的，规则要能被一句话说清。
- 跨会话不记忆：同一台机器上另一个会话不受影响，因为「别再起」只对刚看到回执的那个模型有意义。

## 相关

- [ADR-0020](0020-foreground-command-detaches-to-a-task.md)：改道本身，以及「快捷键只认唯一一条」。
- [ADR-0025](0025-blocking-run-waits-inside-the-call.md)：`wait: true` 的阻塞调用，它也是这条窗口拒的对象之一。
