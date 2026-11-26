---
type: synthesis
title: pi-pretty-task 文档索引
created: 2026-11-13
updated: 2026-11-21
---

# pi-pretty-task 文档索引

本页是 pi-pretty-task 全部设计文档的入口。仓库里的 markdown 是**事实来源**（随代码同版本演进），本页只负责指路与标注状态，不复制内容——复制出来的第二份必然漂移。

## 设计文档

| 文档 | 讲什么 | 状态 |
|---|---|---|
| [AGENTS.md](../../AGENTS.md) | 项目规则、产品模型、目录约定、验收标准 | 已定 |
| [GLOSSARY.md](../../GLOSSARY.md) | 术语：Task（四种 kind：process / prompt-loop / cmd-loop / chain）/ Iteration / Fire / Step / Panel | 已定 |
| [scope-v1.md](../../docs/scope-v1.md) | v0.1 范围：做 / 不做 / 延后（含复杂度与风险） | 已定，随实现更新 |
| [panel-narrow-detail.md](../../docs/panel-narrow-detail.md) | 窄 pane / 矮 pane 下的面板：高度预算、字段与窗口分账、宽度两档与长值折行、子行状态前置 | 已定，随实现更新 |
| [configuration.md](../../docs/configuration.md) | 配置面：`PI_PRETTY_TASK_OUTPUT_CAP_BYTES`（默认 20 MiB，启动校验）与 `pretty_task_bg_run` 的 `timeoutSeconds`；两类终止原因 | 已定 |
| [previews.md](../../docs/previews.md) | README 四张图怎么来：`scripts/preview/` 驱动真实面板抓帧、ANSI→HTML→截图→GIF，重跑与踩坑 | 已定，随面板更新 |

## 决策记录（ADR）

| ADR | 采纳的选项 |
|---|---|
| [0001 Loop 唤醒 LLM，不执行 shell](../../docs/adr/0001-loop-wakes-llm-not-shell.md) | Loop 是唤醒器，执行内容由 agent 决定 |
| [0002 Iteration 记录该轮全部工具调用](../../docs/adr/0002-iteration-records-all-tool-calls.md) | 全记，列表只突出命令类 |
| [0003 面板用状态栏 + 浮层](../../docs/adr/0003-panel-not-persistent-widget.md) | 不做常驻 widget |
| [0004 参考上游行为，重写代码结构](../../docs/adr/0004-reference-not-fork.md) | 不 fork，抄经验不抄类 |
| [0005 Task 是 process 与 loop 的上位概念](../../docs/adr/0005-task-is-the-supertype.md) | 一种 Task、多个 kind、一张面板表；Iteration、Fire、Step 都是子记录 |
| [0006 调度吃间隔简写与五段 cron](../../docs/adr/0006-cron-alongside-intervals.md) | 两种语法共用一个 `nextFire(after)`；六段拒绝 |
| [0007 Iteration 历史上限与重启修复](../../docs/adr/0007-iteration-history-cap-and-restart-repair.md) | 各留最近 N 条并计数；重启把未完成的标 interrupted |
| [0008 命令用哪个 shell、输出按什么编码读](../../docs/adr/0008-shell-choice-and-output-decoding.md) | 环境变量定默认 + `pretty_task_bg_run.shell` 覆盖；读取层 UTF-8 → Windows GB18030 回退 |
| [0009 唤醒等 agent 空闲，Iteration 绑定它唤醒的那一轮](../../docs/adr/0009-wakes-wait-for-idle-and-bind-their-turn.md) | 自建待发队列、只在空闲时投递；open 待定、投递后 bind；pump 单飞 |
| [0010 Task 的更新时间要落盘](../../docs/adr/0010-task-recency-is-persisted.md) | `updatedAt` 落盘、按它排序；由状态/触发推动，输出增长不算 |
| [0011 id 自带你是什么](../../docs/adr/0011-ids-carry-their-kind.md) | `bg-`/`lp-`/`lc-`/`ch-` 前缀，模型与人看 id 就知道种类 |
| [0012 面板三页、只列根、一条链一行](../../docs/adr/0012-panel-tabs-and-roots.md) | `1/2/3` 切页、只列根、链整条一行、触发与步骤不单独占行 |
| [0013 链是第四种 kind，持有一条队列](../../docs/adr/0013-chain-is-a-task-kind-holding-a-queue.md) | `kind: "chain"`、`steps` 存 id + 游标、一次一步、只排 process |
| [0014 子记录是记录，不是行](../../docs/adr/0014-children-are-records-not-rows.md) | 触发与步骤是普通 Task、不占列表行、可被 `bg_*` 直接查；计数含子记录；`k` 级联 |
| [0015 循环行内嵌触发的紧凑条带](../../docs/adr/0015-loop-row-carries-a-fire-strip.md) | 最近 3 次触发 `#43✓ #44✓ #45✗`、旧在左、窄了从左侧丢；回车展开全部 |
| [0016 子任务的 id 不携带父与序号](../../docs/adr/0016-child-ids-stay-opaque.md) | 触发与步骤都用 `bg-` + 随机；父与序号是字段；别名写 `name#seq (id)` |
| [0017 重叠跳过、失败退避，不排队](../../docs/adr/0017-overlap-skips-and-failures-back-off.md) | 重叠的触发记 `skipped` 不排队；失败翻倍封顶一小时、成功归位；两个计数落盘 |
| [0018 订阅型 cmd loop：第三种结局与最小触发间隔](../../docs/adr/0018-signal-outcome-and-minimum-fire-gap.md) | 退出码三分为 `signalled`（不退避、不动档期）+ `failed`（照旧退避）；`signalRaised` 闩做边沿去抖；`advanceSchedule` 设 30s 最小间隔，cron 与 resume 补发都受约束；不新开 kind |
| [0019 面板按 pane 的尺寸规划 body](../../docs/adr/0019-panel-plans-against-its-pane.md) | `panelHeightBudget` 复刻 pi overlay 的裁剪算式、每帧从 `tui.terminal.rows` 重算；`detailRows` 窗口优先、字段整块丢并提示；宽度两档、长值折行；子行状态前置；`listWindow` 让分页行也占预算 |
| [0020 前台命令改道成任务](../../docs/adr/0020-foreground-command-detaches-to-a-task.md) | 默认关闭；打开后用同名 `registerTool` 覆盖内置 `bash`（`powershell` 自 0022 起只注册、不改道）并接管 `!` 命令自己 spawn；快捷键 `ctrl+shift+b` 或 `PI_PRETTY_TASK_FOREGROUND_TIMEOUT` 到点即不再等待，进程不重启、落成 `origin: "foreground"` 的 Process task，计入任务上限；外来工具（MCP 等）明确不做 |
| [0021 通知用 steer，唤醒用 followUp](../../docs/adr/0021-task-notice-steers.md) | 实测 `bg-kqtt9` 的通知在「轮末投递」与「用户输入」之间被吞（同会话另外两条正常）；规则按「报告还是派活」分：`notifyTaskFinished` 与 `notifyLoopSignal` 都改 `deliverAs: "steer"`，只有携带 prompt 的 Loop 唤醒保持 `followUp` |
| [0022 默认用 bash，bash.exe 跟着用户的 git 找](../../docs/adr/0022-bash-by-default-and-where-git-lives.md) | 两平台默认都改为 bash；Windows 的 `bash.exe` 依次问 Git Bash 启动环境（`EXEPATH`/`$SHELL`）、`where git` 旁边的 `bin\bash.exe`、注册表 `InstallPath`、常规安装目录、PATH，只用 `bin\bash.exe`；找不到仍报错不兜底；`powershell` 工具改跑 pi 自带操作、不再借策略 shell |
| [0023 发布走 OIDC，不留长期 token](../../docs/adr/0023-publish-through-oidc-not-a-token.md) | v1.0.8 发布先 404 再 403（`bypass 2fa` 被拒）；npm 自 2026-08 收账户变更、2027-01 收直接 `publish` 的绕 2FA token，2026-09-03 后新建的 trusted publisher 默认只给 staged；改为 `id-token: write` + Node 24（npm ≥ 11.5.1）+ 去掉 `NODE_AUTH_TOKEN`，删仓库 secret，npm 侧按 repo/workflow 名配 trusted publisher 并勾选允许直接 publish |
| [0024 Loop 的提示词落盘，路径由 id 派生](../../docs/adr/0024-loop-prompt-lands-on-disk.md) | 提示词从记录里的冻结字符串改为 `.pi/tasks/<session>/<loop-id>.prompt.md`：地址只由 loop id 派生、任何工具都不收路径参数（AI 侧没有路径权力）、插件只在创建、显式改写与重建三处写、每发读一次、读失败重建后照常触发；记录上的 `prompt` 降为 seed 兼重建源 |

## 工具链与代码风格

不写第二个格式化器：`.editorconfig` 定基础（UTF-8、LF、最终换行、2 空格；markdown 保留行尾空格），**Biome 同时承担格式化与 lint**，因此没有 Prettier/ESLint 双份配置需要同步。

| 文件 | 作用 |
|---|---|
| `.editorconfig` | 编辑器基础格式，任何编辑器都认 |
| `biome.json` | 格式化（双引号、分号、lineWidth 100、trailingCommas all）+ lint（`preset: "recommended"`，再收紧 `noExplicitAny`、`noUnusedVariables`、`noNonNullAssertion`） |
| `tsconfig.json` | 构建：ES2022 / NodeNext / strict / `noUncheckedIndexedAccess` / `verbatimModuleSyntax`，输出 `dist/` |
| `tsconfig.dev.json` | 类型检查：`noEmit`，同时覆盖 `src/` 与 `test/` |
| `package.json` | `pi.extensions: ["./src/index.ts"]`（pi 自行转译，git 安装免构建）、`pi.skills: ["./skills"]`；`files` 必须同时含 `dist`/`src`/`skills`；scripts：`check` / `build` / `lint` / `lint:fix` / `format` / `test` / `prepack` / `verify` |
| `.gitignore` | `node_modules/`、`dist/`、`.pi/`、`.tmp/`、`*.tsbuildinfo` 等 |

`dist/` 是构建产物，不入库；`*.tsbuildinfo` 同理。发布到 npm 走 GitHub Release 事件触发 `.github/workflows/publish.yml`，细节见 [1.0.0 发布支持落地记录](release-1-0-0-publish-support.md)。

## 外部参考

- [pi-background-tasks 源码调研](pi-background-tasks-源码调研.md) — 工具集、执行层、面板交互、已知硬伤
- [pi-loop 源码调研](./pi-loop-源码调研.md) — 调度器、触发系统、状态存储、为何 `/loop` 看不到命令

## 评审报告

| 报告 | 讲什么 | 状态 |
|---|---|---|
| [architecture-review-2026-11-17.html](../../docs/reviews/architecture-review-2026-11-17.html) | 九张卡的架构评审：面板无接口、唤醒投递在组合根、记录渲染写两遍、format 是四个模块、并行索引、行投影抄三遍、启动台阶两遍、两个 store 各造 hub、id 解析七遍；含删除测试判决表 | 九张卡已全部落地（十一个提交）；评审后的收尾也在：`WakeDesk` 自带用例、`suspicious/noImportCycles` 管住环依赖，报告保留为决策依据 |

## 未决问题

- **Loop 首发是否支持 cron**：现按“只做间隔触发”暂定。若日常用法是“每天 9 点”，cron 必须进 v0.1，且要补一份 ADR 说明解析器与秒级边界。
- **`.pi/tasks/` 的 TTL 清理**：已延后，解锁条件是磁盘体量成为实际困扰。

## 维护约定

- 新增 ADR 时在本页表格追加一行；ADR 被推翻时状态改 `superseded by ADR-NNNN`，不要删行。
- 文档与代码冲突时，先判断哪边是对的，再改另一边，并在本页记一句；不允许两边各自演化。
