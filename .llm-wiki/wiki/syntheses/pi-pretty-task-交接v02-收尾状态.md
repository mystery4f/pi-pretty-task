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

- `D:/work/Code/AI/pi/pi-pretty-task`，`main` = `84cf029 fix(pkg): point pi at src/index.ts so a git install needs no build`，已推送，工作树仅剩 wiki 元数据改动（`.llm-wiki/meta/*.json|l`）。
- 集成分支 `feat/v0.2-tasks` 已全部合并，`ticket/*` 分支与 `.tmp/wt/*` worktree 已清理，远端只有 `main`。
- 安装方式：`~/.pi/agent/settings.json` 第 159 行 `"git:github.com/mystery4f/pi-pretty-task"`；入口 `./src/index.ts`（pi 自己转译），所以**本机改完代码不必 build**，但 `dist/` 不再是安装物。
- 工具面：十个 `pretty_task_*`（含 `pretty_task_bg_wait`），无旧别名。
- 闸门：`npm run check` / `npm run lint` / `npm test`（427 测试，约 46s）/ `npm run build` / `npm run verify`；CI `.github/workflows/verify.yml` 跑前三项。

## 已上线能力

进程任务（run/status/logs/grep/follow/kill/wait/rerun、cwd/env、模板、完成通知、OSC 9 终端通知、输出与时长上限、通知与上限两条环境变量）、提示词 Loop（间隔 + 五段 cron、改期、暂停、跳过重叠、失败退避、失败唤醒、每次触发的迭代记录）、命令 Loop（每次触发是一条带 `parentId` 的进程任务）、链（`after:` 串步骤、`/tasks` 里的 Chains 页）、保留期清理、事件总线、面板三页（`1/2/3`、`f` 过滤默认 running、`/` 模糊搜索、`h` 历史、`R` 重跑、`o` 其他会话只读）。

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

读本页 → 动手第二步：`FireOutcome` 加 `signalled`、`CmdLoopTask` 加 `notifyExitCodes` / `signalRaised`、loop 级唤醒卡、面板四处（ADR-0018 已定稿）。最小间隔已落 `9eecf53`，闸门 `check`/`lint`/`test` 全绿。

## 2026-11-21 订阅型 cmd loop 与两个 issue 稿

外部团队（另一台机器/另一项目，跑 1.0.4 `92ff4c9`）用 `cron "*/10 * * * *"` 的 cmd loop 做巡检，靠 `wakeOnFailure` + `exit 1` 当事件通道。他们报的四个问题全部对着源码核过并成立，结论已定进 ADR-0018：

- 报警即降速：`noteFailure` 把 `nextFireAt` 推到 `本次触发 + 间隔 × 2^min(streak,4)`（实测 `18:10:00 → 18:30:02.914`）。
- 离格后整点塌陷：`#57 05:40:38.492Z`（跑 1m32s）→ `#58 05:50:00.706Z`，只隔 9m22s；老例 17:29:55 与 17:30:00 隔 5 秒，前者未完 → 后者 `skipped`，那一轮报告丢失。
- resume 补发也离格：pump 停 2h20m（`#56 03:20:00.672Z` → `#57 05:40:38.492Z`），塌陷不需要先失败一次。

本轮落了两步：ADR-0018 定稿（`cd40ee2`）与最小间隔（`9eecf53`，`advanceSchedule` 走 `nextFireBeyondGap`，`Recurrence.periodMs` 让短间隔不被改频）；`pretty_task_loop_create` 描述补上「失败会移动下次触发、成功归位」；`docs/scope-v1.md` 的 event/idle 延后行指向 ADR-0018。信号语义（`notifyExitCodes`、`signalRaised`、`signalled` 结局、面板四处）尚未动，ADR 里已定稿，`未决` 已清空。

### 待开的两个 issue（GitHub 不通，写了正文等能推时再贴）

标题一：`fix(loop): keep the next fire at least 30s away so a cron loop cannot collapse`

正文要点：`advanceSchedule` 用 `recurrence.nextFire(实际触发时刻)`，离格触发（失败退避后、resume 补发后）到下一个整点可以任意近，两发起跑只隔几秒，前者仍在跑则后者记 `skipped`，那一轮观察丢失。实测序列见上（`#57→#58` 9m22s、17:29:55→17:30:00 5s、resume 2h20m 空档后立刻补发）。修法：取第一个距本次触发不早于 `MIN_FIRE_GAP_MS = 30_000` 的边界；间隔表达式用 `min(30_000, 表达式周期)`，免得把 `10s` 这类短间隔改成 30 秒；补发路径同时生效。附 `#39 00:30:00.648Z` 跑 19.1s 的先例说明重叠风险不是理论值。

标题二：`feat(loop): signalled outcome, notifyExitCodes and an edge latch for check loops`

正文要点：cmd loop 的失败语义吞掉了「状态为真」。要 `notifyExitCodes: number[]`（命中的退出码记 `signalled`：唤醒一次、不退避、不动 `nextFireAt`、不清 streak；未命中的非零码仍然退避，真实故障要降速）；不另存 `trigger`，模式由列表存在推出；`signalRaised` 闩做边沿去抖，落闩只有 `success` 与手动 `action=clear-signal` 两条路（跳过不落闩）；`wakeOnFailure` 只管失败，信号永远唤醒；信号走 loop 级卡片，带前 10 行 + 总数 + 输出路径；`FireOutcome` 加 `"signalled"`；`loop_list` 露出 `consecutiveFailures` 与离格信息；面板加状态词、条带第三格 `⚑`、`PANEL_FILTERS` 的 `"signal"`、状态栏 `· 1 signal`。顺带 `action=rearm` 与 `pretty_task_loop_fire`（手动一发不占 `fires` 序号、不推进档期，记录标 `manual`）。

### 阻塞

`gh` 与 `curl -x http://mcr:4444 https://api.github.com` 全部连接被重置（curl 返回 000），两个 issue 与给对面回号都卡在这。

相关：[[syntheses/pi-pretty-task-文档索引]]
