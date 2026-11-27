# 0025 — 阻塞式 `pretty_task_bg_run`：在工具调用里等这条任务

## 状态

已接受（2026-11-27）

## 背景

今天 `pretty_task_bg_run` 只做一件事：起进程、立刻回任务 id。要拿结果得再调一次 `pretty_task_bg_wait` 或 `pretty_task_bg_logs`。短任务（几分钟的构建、跑一次测试、一次 `git fetch`）里这一次往返正好落在最不该多的地方：agent 先 `bg_run` 再 `bg_wait`，第二个调用还得自己决定等多久，等短了白等，等长了占住一轮。

ADR-0020 解决的是另一件事：**已经在前台跑**的命令怎么放走。它给的答案是「改道那一刻才落记录」，因为改道之前 pi 的 shell 调用没有任务记录，进程句柄在 pi 手里。阻塞模式的前提正相反：命令从第一毫秒起就是本扩展 spawn 的进程任务，等待只是「发起它的那个调用还没返回」。

把两者当成一回事的代价是两套生命周期。`ForegroundRun` 已经自带 `runs` 表、`held` 计数、`detachOnlyOne` 与 shutdown 放出逻辑；再给阻塞模式复制一份，面板要问两次「有多少条在等」，快捷键要挑两个来源，关停要放走两种东西，而其中一种根本不是记录。共用等待接缝就够：`process-tasks.ts` 的 `session.waiters` 已经负责「任务结束时叫醒谁」。

## 决策

**`wait: true` 让这一次调用留在原地等，任务本身与不写 `wait` 时逐字相同。**

- **任务从第一毫秒成立**：`wait` 只决定调用何时返回，不改变 `start()` 做的任何事 —— 记录、`status: "running"`、输出文件、面板行、`maxRunningTasks` 计数、完成通知、`bg_logs` / `bg_kill` 的可用性。等待因此只是在 `session.waiters` 上多一个监听者：一个监听者，不是一套生命周期。
- **不复用 `ForegroundRun`**：那份代码的立足点是「进程在 pi 手里、记录后补」。阻塞模式下这个立足点不存在，共用它的表只会把两种句柄混进一个 `live()` 计数里。
- **参数是 `wait`，布尔**：`wait: true` 才等，缺省仍是今天的行为。秒数归 `timeoutSeconds`，不让一个参数兼两种含义；也不叫 `block` —— 状态词里 `blocked` 已经指「等不到能力」，`waiting` 已经指排队中的步骤。
- **不设等待上限**：等待只有三个出口 —— 任务结束、Esc、`timeoutSeconds` 到点把整棵树杀掉。`bg_wait` 的 `MAX_WAIT_SECONDS`（600 秒）是给「看别人的任务」用的；拿它剪阻塞调用，正好把促成 ADR-0020 的 8 分钟构建剪回「只给一个 id」。`tail -f` 这类永不结束的命令会一直占住这一轮：工具描述写明这一点，Esc 与快捷键就是出口。
- **一次回答，不流式**：等待期间不通过 `onUpdate` 推送部分输出，只在结束时给一份完整答案。面板从第一毫秒就在滚这条任务的输出，流式等于把同一份输出再抄一遍进对话，输出上限与解码也要跟着抄第二份；而 `test/support/extension-harness.ts` 的 `call()` 没有 `onUpdate` 接缝，流式会变成一条测不了的路。
- **结束时的答案**：任务块（与 `describeTask` 同形：id、状态、耗时、输出字节、退出码、kill reason、输出文件、命令）+ 输出尾部（最近 200 行，最多 16 KiB，被剪时注明还有多少在文件里，并给 `pretty_task_bg_logs` 的读法）。退出码由记录给，不从输出里猜。
- **Esc 只结束等待**：与 `bg_wait` 一致 —— Esc 释放这一轮，任务继续跑，进程不碰。把 Esc 解释成「杀掉」会让「我等烦了」变成「我毁掉了一个不能重跑的脚本」。
- **`timeoutSeconds` 仍杀整棵树**：到点照旧 `killReason: "timeout"`，这一轮随即拿到真实的结束记录（退出码 + kill reason），因为等待监听的是结束事件，而超时正是结束的一种。
- **`ctrl+shift+b` 在阻塞期间可用，且不再依赖 `PI_PRETTY_TASK_ADOPT_FOREGROUND`**：按键的第二个目标是「正在等的调用」。它此前只注册在改道开关里，是因为它只服务改道；现在它的两个目标里有一个与改道无关，注册必须挪到开关外。关闭覆盖的项目里，按键只对阻塞调用生效，改道那一路保持关闭。
- **多条在等时按键只提示、不挑**：沿 ADR-0020 的规则。前台命令与被阻塞的调用合起来数，恰好一条才动手；0 条说没有，2 条以上只给一条提示，说明这条键一次只放走一条 —— 挑哪一条是人的决定，`/tasks` 里可以逐条看。数的是一个并集，提示文案因此说「calls」而不说「commands」，`DetachResult` 的 `ambiguous` 也因此把 `running` 改名为 `waiting`。
- **被放走的回执落进 ADR-0020 的契约，不另开一条**：`DetachedResult` 原样复用，`trigger: "shortcut"`，`afterSeconds` 是这次调用等了多少秒；工具结果因此以 `detachedNotice()` 那一行为尾（一段已捕获输出 + `↪ moved to bg-xxx`，不给退出码，它还没退出），进程不重启、不换 PID、输出文件不换。`trigger` 不加第四项：阻塞调用不会由 `timeout`（那会杀树，不是放它走）也不会由 `shutdown` 触发，真正发生的只有「人按了键」。
- **用户看得见：按键画的还是那张 `task-detached` 卡**。前台改道由 runner 的 `onDetached` 落卡；阻塞调用没有 runner，所以由快捷键处理器在放走后自己 `appendEntry` 同一种卡（同一份 `trigger` / `afterSeconds`）。少这一步，按键就只在工具结果里留一行给模型看，用户那边毫无痕迹。
- **Esc 不是改道**：它没有 `trigger` 可填，也不该借用改道那句话（「用户把它挪到后台」在这件事上不成立）。被 Esc 结束等待时，工具结果是「仍在跑；这一轮不再等」加 `bg_logs` / `bg_kill` 的读法，不画卡。
- **组合矩阵**（每条都要能走到，没有走不到的格子）：
  - `after` + `wait`：拒绝，文案同时点名两个参数（排队的步骤要等前面的步骤结束才起跑，此刻没有可等的东西），并且不落记录。
  - `template` + `wait`：允许。模板只填 command / cwd / timeoutSeconds，与等待无关。
  - `shell` + `wait`：允许。shell 选择在 spawn 前定完，等待只看结束事件。
  - `timeoutSeconds` + `wait`：允许，语义是「到点杀树，然后如实返回」。
  - `wait: false`：与不写等价，返回任务 id。
  - `PI_PRETTY_TASK_FOREGROUND_TIMEOUT` + `wait`：互不相干。那个键属于改道，不作用于阻塞调用。
- **完成通知不因阻塞而静音**：结束的答案与完成通知在同一刻落地，用户会看到两次「结束了」。静音需要在 `finish` 与等待者之间排一个脆弱的先后，而多一条通知的代价小于某个顺序下通知丢失。
- **术语**：`GLOSSARY.md` 新增 `Blocked run`，与 `Foreground run` / `Detached` 并列。

## 代价

- 一条永不结束的命令能占住整轮，只能靠人按 Esc 或快捷键出来。`bg_wait` 至少有 600 秒上限，这里把上限换成了「人按不按」。
- 结束答案是双份记录：任务块 + 输出尾部，比「只给一个 id」大一个数量级；200 行 / 16 KiB 是唯一的约束。
- 等待期间 pi 的 TUI 没有这个工具的进度输出，实时视图只有面板。
- `ctrl+shift+b` 从「改道的键」变成「两个目标的键」：描述、README 与配置文档都要同时讲清两件事，否则用户会以为它只对前台命令有效。
- 阻塞调用与 ADR-0020 的改道共用同一个快捷键出口，按键的 bug 会同时影响两条路。
- 放走后的卡沿用改道的从句「被人挪到后台」，而阻塞调用本来就不在前台：这句话对它是近似而非字面。改文案要动 ADR-0020 的 `detachReason`，或者加第四个 trigger；两者都比一句近似的话贵，所以接受这个偏差。

## 相关

- 改道的原始决策与回执：[ADR-0020](0020-foreground-command-detaches-to-a-task.md)
- 术语：[`GLOSSARY.md`](../../GLOSSARY.md)（`Blocked run`、`Foreground run`、`Detached`、`Process task`）
- 配置、上限与快捷键：[`docs/configuration.md`](../configuration.md)
- shell 选择与输出解码：[ADR-0008](0008-shell-choice-and-output-decoding.md)
