---
type: synthesis
title: pi-pretty-task 交接：v0.2 收尾状态
tags: handoff, pi-pretty-task
created: 2026-11-15
updated: 2026-11-21
---

# pi-pretty-task 交接：v0.2 收尾状态

交接页，取代 `.tmp/resume.txt`。下次开工先读这一页，再读 `AGENTS.md`、`GLOSSARY.md`、`docs/scope-v1.md`。

## 仓库与代码

- `D:/work/Code/AI/pi/pi-pretty-task`，`main` = `cb93417 docs(adr): record how the signal shows up and that both steps landed`，本地领先 `origin/main` 5 个提交（`cd40ee2` `9eecf53` `c5a7ebb` `ae363e2` `cb93417`），**未推送**：GitHub 连接被重置。工作树干净。
- 集成分支 `feat/v0.2-tasks` 已全部合并，`ticket/*` 分支与 `.tmp/wt/*` worktree 已清理，远端只有 `main`。
- 安装方式：`~/.pi/agent/settings.json` 第 159 行 `"git:github.com/mystery4f/pi-pretty-task"`；入口 `./src/index.ts`（pi 自己转译），所以**本机改完代码不必 build**，但 `dist/` 不再是安装物。
- 工具面：十个 `pretty_task_*`（含 `pretty_task_bg_wait`），无旧别名。
- 闸门：`npm run check` / `npm run lint` / `npm test`（448 测试）/ `npm run build` / `npm run verify`；CI `.github/workflows/verify.yml` 跑前三项。**集成测试在这台机器上现在不绿**：2026-11-21 实测 `vitest run test/integration` 在 `HEAD` 干净树上也有 29 个失败（`process-stop` 里「waits only as long as the store tells it to」断言 4195ms < 3000ms 直接超）。原因不在代码：是残留的测试子进程 + 慢盘，先清掉 `%TEMP%\pi-pretty-task-*` 下的孤儿 node（`Get-CimInstance Win32_Process` 里命令行含 `pi-pretty-task-` 的杀掉；`tasklist /FI` 在 git bash 里会被改成路径，用 PowerShell）再跑，仍会剩下时间敏感的假失败。判绿看单元工程与改到的集成文件（`cmd-loops` / `tasks-command` / `terminal-notification`）。

## 已上线能力

进程任务（run/status/logs/grep/follow/kill/wait/rerun、cwd/env、模板、完成通知、OSC 9 终端通知、输出与时长上限、通知与上限两条环境变量）、提示词 Loop（间隔 + 五段 cron、改期、暂停、跳过重叠、失败退避、失败唤醒、每次触发的迭代记录）、命令 Loop（每次触发是一条带 `parentId` 的进程任务；声明 `notifyExitCodes` 后按退出码报警，`signalled` 结局 + 边沿闩，不退避不改档期）、链（`after:` 串步骤、`/tasks` 里的 Chains 页）、保留期清理、事件总线、面板三页（`1/2/3`、`f` 过滤默认 running、`/` 模糊搜索、`h` 历史、`R` 重跑、`o` 其他会话只读）。

## 未完成

- **issue #31**（面板里创建任务）：主动推迟，唯一未关的票。
- 与 #31 同批推迟的想法：任务链的可视化编辑、`bg_status({templates:true})`（模板查看工具，方案已提未批）、「工具面统一成 `task_*` 再留 `bg_*` 别名的票」（#38 已按用户决定**不留别名**，此条作废）。
- **已知技术债**：`src/ui/tasks-panel.ts` 两千五百行，一个文件扛三页渲染、搜索、详情、键位、取色，四次合并冲突三次落在它身上 —— 拆分规则已写进 `~/.agents/skills/coding-standards`，但拆分本身未做。
- `docs/adr/0002` 等早期 ADR 与实现已有漂移，只有「每份 ADR 在索引里有行」的测试，没有内容一致性检查。

## 本会话新增的规则与技能

- `~/.agents/skills/coding-standards/SKILL.md`：一文件一职责、300/600/1000 行三档、按职责不按行数拆分、seam 与测试规则；已接进 `coder` / `reviewer` / `final-reviewer` 三个 agent 的 frontmatter。
- `~/.agents/skills/tucao/SKILL.md`：证据优先的复盘吐槽，每条必须能指到 commit / file:line / exit code。
- 全局 `AGENTS.md`：删远端分支改走 `gh api -X DELETE`（`git push --delete` 被安全网拦）；子代理规则补「上游截断要 resume 不重写」「1 小时墙钟、每绿即提交、闸门逐条看 exit code」。
- 用户把 `CTX_REPLACE_TRIGGER_BYTES` 写进了 `~/.pi/agent/.env`（context-mode 折叠阈值，默认 4096）。

## 下次开工第一件事

读本页 → ADR-0018 的两步与三项手动动作都已落（`9eecf53` 最小间隔、`ae363e2` 信号语义、`0c60e4c` 手动动作），本机集成测试的 29 个失败是机器慢 + 残留进程，不是回归；干净 `HEAD` 上同样 29 个。下一步是把两个 issue 推到 GitHub（用 `HTTPS_PROXY=http://mcr:4444`，本机直连不通）。

## 2026-11-21 订阅型 cmd loop 与两个 issue 稿

外部团队（另一台机器/另一项目，跑 1.0.4 `92ff4c9`）用 `cron "*/10 * * * *"` 的 cmd loop 做巡检，靠 `wakeOnFailure` + `exit 1` 当事件通道。他们报的四个问题全部对着源码核过并成立，结论已定进 ADR-0018：

- 报警即降速：`noteFailure` 把 `nextFireAt` 推到 `本次触发 + 间隔 × 2^min(streak,4)`（实测 `18:10:00 → 18:30:02.914`）。
- 离格后整点塌陷：`#57 05:40:38.492Z`（跑 1m32s）→ `#58 05:50:00.706Z`，只隔 9m22s；老例 17:29:55 与 17:30:00 隔 5 秒，前者未完 → 后者 `skipped`，那一轮报告丢失。
- resume 补发也离格：pump 停 2h20m（`#56 03:20:00.672Z` → `#57 05:40:38.492Z`），塌陷不需要先失败一次。

两步都已落：ADR-0018 定稿（`cd40ee2`）、最小间隔（`9eecf53`：`advanceSchedule` 走 `nextFireBeyondGap`，`Recurrence.periodMs` 让短间隔不被改频）、信号语义整批（`ae363e2`：`FireOutcome` 的 `"signalled"`、`notifyExitCodes` 校验 `1..255` 且拒 0 与空表、`signalRaised`/`signalRaisedAt` 闩、`loop-signal` 唤醒卡带前 10 行、面板徽标与 `signal` 过滤器与状态栏计数、`loop_list` 的 `signal on:` / `latch:`），文档收口（`cb93417`：ADR 后果段改成实际形状、`GLOSSARY.md` 加 Signal 与 Latch 两个词）。`pretty_task_loop_create` 描述同时补上「失败会移动下次触发、成功归位」；`docs/scope-v1.md` 的 event/idle 延后行指向 ADR-0018。
与 ADR 原文的一处偏离，已回改 ADR：行里的状态词不动（`running` 是记录的事实），改成旁边一个 `⚑ signal` 徽标；退避的事实仍由既有的 `Failures: N in a row` 承担，不另开 `backoff` 字段。
**手动动作三项已落**（`0c60e4c`；ADR-0018 的 `## 手动动作` 全部兑现）：`pretty_task_loop_update` 的 `action` 加了 `rearm`（不改表达式，只按 `recurrence.nextFire(now)` 重新对齐；暂停中的 loop 回 `already-paused`）与 `clear-signal`（只对已立闩的命令 loop 有意义，其余回 `no-signal`）；`retune` 与 `rearm` 都清 `signalRaised`。新工具 `pretty_task_loop_fire` 手动跑一发：记录从负数编号（`-1`、`-2`…，面板与工具输出印 `m1`、`m2`，渲染逻辑在 `src/tasks/base/format.ts` 的 `fireLabel`），不占 `fires` 序号、不动 `nextFireAt`、不动 `consecutiveFailures`、也不碰闩；`CmdLoopTask.manualFires` 保证编号不重复，`fireHistory` 里的负数条目被面板条带过滤掉、只在详情页历史里出现。prompt loop 与已结束的 loop 一律拒绝。测试：`test/unit/loop-tasks.test.ts` 三条（rearm 对齐 + 保留表达式与计数、clear-signal 与 `no-signal`、手动发不占槽不移动时钟且失败不记 streak），`test/integration/cmd-loops.test.ts` 一条（真进程手动发，`fires` 仍 0、`nextFireAt` 不变、历史为 `m1`），`test/unit/tool-names.test.ts` 的清单同步加了新工具名。

### 待开的两个 issue（GitHub 不通，写了正文等能推时再贴）

标题一：`fix(loop): keep the next fire at least 30s away so a cron loop cannot collapse`

正文要点：`advanceSchedule` 用 `recurrence.nextFire(实际触发时刻)`，离格触发（失败退避后、resume 补发后）到下一个整点可以任意近，两发起跑只隔几秒，前者仍在跑则后者记 `skipped`，那一轮观察丢失。实测序列见上（`#57→#58` 9m22s、17:29:55→17:30:00 5s、resume 2h20m 空档后立刻补发）。修法：取第一个距本次触发不早于 `MIN_FIRE_GAP_MS = 30_000` 的边界；间隔表达式用 `min(30_000, 表达式周期)`，免得把 `10s` 这类短间隔改成 30 秒；补发路径同时生效。附 `#39 00:30:00.648Z` 跑 19.1s 的先例说明重叠风险不是理论值。

标题二：`feat(loop): signalled outcome, notifyExitCodes and an edge latch for check loops`

正文要点：cmd loop 的失败语义吞掉了「状态为真」。要 `notifyExitCodes: number[]`（命中的退出码记 `signalled`：唤醒一次、不退避、不动 `nextFireAt`、不清 streak；未命中的非零码仍然退避，真实故障要降速）；不另存 `trigger`，模式由列表存在推出；`signalRaised` 闩做边沿去抖，落闩只有 `success` 与手动 `action=clear-signal` 两条路（跳过不落闩）；`wakeOnFailure` 只管失败，信号永远唤醒；信号走 loop 级卡片，带前 10 行 + 总数 + 输出路径；`FireOutcome` 加 `"signalled"`；`loop_list` 露出 `consecutiveFailures` 与离格信息；面板加状态词、条带第三格 `⚑`、`PANEL_FILTERS` 的 `"signal"`、状态栏 `· 1 signal`。顺带 `action=rearm` 与 `pretty_task_loop_fire`（手动一发不占 `fires` 序号、不推进档期，记录标 `manual`）。

### 已归档

两个 issue 已开并关闭，附了实测数据与落地提交：

- #41 `fix(loop): keep the next fire at least 30s away so a cron loop cannot collapse` —— `9eecf53` 已落。
- #42 `feat(loop): signalled outcome, notifyExitCodes and an edge latch for check loops` —— `ae363e2` + `0c60e4c` 已落。

GitHub 是通过 `HTTPS_PROXY=http://mcr:4444` 恢复的（早前 `gh` 与 `curl` 都返回连接重置 / 000）；`git push` 同代理成功，`main` 与 `origin/main` 已对齐。给外部团队的回复要点：两个号都是他们报的，代码在 main、随下个版本发布。

相关：[[syntheses/pi-pretty-task-文档索引]]
