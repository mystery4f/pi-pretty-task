# 0027 — `waitSeconds`：阻塞调用可以带一个自己的期限

## 状态

已接受（2026-11-28）

## 背景

[ADR-0025](0025-blocking-run-waits-inside-the-call.md) 让 `wait: true` 在工具调用里等任务结束，并写明「不设等待上限」：8 分钟的构建正是它要服务的对象，而 `bg_wait` 的 `MAX_WAIT_SECONDS`（600 秒）是给「看别人的任务」用的，拿它剪阻塞调用，正好把 8 分钟剪回「只给一个 id」。

那条论证只覆盖了「等多久才够」，没回答「等多久算够」的另一半：等待期间模型手里只有 Esc 和 `ctrl+shift+b`，两个都要人按键。`tail -f` 这类永不结束的命令能占住整轮直到有人按键；无人值守的会话里没人按键，那一轮就一直挂着。调用方没有办法说「我最多等 30 秒」，`pretty-task-unattended` 那类技能也就无法把「等一下，但要有限」写进流程，只能教模型别用 `wait`。

所以本文修订的是 0025 的一条，不是它的骨架：等待仍然只是 `session.waiters` 上多一个监听者，任务从第一毫秒成立，进程一秒都不碰。新增的是那条监听者可以带的一个期限。

## 决策

**`pretty_task_bg_run` 增加可选参数 `waitSeconds`：这一次调用最多等多少秒。缺省仍是无限。**

- **名字不是 `timeoutSeconds`**：这个名字在 `bg_run` 上已经等于「到点杀整棵树」（`killReason: "timeout"`），在 `bg_wait` / `bg_logs follow` 上才等于「这次调用等多久」。同一个名字在同一个工具里不能有两个含义，所以新参数跟 `wait: true` 共用一个词，自己说清限定的是哪件事。`bg_wait` 的 `timeoutSeconds` 不跟着改名：那是另一个工具里的单一含义，动它是范围扩张，本文不做。
- **缺省不设上限，不悄悄收窄**：不写 `waitSeconds` 时 `holdTurn` 收不到 `timeoutMs`，行为与 ADR-0025 逐字节相同。8 分钟的构建照旧能等到，`tail -f` 照旧靠 Esc 与快捷键出来。期限是调用方自愿加的边界，插件不替它决定。既有用例钉住这一点：不带 `waitSeconds` 的 `wait: true` 仍然等到任务结束才回答。
- **到点复用 `WaitStop` 已有的 `deadline`，不给 `trigger` 加第四项**：`holdTurn` 本来就带 `timeoutMs` 定时器（`bg_wait` 走的就是它），到点落在同一个 `settle("deadline")` 上，`bg_wait` 已经用 `waited: false` 表达同一个事实。不碰 `trigger` 的理由有三条：`trigger` 是改道词汇，回答「谁把它挪到了后台」，而到点什么都没挪——任务本来就在后台；第四个 `trigger` 会要求一张 `task-detached` 卡，那张卡说的是「你的命令被放走了」，到点没有这件事；`released` 的句子「the shortcut let this call go」若被借用，模型会以为有人按了键。到点与 Esc 同形：等待结束，任务继续，无卡、无 trigger。
- **三条回执、三句话，逐字不同**（`stop` 字段同时区分）：
  - Esc（`stop: "aborted"`）：`<id> (<name>) is still running; this call stopped waiting.`，后接 `Follow: pretty_task_bg_logs <id> · Stop: pretty_task_bg_kill <id>` 与已捕获的尾部；不画卡。
  - 到点（`stop: "deadline"`、`waited: false`）：`<id> (<name>) is still running; this call's waitSeconds deadline passed and the task was not touched.`，后接同一条 `Follow` / `Stop` 与尾部；不画卡。句子点名「期限是这次调用的」且「任务没被动过」，因为模型最可能把到点误读成 kill。
  - 快捷键（`stop: "released"`）：沿用 ADR-0020 的 `detachedNotice()`，以 `↪ moved to <id> — …` 开头、`trigger: "shortcut"`，并由快捷键处理器落那张 `task-detached` 卡。只有这一条含 `↪ moved to`。
  - 集成测试用三条 `not.toContain` 把「互不借用」钉死：到点那段文本不含 Esc 的从句、不含快捷键的从句、不含 `↪ moved to`。
- **`blockedCount()` 与快捷键的并集计数仍然成立**：阻塞表项在 `expose` 里、定时器之前登记，`awaitRun` 的 `finally` 在回答前删除。到点之后 `blockedCount()` 立即少一，`letOneGo` 读到的 `foreground.live() + blockedCount()` 仍是「此刻真在等」的数量，不多不少。按键与到点在同一 tick 竞争时，`release()` 只会有一边成功，另一边按既有规则答 `nothing`——不会画两张卡，也不会漏放一条。
- **上限复用 `MAX_WAIT_SECONDS`（600）**：`limits.ts` 的头注释已经把它定义成「一次等待最多占住这一轮多久」，`waitSeconds` 限的正是这件事，另设一个数字就是第二份策略。校验单开 `parseHoldSeconds`，不复用 `parseWaitSeconds`——后者缺省填 60 秒，而这里缺省必须是无上限。越界文案报自己的名字（`waitSeconds must be a positive number no larger than 600; received N`），和 `timeoutSeconds` 一样在任何进程起来之前拒绝，并附一句 `The task was not started.`
- **`waitSeconds` 不带 `wait: true` 直接拒**：没有 `wait` 就没有东西被占住，这个参数无事可做；静默忽略一个参数比拒绝更坏，因为调用方会以为边界生效了。拒绝文案点名两个参数，并指出任务自身的运行上限是 `timeoutSeconds`。`waitSeconds` + `after` 落进既有的 `wait` + `after` 拒绝，排在它后面。
- **`waitSeconds` 与 `timeoutSeconds` 可以同时给**：到点谁先到按谁算——`timeoutSeconds` 先到就杀树，这次等待随任务结束收到真实的结束记录（`stop: "ended"`、`waited: true`、kill reason `timeout`）；`waitSeconds` 先到就只结束等待（`stop: "deadline"`），任务继续跑。
- **实现只走既有的接缝**：`awaitRun` 多收一个 `timeoutMs` 选项并原样交给 `holdTurn`，不新造定时器、不再起一个监听者，`finally` 的释放顺序不动。进程、输出文件、面板行、`maxRunningTasks` 计数一秒都不碰。
- **工具描述与文档同批改**：`runDescription` 的预算内措辞点名第三条出口；`wait` 参数的描述指向 `waitSeconds`；README「Waiting inside the call」、`docs/configuration.md`、`GLOSSARY.md` 的 `Blocked run` 一起说清三条出口与 600 秒上限。

## 代价

- 多一个参数、一条拒绝分支，模型要多记一件事；工具描述与 README 各自多一句。
- 600 秒意味着超过 10 分钟的构建仍然只能靠 Esc、快捷键或分段 `bg_wait` 来看。这是有意的：一轮对话不能无限期被一条工具调用占住，而上限放宽到 `MAX_TIMEOUT_MS` 等于没有上限。
- 三条回执三句话，维护者要保证它们继续互不借用；集成测试里那三条 `not.toContain` 是这条约束的唯一守卫。

## 相关

- [ADR-0025](0025-blocking-run-waits-inside-the-call.md)：阻塞调用的骨架；「不设等待上限」一条由本文取代
- [ADR-0020](0020-foreground-command-detaches-to-a-task.md)：快捷键、改道回执与那张卡
- [ADR-0026](0026-a-detach-closes-the-door-for-a-minute.md)：改道后一分钟里的拒绝，`waitSeconds` 不改变它
- 术语：[`GLOSSARY.md`](../../GLOSSARY.md)（`Blocked run`）
- 配置与上限：[`docs/configuration.md`](../configuration.md)