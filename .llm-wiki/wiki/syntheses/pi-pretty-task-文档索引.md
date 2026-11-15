---
type: synthesis
title: pi-pretty-task 文档索引
created: 2026-11-13
updated: 2026-11-14
---

# pi-pretty-task 文档索引

本页是 pi-pretty-task 全部设计文档的入口。仓库里的 markdown 是**事实来源**（随代码同版本演进），本页只负责指路与标注状态，不复制内容——复制出来的第二份必然漂移。

## 设计文档

| 文档 | 讲什么 | 状态 |
|---|---|---|
| [AGENTS.md](../../AGENTS.md) | 项目规则、产品模型、目录约定、验收标准 | 已定 |
| [GLOSSARY.md](../../GLOSSARY.md) | 术语：Task（两种 kind：process / loop）/ Iteration / Panel / Status line | 已定 |
| [scope-v1.md](../../docs/scope-v1.md) | v0.1 范围：做 / 不做 / 延后（含复杂度与风险） | 已定，随实现更新 |
| [configuration.md](../../docs/configuration.md) | 配置面：`PI_PRETTY_TASK_OUTPUT_CAP_BYTES`（默认 20 MiB，启动校验）与 `bg_run` 的 `timeoutSeconds`；两类终止原因 | 已定 |

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
| [0008 命令用哪个 shell、输出按什么编码读](../../docs/adr/0008-shell-choice-and-output-decoding.md) | 环境变量定默认 + `bg_run.shell` 覆盖；读取层 UTF-8 → Windows GB18030 回退 |
| [0009 唤醒等 agent 空闲，Iteration 绑定它唤醒的那一轮](../../docs/adr/0009-wakes-wait-for-idle-and-bind-their-turn.md) | 自建待发队列、只在空闲时投递；open 待定、投递后 bind；pump 单飞 |
| [0010 Task 的更新时间要落盘](../../docs/adr/0010-task-recency-is-persisted.md) | `updatedAt` 落盘、按它排序；由状态/触发推动，输出增长不算 |
| [0011 id 自带你是什么](../../docs/adr/0011-ids-carry-their-kind.md) | `bg-`/`lp-`/`lc-`/`ch-` 前缀，模型与人看 id 就知道种类 |
| [0012 面板三页、只列根、一条链一行](../../docs/adr/0012-panel-tabs-and-roots.md) | `1/2/3` 切页、只列根、链整条一行、触发与步骤不单独占行 |
| [0013 链是第四种 kind，持有一条队列](../../docs/adr/0013-chain-is-a-task-kind-holding-a-queue.md) | `kind: "chain"`、`steps` 存 id + 游标、一次一步、只排 process |
| [0014 子记录是记录，不是行](../../docs/adr/0014-children-are-records-not-rows.md) | 触发与步骤是普通 Task、不占列表行、可被 `bg_*` 直接查；计数含子记录；`k` 级联 |
| [0015 循环行内嵌触发的紧凑条带](../../docs/adr/0015-loop-row-carries-a-fire-strip.md) | 最近 3 次触发 `#43✓ #44✓ #45✗`、旧在左、窄了从左侧丢；回车展开全部 |
| [0016 子任务的 id 不携带父与序号](../../docs/adr/0016-child-ids-stay-opaque.md) | 触发与步骤都用 `bg-` + 随机；父与序号是字段；别名写 `name#seq (id)` |
| [0017 重叠跳过、失败退避，不排队](../../docs/adr/0017-overlap-skips-and-failures-back-off.md) | 重叠的触发记 `skipped` 不排队；失败翻倍封顶一小时、成功归位；两个计数落盘 |

## 工具链与代码风格

不写第二个格式化器：`.editorconfig` 定基础（UTF-8、LF、最终换行、2 空格；markdown 保留行尾空格），**Biome 同时承担格式化与 lint**，因此没有 Prettier/ESLint 双份配置需要同步。

| 文件 | 作用 |
|---|---|
| `.editorconfig` | 编辑器基础格式，任何编辑器都认 |
| `biome.json` | 格式化（双引号、分号、lineWidth 100、trailingCommas all）+ lint（`preset: "recommended"`，再收紧 `noExplicitAny`、`noUnusedVariables`、`noNonNullAssertion`） |
| `tsconfig.json` | 构建：ES2022 / NodeNext / strict / `noUncheckedIndexedAccess` / `verbatimModuleSyntax`，输出 `dist/` |
| `tsconfig.dev.json` | 类型检查：`noEmit`，同时覆盖 `src/` 与 `test/` |
| `package.json` | `pi.extensions: ["./dist/index.js"]`；scripts：`check` / `build` / `lint` / `lint:fix` / `format` / `test` |
| `.gitignore` | `node_modules/`、`dist/`、`.pi/`、`.tmp/`、`*.tsbuildinfo` 等 |

`dist/` 是构建产物，不入库；`*.tsbuildinfo` 同理。仓库目前还不是 git 仓库，`git init` 待用户许可。

## 外部参考

- [pi-background-tasks 源码调研](pi-background-tasks-源码调研.md) — 工具集、执行层、面板交互、已知硬伤
- [pi-loop 源码调研](./pi-loop-源码调研.md) — 调度器、触发系统、状态存储、为何 `/loop` 看不到命令

## 未决问题

- **Loop 首发是否支持 cron**：现按“只做间隔触发”暂定。若日常用法是“每天 9 点”，cron 必须进 v0.1，且要补一份 ADR 说明解析器与秒级边界。
- **`.pi/tasks/` 的 TTL 清理**：已延后，解锁条件是磁盘体量成为实际困扰。

## 维护约定

- 新增 ADR 时在本页表格追加一行；ADR 被推翻时状态改 `superseded by ADR-NNNN`，不要删行。
- 文档与代码冲突时，先判断哪边是对的，再改另一边，并在本页记一句；不允许两边各自演化。
